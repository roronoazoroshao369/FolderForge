import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { FleetInstance } from './fleet-manager.js';
import type { FleetProfileTuple } from '../operator/trusted-host-scope.js';

type Phase = 'PREPARED' | 'COMMITTED';
type FaultPhase = 'prepared' | 'yaml-renamed' | 'state-renamed' | 'committed';

interface ProfileJournal {
  schemaVersion: 1;
  phase: Phase;
  instanceId: string;
  yamlPath: string;
  beforeYaml: string;
  afterYaml: string;
  beforeState: string;
  afterState: string;
  checksums: [string, string, string, string];
  approvedDigest: string;
}

interface FleetState {
  schemaVersion: 1;
  instances: FleetInstance[];
}

function sha(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function syncDir(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function safeRead(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error('UNTRUSTED_FLEET_PROFILE_FILE');
    }
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

function durableWrite(path: string, content: string): void {
  const dir = dirname(path);
  // Existing symlinks must not be followed or considered a valid file.
  if (existsSync(path)) safeRead(path);
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDir(dir);
  renameSync(temp, path);
  syncDir(dir);
}

function updateYaml(oldYaml: string, tuple: FleetProfileTuple): string {
  // Preserve static API keys, OAuth settings and tunnel secrets byte-for-byte.
  const policy = /^ {2}defaultMode: (?:"[^"\n]*"|[^\n]*)$/gm;
  const terminal = /^ {4}requireInDanger: (?:true|false)$/gm;
  if ([...oldYaml.matchAll(policy)].length !== 1 || [...oldYaml.matchAll(terminal)].length !== 1 ||
      !oldYaml.includes('# Fleet-managed terminal execution profile')) {
    throw new Error('UNMANAGED_FLEET_YAML');
  }
  return oldYaml.replace(policy, `  defaultMode: ${JSON.stringify(tuple.policyMode)}`)
    .replace(terminal, `    requireInDanger: ${tuple.terminalExecution === 'trusted-host' ? 'false' : 'true'}`);
}

/**
 * Two-file profile writes are never filesystem-atomic. The PREPARED journal
 * rolls back, COMMITTED journal rolls forward; no Fleet start may occur
 * until recovery has completed. This utility is fail-closed on ambiguity.
 */
export class FleetProfileTransaction {
  private readonly folder: string;
  private readonly stateFile: string;
  private readonly journalFile: string;
  private readonly lockFile: string;
  private readonly authorize: (instanceId: string, tuple: FleetProfileTuple, digest: string) => void;
  private readonly onPhase: ((name: FaultPhase) => void) | undefined;

  constructor(options: {
    root: string;
    authorize: (instanceId: string, tuple: FleetProfileTuple, digest: string) => void;
    onPhase?: (name: FaultPhase) => void;
  }) {
    this.folder = resolve(options.root, '.folderforge');
    this.stateFile = join(this.folder, 'fleet.json');
    this.journalFile = join(this.folder, 'fleet-profile.journal');
    this.lockFile = join(this.folder, 'fleet-profile.lock');
    this.authorize = options.authorize;
    this.onPhase = options.onPhase;
  }

  /** Recover a lock only if the sole recorded OS process no longer exists.
   * A distinct O_EXCL recovery guard fences competing rescuers. An ambiguous
   * PID, ownership, inode or guard state fails closed; never steal a live lock.
   */
  private reclaimDeadOwnerLock(): void {
    const guard = `${this.lockFile}.reclaim`;
    let recoveryFd: number;
    try {
      recoveryFd = openSync(guard, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch { throw new Error('FLEET_PROFILE_BUSY'); }
    try {
      let before;
      try { before = lstatSync(this.lockFile); } catch { return; }
      if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 ||
          (typeof process.getuid === 'function' && before.uid !== process.getuid())) {
        throw new Error('LOCK_RECOVERY_REQUIRED');
      }
      const pid = Number(safeRead(this.lockFile).trim());
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('LOCK_RECOVERY_REQUIRED');
      let dead = false;
      try { process.kill(pid, 0); } catch (error) {
        dead = (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
      if (!dead) throw new Error('FLEET_PROFILE_BUSY');
      const after = lstatSync(this.lockFile);
      if (before.ino !== after.ino || before.dev !== after.dev) throw new Error('LOCK_RECOVERY_REQUIRED');
      const stale = `${this.lockFile}.abandoned.${randomUUID()}`;
      renameSync(this.lockFile, stale);
      syncDir(this.folder);
      unlinkSync(stale);
      syncDir(this.folder);
    } finally {
      closeSync(recoveryFd);
      unlinkSync(guard);
      syncDir(this.folder);
    }
  }

  private withLock<T>(fn: () => T): T {
    mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    let fd: number;
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    try {
      fd = openSync(this.lockFile, flags, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('FLEET_PROFILE_BUSY');
      this.reclaimDeadOwnerLock();
      try { fd = openSync(this.lockFile, flags, 0o600); }
      catch { throw new Error('FLEET_PROFILE_BUSY'); }
    }
    try {
      writeSync(fd, String(process.pid));
      fsyncSync(fd);
      syncDir(this.folder);
      return fn();
    } finally {
      closeSync(fd);
      unlinkSync(this.lockFile);
      syncDir(this.folder);
    }
  }

  private parseJournal(): ProfileJournal {
    let j: ProfileJournal;
    try {
      j = JSON.parse(safeRead(this.journalFile)) as ProfileJournal;
      if (j.schemaVersion !== 1 || !['PREPARED', 'COMMITTED'].includes(j.phase) ||
          !/^flt_[a-f0-9]{8}$/.test(j.instanceId) ||
          j.yamlPath !== join(this.folder, 'fleet', `${j.instanceId}.yaml`) ||
          !Array.isArray(j.checksums) || j.checksums.length !== 4 ||
          [j.beforeYaml, j.afterYaml, j.beforeState, j.afterState].some((v, i) => sha(v) !== j.checksums[i])) {
        throw new Error('BAD_JOURNAL');
      }
      const before = JSON.parse(j.beforeState) as FleetState;
      const after = JSON.parse(j.afterState) as FleetState;
      if (before.schemaVersion !== 1 || after.schemaVersion !== 1 ||
          !before.instances.some((r) => r.id === j.instanceId) ||
          !after.instances.some((r) => r.id === j.instanceId)) throw new Error('BAD_JOURNAL_STATE');
    } catch {
      throw new Error('RECOVERY_REQUIRED');
    }
    return j;
  }

  private recoverLocked(): void {
    if (!existsSync(this.journalFile)) return;
    const j = this.parseJournal();
    const currentYaml = safeRead(j.yamlPath);
    const currentState = safeRead(this.stateFile);
    if (![sha(j.beforeYaml), sha(j.afterYaml)].includes(sha(currentYaml)) ||
        ![sha(j.beforeState), sha(j.afterState)].includes(sha(currentState))) {
      throw new Error('RECOVERY_REQUIRED');
    }
    const targetYaml = j.phase === 'COMMITTED' ? j.afterYaml : j.beforeYaml;
    const targetState = j.phase === 'COMMITTED' ? j.afterState : j.beforeState;
    if (currentYaml !== targetYaml) durableWrite(j.yamlPath, targetYaml);
    if (currentState !== targetState) durableWrite(this.stateFile, targetState);
    if (safeRead(j.yamlPath) !== targetYaml || safeRead(this.stateFile) !== targetState) {
      throw new Error('RECOVERY_REQUIRED');
    }
    unlinkSync(this.journalFile);
    syncDir(this.folder);
  }

  recoverBeforeReadOrStart(): void {
    if (!existsSync(this.journalFile)) return;
    this.withLock(() => this.recoverLocked());
  }

  commit(instanceId: string, tuple: FleetProfileTuple, approvedDigest: string): FleetInstance {
    return this.withLock(() => {
      this.recoverLocked();
      // Authorization must be verified under the write lock, not before.
      this.authorize(instanceId, tuple, approvedDigest);
      if (!/^flt_[a-f0-9]{8}$/.test(instanceId)) throw new Error('INVALID_FLEET_ID');
      if (!['sandbox-required', 'trusted-host'].includes(tuple.terminalExecution)) throw new Error('INVALID_FLEET_PROFILE');
      const yamlPath = join(this.folder, 'fleet', `${instanceId}.yaml`);
      const beforeYaml = safeRead(yamlPath);
      const beforeState = safeRead(this.stateFile);
      const state = JSON.parse(beforeState) as FleetState;
      if (state.schemaVersion !== 1 || !Array.isArray(state.instances)) throw new Error('INVALID_FLEET_STATE');
      const record = state.instances.find((r) => r.id === instanceId);
      if (!record) throw new Error('UNKNOWN_FLEET_INSTANCE');
      if (tuple.terminalExecution === 'trusted-host' && record.authMode === 'none') {
        throw new Error('TRUSTED_HOST_AUTH_REQUIRED');
      }
      const updated: FleetInstance = { ...record, ...tuple, updatedAt: new Date().toISOString() };
      const changed: FleetState = {
        schemaVersion: 1,
        instances: state.instances.map((r) => r.id === instanceId ? updated : r),
      };
      const afterState = JSON.stringify(changed, null, 2);
      const afterYaml = updateYaml(beforeYaml, tuple);
      const journal: ProfileJournal = {
        schemaVersion: 1, phase: 'PREPARED', instanceId, yamlPath,
        beforeYaml, afterYaml, beforeState, afterState,
        checksums: [sha(beforeYaml), sha(afterYaml), sha(beforeState), sha(afterState)],
        approvedDigest,
      };
      durableWrite(this.journalFile, JSON.stringify(journal));
      this.onPhase?.('prepared');
      durableWrite(yamlPath, afterYaml);
      this.onPhase?.('yaml-renamed');
      durableWrite(this.stateFile, afterState);
      this.onPhase?.('state-renamed');
      durableWrite(this.journalFile, JSON.stringify({ ...journal, phase: 'COMMITTED' }));
      this.onPhase?.('committed');
      if (safeRead(yamlPath) !== afterYaml || safeRead(this.stateFile) !== afterState) {
        throw new Error('RECOVERY_REQUIRED');
      }
      unlinkSync(this.journalFile);
      syncDir(this.folder);
      return updated;
    });
  }
}
