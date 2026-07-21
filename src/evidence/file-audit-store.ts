import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { AuditEvent } from '../audit/event-types.js';
import {
  createAuditEnvelope,
  parseAuditChain,
  type AuditSigner,
} from './audit-chain.js';
import type {
  AuditAppendOptions,
  AuditEnvelopeV2,
  AuditStore,
  AuditVerificationReport,
} from './ports.js';

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;

export interface AuditFileSystem {
  appendFileSync: typeof appendFileSync;
  chmodSync: typeof chmodSync;
  closeSync: typeof closeSync;
  existsSync: typeof existsSync;
  fsyncSync: typeof fsyncSync;
  mkdirSync: typeof mkdirSync;
  openSync: typeof openSync;
  readFileSync: typeof readFileSync;
  statSync: typeof statSync;
  unlinkSync: typeof unlinkSync;
  writeFileSync: typeof writeFileSync;
  writeSync: typeof writeSync;
}

const NODE_FILE_SYSTEM: AuditFileSystem = {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
};

export interface FileAuditStoreOptions {
  fileSystem?: Partial<AuditFileSystem>;
  signer?: AuditSigner;
  now?: () => number;
  lockTimeoutMs?: number;
}

export class FileAuditStore implements AuditStore {
  readonly filePath: string;
  private readonly lockPath: string;
  private readonly fs: AuditFileSystem;
  private readonly signer: AuditSigner | undefined;
  private readonly now: () => number;
  private readonly lockTimeoutMs: number;

  constructor(projectRoot: string, options: FileAuditStoreOptions = {}) {
    this.filePath = join(projectRoot, '.folderforge', 'audit', 'audit.v2.jsonl');
    this.lockPath = join(projectRoot, '.folderforge', 'audit', 'audit.v2.lock');
    this.fs = { ...NODE_FILE_SYSTEM, ...options.fileSystem };
    this.signer = options.signer;
    this.now = options.now ?? Date.now;
    this.lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  }

  preflight(required: boolean): void {
    let fd: number | undefined;
    try {
      this.ensureDirectory();
      fd = this.fs.openSync(this.filePath, 'a', 0o600);
      this.fs.fsyncSync(fd);
      this.ensurePrivateFile(this.filePath);
    } finally {
      if (fd !== undefined) this.fs.closeSync(fd);
    }
    if (!this.fs.existsSync(this.filePath)) return;
    const report = this.verify();
    if (!report.ok) {
      const first = report.issues.find((issue) => issue.code !== 'unknown_signer');
      throw new Error(
        first
          ? `Audit chain integrity failed at line ${first.line}: ${first.message}`
          : 'Audit chain integrity failed.',
      );
    }
    if (required && report.unverifiedSignatures > 0) {
      // Hash-chain durability does not require signatures. Unknown signing keys are
      // reported to verifiers but do not make an otherwise valid local chain unusable.
    }
  }

  append(event: AuditEvent, options: AuditAppendOptions): AuditEnvelopeV2 {
    const release = this.acquireLock();
    try {
      const raw = this.readRaw();
      const parsed = parseAuditChain(raw);
      if (!parsed.report.ok) {
        const issue = parsed.report.issues.find((item) => item.code !== 'unknown_signer');
        throw new Error(
          issue
            ? `Audit chain integrity failed at line ${issue.line}: ${issue.message}`
            : 'Audit chain integrity failed.',
        );
      }
      const previous = parsed.envelopes.at(-1);
      const envelope = createAuditEnvelope(
        event,
        (previous?.sequence ?? 0) + 1,
        previous?.recordHash ?? null,
        { kind: 'native-v2' },
        this.signer,
      );
      const line = Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8');
      if (options.required) this.writeRequired(line);
      else {
        this.fs.appendFileSync(this.filePath, line, { mode: 0o600 });
        this.ensurePrivateFile(this.filePath);
      }
      return envelope;
    } finally {
      release();
    }
  }

  verify(): AuditVerificationReport {
    return parseAuditChain(this.readRaw()).report;
  }

  readRaw(): string {
    if (!this.fs.existsSync(this.filePath)) return '';
    return this.fs.readFileSync(this.filePath, 'utf8');
  }

  private writeRequired(line: Buffer): void {
    let fd: number | undefined;
    try {
      fd = this.fs.openSync(this.filePath, 'a', 0o600);
      let offset = 0;
      while (offset < line.length) {
        const written = this.fs.writeSync(fd, line, offset, line.length - offset);
        if (written <= 0) throw new Error('Audit write made no forward progress.');
        offset += written;
      }
      this.fs.fsyncSync(fd);
      this.ensurePrivateFile(this.filePath);
    } finally {
      if (fd !== undefined) this.fs.closeSync(fd);
    }
  }

  private acquireLock(): () => void {
    this.ensureDirectory();
    const deadline = this.now() + this.lockTimeoutMs;
    while (true) {
      let fd: number | undefined;
      try {
        fd = this.fs.openSync(this.lockPath, 'wx', 0o600);
        this.fs.writeFileSync(
          fd,
          `${JSON.stringify({ pid: process.pid, createdAt: new Date(this.now()).toISOString() })}\n`,
          { encoding: 'utf8' },
        );
        this.fs.fsyncSync(fd);
        this.fs.closeSync(fd);
        fd = undefined;
        this.ensurePrivateFile(this.lockPath);
        return () => {
          try {
            this.fs.unlinkSync(this.lockPath);
          } catch (error) {
            if (!isErrno(error, 'ENOENT')) throw error;
          }
        };
      } catch (error) {
        if (fd !== undefined) {
          try {
            this.fs.closeSync(fd);
          } catch {
            // Preserve the original lock acquisition failure.
          }
        }
        if (!isErrno(error, 'EEXIST')) throw error;
        if (this.reclaimStaleLock()) continue;
        if (this.now() >= deadline) {
          throw new Error(`Timed out waiting for audit writer lock: ${this.lockPath}`);
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }
  }

  private reclaimStaleLock(): boolean {
    try {
      const age = this.now() - this.fs.statSync(this.lockPath).mtimeMs;
      if (age < LOCK_STALE_MS) return false;
      let pid: number | undefined;
      try {
        const parsed = JSON.parse(this.fs.readFileSync(this.lockPath, 'utf8')) as {
          pid?: unknown;
        };
        if (Number.isSafeInteger(parsed.pid) && Number(parsed.pid) > 0) {
          pid = Number(parsed.pid);
        }
      } catch {
        // A stale unreadable lock is reclaimable after the full stale interval.
      }
      if (pid !== undefined && processIsAlive(pid)) return false;
      this.fs.unlinkSync(this.lockPath);
      return true;
    } catch (error) {
      return isErrno(error, 'ENOENT');
    }
  }

  private ensureDirectory(): void {
    this.fs.mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      this.fs.chmodSync(dirname(this.filePath), 0o700);
    }
  }

  private ensurePrivateFile(path: string): void {
    if (process.platform !== 'win32') this.fs.chmodSync(path, 0o600);
  }
}

function sleepSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, 'ESRCH');
  }
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === code,
  );
}
