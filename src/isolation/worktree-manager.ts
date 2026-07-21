import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export type IsolationState = 'active' | 'applying' | 'applied' | 'rolled_back' | 'discarded';

export interface AppliedUntrackedFile {
  path: string;
  sha256: string;
}

export interface WorktreeIsolation {
  id: string;
  taskId: string;
  sourceRoot: string;
  worktreeRoot: string;
  branch: string;
  baseCommit: string;
  sourceHead: string;
  sourceFingerprint: string;
  sourceDirty: boolean;
  createdAt: string;
  state: IsolationState;
  appliedAt?: string;
  appliedSourceFingerprint?: string;
  appliedTracked?: string[];
  appliedUntracked?: AppliedUntrackedFile[];
  rollbackPatchSha256?: string;
  rolledBackAt?: string;
  discardedAt?: string;
}

export interface WorktreeStatus {
  isolation: WorktreeIsolation;
  clean: boolean;
  changed: string[];
  untracked: string[];
  conflicts: string[];
}

interface PersistedState {
  version: 1;
  isolations: WorktreeIsolation[];
  digest: string;
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_UNTRACKED_FILES = 100;
const MAX_UNTRACKED_BYTES = 10 * 1024 * 1024;

function git(cwd: string, args: string[], input?: string): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || `git exited ${result.status}`).trim();
    throw new Error(`Git command failed (${args.join(' ')}): ${message}`);
  }
  return result.stdout;
}

function canonicalRoot(path: string): string {
  return resolve(path);
}

function cloneIsolation(value: WorktreeIsolation): WorktreeIsolation {
  return structuredClone(value);
}

function splitNul(value: string): string[] {
  return value.split('\0').filter(Boolean);
}

function isolationDigest(isolations: WorktreeIsolation[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(isolations)).digest('hex')}`;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function samePaths(left: string[], right: string[]): boolean {
  return [...left].sort().join('\0') === [...right].sort().join('\0');
}

function sourceSnapshot(root: string): {
  head: string;
  status: string;
  fingerprint: string;
  dirty: boolean;
} {
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const digest = createHash('sha256').update(head).update('\0').update(status);
  if (status.length > 0) {
    digest.update('\0tracked\0').update(
      git(root, ['diff', '--binary', '--full-index', 'HEAD', '--']),
    );
    const untracked = splitNul(git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
    for (const path of untracked.sort()) {
      const target = resolve(root, assertRelativePath(path));
      digest.update('\0untracked\0').update(path).update('\0');
      if (!existsSync(target)) {
        digest.update('missing');
        continue;
      }
      const stats = lstatSync(target);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        digest.update(`unsafe:${stats.mode}:${stats.size}`);
        continue;
      }
      digest.update(readFileSync(target));
    }
  }
  return {
    head,
    status,
    fingerprint: digest.digest('hex'),
    dirty: status.length > 0,
  };
}

function assertRelativePath(value: string): string {
  if (!value || isAbsolute(value)) throw new Error(`Unsafe worktree path: ${value}`);
  const normalized = value.split('/').join(sep);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error(`Worktree path escapes its root: ${value}`);
  }
  return normalized;
}

export class WorktreeManager {
  private readonly isolations = new Map<string, WorktreeIsolation>();
  private readonly statePath: string;
  private readonly worktreesRoot: string;
  private readonly rollbacksRoot: string;
  private readonly projectRoot: string;
  readonly available: boolean;
  readonly unavailableReason?: string;

  constructor(private readonly allowedDirectories: string[], projectRoot: string) {
    this.projectRoot = canonicalRoot(projectRoot);
    this.assertAllowed(this.projectRoot);
    let topLevel: string;
    let commonDir: string;
    try {
      topLevel = canonicalRoot(git(this.projectRoot, ['rev-parse', '--show-toplevel']).trim());
      const commonDirRaw = git(this.projectRoot, ['rev-parse', '--git-common-dir']).trim();
      commonDir = canonicalRoot(
        isAbsolute(commonDirRaw) ? commonDirRaw : resolve(this.projectRoot, commonDirRaw),
      );
    } catch (error) {
      this.available = false;
      this.unavailableReason = error instanceof Error ? error.message : String(error);
      this.statePath = resolve(this.projectRoot, '.folderforge', 'isolations-unavailable.json');
      this.worktreesRoot = resolve(this.projectRoot, '.folderforge', 'worktrees');
      this.rollbacksRoot = resolve(this.projectRoot, '.folderforge', 'rollbacks');
      return;
    }
    if (topLevel !== this.projectRoot) {
      this.available = false;
      this.unavailableReason = `Worktree isolation requires the activated workspace to be a Git repository root (repo root: ${topLevel}).`;
      this.statePath = resolve(this.projectRoot, '.folderforge', 'isolations-unavailable.json');
      this.worktreesRoot = resolve(this.projectRoot, '.folderforge', 'worktrees');
      this.rollbacksRoot = resolve(this.projectRoot, '.folderforge', 'rollbacks');
      return;
    }
    this.statePath = resolve(commonDir, 'folderforge', 'isolations.json');
    this.worktreesRoot = resolve(commonDir, 'folderforge', 'worktrees');
    this.rollbacksRoot = resolve(commonDir, 'folderforge', 'rollbacks');
    this.assertInsideProject(this.statePath);
    this.assertInsideProject(this.worktreesRoot);
    this.assertInsideProject(this.rollbacksRoot);
    this.available = true;
    this.load();
  }

  create(taskId: string, baseRef = 'HEAD'): WorktreeIsolation {
    this.requireAvailable();
    if (!TASK_ID.test(taskId)) {
      throw new Error('taskId must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}.');
    }
    if ([...this.isolations.values()].some((item) => item.taskId === taskId && item.state !== 'discarded')) {
      throw new Error(`An active isolation already exists for taskId=${taskId}.`);
    }
    const snapshot = sourceSnapshot(this.projectRoot);
    const baseCommit = git(this.projectRoot, ['rev-parse', '--verify', `${baseRef}^{commit}`]).trim();
    const id = `iso_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const suffix = id.slice(-8);
    const branch = `folderforge/task/${taskId}-${suffix}`;
    const worktreeRoot = resolve(this.worktreesRoot, id);
    this.assertInsideProject(worktreeRoot);
    mkdirSync(dirname(worktreeRoot), { recursive: true, mode: 0o700 });
    git(this.projectRoot, ['worktree', 'add', '-b', branch, worktreeRoot, baseCommit]);

    const isolation: WorktreeIsolation = {
      id,
      taskId,
      sourceRoot: this.projectRoot,
      worktreeRoot,
      branch,
      baseCommit,
      sourceHead: snapshot.head,
      sourceFingerprint: snapshot.fingerprint,
      sourceDirty: snapshot.dirty,
      createdAt: new Date().toISOString(),
      state: 'active',
    };
    this.isolations.set(id, isolation);
    this.persist();
    return cloneIsolation(isolation);
  }

  list(): WorktreeIsolation[] {
    return [...this.isolations.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(cloneIsolation);
  }

  get(id: string): WorktreeIsolation | undefined {
    const value = this.isolations.get(id);
    return value ? cloneIsolation(value) : undefined;
  }

  isManagedRoot(root: string): boolean {
    const target = canonicalRoot(root);
    return [...this.isolations.values()].some(
      (item) => item.state !== 'discarded' && canonicalRoot(item.worktreeRoot) === target,
    );
  }

  managedRootForPath(path: string): string | undefined {
    const target = canonicalRoot(path);
    return [...this.isolations.values()]
      .filter((item) => item.state !== 'discarded')
      .map((item) => canonicalRoot(item.worktreeRoot))
      .sort((left, right) => right.length - left.length)
      .find((root) => target === root || target.startsWith(`${root}${sep}`));
  }

  status(id: string): WorktreeStatus {
    const isolation = this.requireExisting(id);
    this.assertWorktreePresent(isolation);
    const changed = splitNul(
      git(isolation.worktreeRoot, [
        'diff',
        '--name-only',
        '-z',
        isolation.baseCommit,
        '--',
      ]),
    );
    const untracked = splitNul(
      git(isolation.worktreeRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
    );
    const conflicts = splitNul(
      git(isolation.worktreeRoot, ['diff', '--name-only', '--diff-filter=U', '-z']),
    );
    return {
      isolation: cloneIsolation(isolation),
      clean: changed.length === 0 && untracked.length === 0 && conflicts.length === 0,
      changed,
      untracked,
      conflicts,
    };
  }

  diff(id: string): { isolation: WorktreeIsolation; diff: string; untracked: string[] } {
    const status = this.status(id);
    const patch = git(status.isolation.worktreeRoot, [
      'diff',
      '--binary',
      '--full-index',
      status.isolation.baseCommit,
      '--',
    ]);
    return { isolation: status.isolation, diff: patch, untracked: status.untracked };
  }

  apply(id: string): WorktreeStatus {
    const isolation = this.requireState(id, 'active');
    if (isolation.sourceDirty) {
      throw new Error('Cannot apply isolation onto a source workspace that was dirty at creation.');
    }
    const current = sourceSnapshot(isolation.sourceRoot);
    if (current.fingerprint !== isolation.sourceFingerprint) {
      throw new Error('Source workspace changed after isolation creation; refusing to overwrite user work.');
    }
    const status = this.status(id);
    if (status.conflicts.length > 0) {
      throw new Error(`Isolation contains unresolved conflicts: ${status.conflicts.join(', ')}`);
    }
    this.preflightTracked(isolation, status.changed);
    const patch = git(isolation.worktreeRoot, [
      'diff',
      '--binary',
      '--full-index',
      isolation.baseCommit,
      '--',
    ]);
    const untracked = this.preflightUntracked(isolation, status.untracked);
    if (patch) git(isolation.sourceRoot, ['apply', '--check', '--binary', '-'], patch);

    const patchPath = this.rollbackPatchPath(isolation.id);
    mkdirSync(dirname(patchPath), { recursive: true, mode: 0o700 });
    const patchTemp = `${patchPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(patchTemp, patch, { mode: 0o600 });
    renameSync(patchTemp, patchPath);
    isolation.state = 'applying';
    isolation.appliedTracked = [...status.changed];
    isolation.appliedUntracked = untracked.map((entry) => ({
      path: relative(isolation.sourceRoot, entry.target).split(sep).join('/'),
      sha256: sha256(readFileSync(entry.source)),
    }));
    isolation.rollbackPatchSha256 = sha256(patch);
    delete isolation.appliedAt;
    delete isolation.appliedSourceFingerprint;
    delete isolation.rolledBackAt;
    this.persist();

    const copied: string[] = [];
    let patchApplied = false;
    try {
      if (patch) {
        git(isolation.sourceRoot, ['apply', '--binary', '-'], patch);
        patchApplied = true;
      }
      for (const entry of untracked) {
        mkdirSync(dirname(entry.target), { recursive: true });
        copyFileSync(entry.source, entry.target);
        copied.push(entry.target);
      }
      isolation.state = 'applied';
      isolation.appliedAt = new Date().toISOString();
      isolation.appliedSourceFingerprint = sourceSnapshot(isolation.sourceRoot).fingerprint;
      this.persist();
      return this.statusSource(isolation);
    } catch (error) {
      let rollbackError: unknown;
      try {
        for (const target of copied.reverse()) rmSync(target, { force: true });
        if (patchApplied) git(isolation.sourceRoot, ['apply', '--reverse', '--binary', '-'], patch);
        isolation.state = 'active';
        delete isolation.appliedTracked;
        delete isolation.appliedUntracked;
        delete isolation.rollbackPatchSha256;
        rmSync(patchPath, { force: true });
        this.persist();
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure;
        this.persist();
      }
      if (rollbackError) {
        throw new Error(
          `Apply failed and automatic rollback also failed: ${error instanceof Error ? error.message : String(error)}; rollback=${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
      throw error;
    }
  }

  rollback(id: string): WorktreeStatus {
    const isolation = this.requireExisting(id);
    if (isolation.state !== 'applied' && isolation.state !== 'applying') {
      throw new Error(`Isolation rollback requires applied or applying state; current=${isolation.state}.`);
    }
    const patchPath = this.rollbackPatchPath(isolation.id);
    if (!existsSync(patchPath)) throw new Error('Isolation rollback patch is missing.');
    const patch = readFileSync(patchPath, 'utf8');
    if (sha256(patch) !== isolation.rollbackPatchSha256) {
      throw new Error('Isolation rollback patch integrity check failed.');
    }
    const current = sourceSnapshot(isolation.sourceRoot);
    if (current.fingerprint === isolation.sourceFingerprint) {
      isolation.state = 'rolled_back';
      isolation.rolledBackAt = new Date().toISOString();
      delete isolation.appliedSourceFingerprint;
      this.persist();
      return this.statusSource(isolation);
    }
    if (isolation.state === 'applied' && current.fingerprint !== isolation.appliedSourceFingerprint) {
      throw new Error('Source workspace changed after isolation apply; refusing rollback over user work.');
    }
    const expectedTracked = isolation.appliedTracked ?? [];
    const expectedUntracked = isolation.appliedUntracked ?? [];
    const actualTracked = splitNul(
      git(isolation.sourceRoot, ['diff', '--name-only', '-z', isolation.sourceHead, '--']),
    );
    const actualUntracked = splitNul(
      git(isolation.sourceRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
    );
    if (!samePaths(actualTracked, expectedTracked) || !samePaths(actualUntracked, expectedUntracked.map((item) => item.path))) {
      throw new Error('Source workspace does not exactly match the recorded applied change set.');
    }
    for (const entry of expectedUntracked) {
      const target = resolve(isolation.sourceRoot, assertRelativePath(entry.path));
      this.assertInside(target, isolation.sourceRoot);
      if (!existsSync(target) || !lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) {
        throw new Error(`Applied untracked file is missing or unsafe: ${entry.path}`);
      }
      if (sha256(readFileSync(target)) !== entry.sha256) {
        throw new Error(`Applied untracked file changed after apply: ${entry.path}`);
      }
    }
    if (patch) git(isolation.sourceRoot, ['apply', '--reverse', '--check', '--binary', '-'], patch);

    const removed: AppliedUntrackedFile[] = [];
    try {
      for (const entry of expectedUntracked) {
        const target = resolve(isolation.sourceRoot, assertRelativePath(entry.path));
        rmSync(target);
        removed.push(entry);
      }
      if (patch) git(isolation.sourceRoot, ['apply', '--reverse', '--binary', '-'], patch);
    } catch (error) {
      for (const entry of removed) {
        const source = resolve(isolation.worktreeRoot, assertRelativePath(entry.path));
        const target = resolve(isolation.sourceRoot, assertRelativePath(entry.path));
        if (existsSync(source) && sha256(readFileSync(source)) === entry.sha256) {
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(source, target);
        }
      }
      throw error;
    }
    isolation.state = 'rolled_back';
    isolation.rolledBackAt = new Date().toISOString();
    delete isolation.appliedSourceFingerprint;
    this.persist();
    return this.statusSource(isolation);
  }

  discard(id: string): WorktreeIsolation {
    const isolation = this.isolations.get(id);
    if (!isolation) throw new Error(`Isolation not found: ${id}`);
    if (isolation.state === 'discarded') return cloneIsolation(isolation);
    if (isolation.state === 'applied' || isolation.state === 'applying') {
      throw new Error('Rollback applied isolation changes before discarding the recovery worktree.');
    }
    if (existsSync(isolation.worktreeRoot)) {
      git(isolation.sourceRoot, ['worktree', 'remove', '--force', isolation.worktreeRoot]);
    } else {
      git(isolation.sourceRoot, ['worktree', 'prune']);
    }
    const branchExists = spawnSync(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/heads/${isolation.branch}`],
      { cwd: isolation.sourceRoot, windowsHide: true },
    ).status === 0;
    if (branchExists) git(isolation.sourceRoot, ['branch', '-D', isolation.branch]);
    rmSync(this.rollbackPatchPath(isolation.id), { force: true });
    isolation.state = 'discarded';
    isolation.discardedAt = new Date().toISOString();
    this.persist();
    return cloneIsolation(isolation);
  }

  private statusSource(isolation: WorktreeIsolation): WorktreeStatus {
    const changed = splitNul(
      git(isolation.sourceRoot, ['diff', '--name-only', '-z', isolation.sourceHead, '--']),
    );
    const untracked = splitNul(
      git(isolation.sourceRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
    );
    return {
      isolation: cloneIsolation(isolation),
      clean: changed.length === 0 && untracked.length === 0,
      changed,
      untracked,
      conflicts: [],
    };
  }

  private preflightTracked(isolation: WorktreeIsolation, paths: string[]): void {
    for (const path of paths) {
      const rel = assertRelativePath(path);
      const source = resolve(isolation.worktreeRoot, rel);
      this.assertInside(source, isolation.worktreeRoot);
      if (!existsSync(source)) continue; // deletion
      const stats = lstatSync(source);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`Tracked task output must be a regular file or deletion: ${path}`);
      }
    }
  }

  private preflightUntracked(
    isolation: WorktreeIsolation,
    paths: string[],
  ): Array<{ source: string; target: string }> {
    if (paths.length > MAX_UNTRACKED_FILES) {
      throw new Error(`Isolation has ${paths.length} untracked files; limit is ${MAX_UNTRACKED_FILES}.`);
    }
    let totalBytes = 0;
    return paths.map((path) => {
      const rel = assertRelativePath(path);
      const source = resolve(isolation.worktreeRoot, rel);
      const target = resolve(isolation.sourceRoot, rel);
      this.assertInside(source, isolation.worktreeRoot);
      this.assertInside(target, isolation.sourceRoot);
      const stats = lstatSync(source);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`Untracked entry must be a regular file: ${path}`);
      }
      totalBytes += statSync(source).size;
      if (totalBytes > MAX_UNTRACKED_BYTES) {
        throw new Error(`Untracked file payload exceeds ${MAX_UNTRACKED_BYTES} bytes.`);
      }
      if (existsSync(target)) throw new Error(`Untracked target already exists in source: ${path}`);
      return { source, target };
    });
  }

  private rollbackPatchPath(id: string): string {
    const path = resolve(this.rollbacksRoot, `${id}.patch`);
    this.assertInsideProject(path);
    return path;
  }

  describe(): { available: boolean; reason?: string; total: number; active: number } {
    return {
      available: this.available,
      ...(this.unavailableReason ? { reason: this.unavailableReason } : {}),
      total: this.isolations.size,
      active: [...this.isolations.values()].filter((item) => item.state !== 'discarded').length,
    };
  }

  private requireAvailable(): void {
    if (!this.available) {
      throw new Error(this.unavailableReason ?? 'Worktree isolation is unavailable.');
    }
  }

  private requireExisting(id: string): WorktreeIsolation {
    this.requireAvailable();
    const isolation = this.isolations.get(id);
    if (!isolation) throw new Error(`Isolation not found: ${id}`);
    if (isolation.state === 'discarded') throw new Error(`Isolation has been discarded: ${id}`);
    return isolation;
  }

  private requireState(id: string, state: IsolationState): WorktreeIsolation {
    const isolation = this.requireExisting(id);
    if (isolation.state !== state) {
      throw new Error(`Isolation ${id} requires state=${state}; current=${isolation.state}.`);
    }
    return isolation;
  }

  private assertWorktreePresent(isolation: WorktreeIsolation): void {
    if (!existsSync(isolation.worktreeRoot)) {
      throw new Error(`Managed worktree is missing: ${isolation.worktreeRoot}`);
    }
    const top = canonicalRoot(
      git(isolation.worktreeRoot, ['rev-parse', '--show-toplevel']).trim(),
    );
    if (top !== canonicalRoot(isolation.worktreeRoot)) {
      throw new Error('Managed worktree identity mismatch.');
    }
  }

  private assertAllowed(path: string): void {
    const target = canonicalRoot(path);
    const allowed = this.allowedDirectories.some((directory) => {
      const root = canonicalRoot(directory);
      return target === root || target.startsWith(`${root}${sep}`);
    });
    if (!allowed) throw new Error(`Isolation path is outside allowed directories: ${path}`);
  }

  private assertInsideProject(path: string): void {
    this.assertInside(path, this.projectRoot);
  }

  private assertInside(path: string, root: string): void {
    const rel = relative(canonicalRoot(root), canonicalRoot(path));
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Isolation path escapes managed root: ${path}`);
    }
  }

  private validatePersistedIsolation(value: unknown): WorktreeIsolation {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Isolation state contains an invalid entry.');
    }
    const isolation = value as WorktreeIsolation;
    if (!/^iso_[a-f0-9]{20}$/.test(isolation.id)) throw new Error('Isolation id is invalid.');
    if (!TASK_ID.test(isolation.taskId)) throw new Error('Isolation taskId is invalid.');
    if (canonicalRoot(isolation.sourceRoot) !== this.projectRoot) {
      throw new Error('Isolation state belongs to a different source repository.');
    }
    const expectedRoot = canonicalRoot(resolve(this.worktreesRoot, isolation.id));
    if (canonicalRoot(isolation.worktreeRoot) !== expectedRoot) {
      throw new Error('Isolation worktree path does not match its identity.');
    }
    this.assertInsideProject(isolation.worktreeRoot);
    const suffix = isolation.id.slice(-8);
    if (isolation.branch !== `folderforge/task/${isolation.taskId}-${suffix}`) {
      throw new Error('Isolation branch does not match its identity.');
    }
    if (!/^[a-f0-9]{40,64}$/.test(isolation.baseCommit) || !/^[a-f0-9]{40,64}$/.test(isolation.sourceHead)) {
      throw new Error('Isolation commit identity is invalid.');
    }
    if (!/^[a-f0-9]{64}$/.test(isolation.sourceFingerprint)) {
      throw new Error('Isolation source fingerprint is invalid.');
    }
    if (typeof isolation.sourceDirty !== 'boolean' || !validTimestamp(isolation.createdAt)) {
      throw new Error('Isolation source state or creation timestamp is invalid.');
    }
    if (!['active', 'applying', 'applied', 'rolled_back', 'discarded'].includes(isolation.state)) {
      throw new Error('Isolation lifecycle state is invalid.');
    }
    if (isolation.appliedAt !== undefined && !validTimestamp(isolation.appliedAt)) {
      throw new Error('Isolation applied timestamp is invalid.');
    }
    if (isolation.rolledBackAt !== undefined && !validTimestamp(isolation.rolledBackAt)) {
      throw new Error('Isolation rolled-back timestamp is invalid.');
    }
    if (isolation.appliedSourceFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(isolation.appliedSourceFingerprint)) {
      throw new Error('Isolation applied source fingerprint is invalid.');
    }
    if (isolation.appliedTracked !== undefined && (!Array.isArray(isolation.appliedTracked) || isolation.appliedTracked.some((path) => typeof path !== 'string'))) {
      throw new Error('Isolation applied tracked paths are invalid.');
    }
    if (isolation.appliedUntracked !== undefined && (!Array.isArray(isolation.appliedUntracked) || isolation.appliedUntracked.some((entry) => !entry || typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)))) {
      throw new Error('Isolation applied untracked journal is invalid.');
    }
    if (isolation.rollbackPatchSha256 !== undefined && !/^[a-f0-9]{64}$/.test(isolation.rollbackPatchSha256)) {
      throw new Error('Isolation rollback patch digest is invalid.');
    }
    if (isolation.discardedAt !== undefined && !validTimestamp(isolation.discardedAt)) {
      throw new Error('Isolation discarded timestamp is invalid.');
    }
    if (isolation.state === 'applied' && (!isolation.appliedAt || !isolation.appliedSourceFingerprint)) {
      throw new Error('Applied isolation is missing apply evidence.');
    }
    if (['applying', 'applied', 'rolled_back'].includes(isolation.state) && (!isolation.appliedTracked || !isolation.appliedUntracked || !isolation.rollbackPatchSha256)) {
      throw new Error('Isolation recovery journal is incomplete.');
    }
    if (isolation.state === 'rolled_back' && !isolation.rolledBackAt) {
      throw new Error('Rolled-back isolation is missing rolledBackAt.');
    }
    if (isolation.state === 'discarded' && !isolation.discardedAt) {
      throw new Error('Discarded isolation is missing discardedAt.');
    }
    return isolation;
  }

  private load(): void {
    if (!existsSync(this.statePath)) return;
    const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as PersistedState;
    if (parsed.version !== 1 || !Array.isArray(parsed.isolations) || typeof parsed.digest !== 'string') {
      throw new Error('Unsupported or invalid isolation state file.');
    }
    if (parsed.digest !== isolationDigest(parsed.isolations)) {
      throw new Error('Isolation state integrity check failed.');
    }
    const seen = new Set<string>();
    for (const value of parsed.isolations) {
      const isolation = this.validatePersistedIsolation(value);
      if (seen.has(isolation.id)) throw new Error(`Duplicate isolation id: ${isolation.id}`);
      seen.add(isolation.id);
      this.isolations.set(isolation.id, isolation);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temp = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    const isolations = this.list();
    const state: PersistedState = {
      version: 1,
      isolations,
      digest: isolationDigest(isolations),
    };
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.statePath);
  }
}
