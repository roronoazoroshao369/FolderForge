import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { scopeDigest, type ConsentIdentity, type FleetProfileTuple } from './trusted-host-scope.js';

export interface TrustedHostIntent {
  schemaVersion: 1;
  requestId: string;
  instanceId: string;
  tuple: FleetProfileTuple;
  identity: ConsentIdentity;
  scopeHash: string;
  expectedInstanceRevision: string;
  requestedBy: string;
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
}

export interface TrustedHostGrant {
  schemaVersion: 1;
  requestId: string;
  instanceId: string;
  scopeHash: string;
  identity: ConsentIdentity;
  tuple: FleetProfileTuple;
  approvedAt: number;
}

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
const REQUEST_RE = /^req_[a-zA-Z0-9_-]{3,72}$/;
const SCOPE_RE = /^[a-f0-9]{64}$/;

function assertPrivateDir(path: string, uid: number): void {
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0) {
    throw new Error('INVALID_OPERATOR_DIRECTORY');
  }
}

function openPrivateFile(path: string, uid: number): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const st = fstatSync(fd);
  if (!st.isFile() || st.uid !== uid || st.nlink !== 1 || (st.mode & 0o077) !== 0) {
    closeSync(fd);
    throw new Error('INVALID_OPERATOR_FILE');
  }
  return fd;
}

function readPrivateJson<T>(path: string, uid: number): T {
  const fd = openPrivateFile(path, uid);
  try {
    const raw = readFileSync(fd, { encoding: 'utf8' });
    if (raw.length > 32_768) throw new Error('INVALID_OPERATOR_FILE');
    return JSON.parse(raw) as T;
  } finally { closeSync(fd); }
}

function putPrivateFile(path: string, text: string, uid: number, exclusive: boolean): void {
  const dest = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  const fd = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PRIVATE_FILE);
  try {
    const st = fstatSync(fd);
    if (st.uid !== uid || !st.isFile() || st.nlink !== 1 || (st.mode & 0o077) !== 0) {
      throw new Error('INVALID_OPERATOR_FILE');
    }
    writeSync(fd, text);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  if (!exclusive) renameSync(dest, path);
}

/** Host-owned, owner-only storage. Never expose these records over Dashboard or MCP. */
export class TrustedHostStore {
  private readonly root: string;
  private readonly uid: number;
  private readonly now: () => number;

  constructor(input: { operatorRoot: string; currentUid: number; now: () => number }) {
    if (!Number.isSafeInteger(input.currentUid) || input.currentUid < 0) {
      throw new Error('INVALID_OPERATOR_IDENTITY');
    }
    this.root = resolve(input.operatorRoot);
    this.uid = input.currentUid;
    this.now = input.now;
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true, mode: PRIVATE_DIR });
    assertPrivateDir(this.root, this.uid);
    for (const d of ['pending', 'grants', 'revocations']) {
      const path = join(this.root, d);
      if (!existsSync(path)) mkdirSync(path, { mode: PRIVATE_DIR });
      assertPrivateDir(path, this.uid);
    }
  }

  private requestFile(requestId: string): string {
    if (!REQUEST_RE.test(requestId)) throw new Error('INVALID_CONSENT_REQUEST_ID');
    return join(this.root, 'pending', `${requestId}.json`);
  }

  private grantFile(scopeHash: string): string {
    if (!SCOPE_RE.test(scopeHash)) throw new Error('INVALID_CONSENT_SCOPE');
    return join(this.root, 'grants', `${scopeHash}.json`);
  }

  private revocationFile(identity: ConsentIdentity): string {
    const key = createHash('sha256').update(JSON.stringify([
      identity.installationId, identity.serviceUid, identity.instanceId,
    ])).digest('hex');
    return join(this.root, 'revocations', `${key}.json`);
  }

  createPending(intent: TrustedHostIntent): void {
    if (intent.schemaVersion !== 1 || intent.instanceId !== intent.identity.instanceId ||
        intent.scopeHash !== scopeDigest(intent.tuple, intent.identity) ||
        intent.consumedAt !== undefined || intent.expiresAt <= this.now() ||
        intent.expiresAt - intent.createdAt > 600_000 || intent.createdAt > this.now() ||
        !intent.expectedInstanceRevision || !intent.requestedBy) {
      throw new Error('INVALID_CONSENT_INTENT');
    }
    const path = this.requestFile(intent.requestId);
    putPrivateFile(path, JSON.stringify(intent), this.uid, true);
  }

  readPending(requestId: string): TrustedHostIntent | null {
    const path = this.requestFile(requestId);
    if (!existsSync(path)) return null;
    const value = readPrivateJson<TrustedHostIntent>(path, this.uid);
    if (value.schemaVersion !== 1 || value.requestId !== requestId ||
        value.consumedAt !== undefined || value.expiresAt <= this.now() ||
        value.scopeHash !== scopeDigest(value.tuple, value.identity)) return null;
    return value;
  }

  consumeLocalApproval(requestId: string, expectedDigest: string): TrustedHostGrant {
    const pending = this.readPending(requestId);
    if (!pending) throw new Error('CONSENT_REQUEST_UNAVAILABLE');
    if (pending.scopeHash !== expectedDigest) throw new Error('CONSENT_SCOPE_MISMATCH');
    if (this.currentRevocationGeneration(pending.identity) !== pending.identity.revocationGeneration) {
      throw new Error('CONSENT_REVOKED');
    }
    const grant: TrustedHostGrant = {
      schemaVersion: 1, requestId, instanceId: pending.instanceId,
      scopeHash: pending.scopeHash, identity: pending.identity, tuple: pending.tuple, approvedAt: this.now(),
    };
    // Fail closed on repeat approval, even if the pending file was not marked due to a crash.
    const path = this.grantFile(grant.scopeHash);
    putPrivateFile(path, JSON.stringify(grant), this.uid, true);
    putPrivateFile(this.requestFile(requestId), JSON.stringify({ ...pending, consumedAt: this.now() }), this.uid, false);
    return grant;
  }

  validateGrant(identity: ConsentIdentity, tuple: FleetProfileTuple): boolean {
    if (identity.authMode === 'none' || this.currentRevocationGeneration(identity) !== identity.revocationGeneration) return false;
    const digest = scopeDigest(tuple, identity);
    const path = this.grantFile(digest);
    if (!existsSync(path)) return false;
    const grant = readPrivateJson<TrustedHostGrant>(path, this.uid);
    return grant.schemaVersion === 1 && grant.scopeHash === digest &&
      grant.instanceId === identity.instanceId &&
      scopeDigest(grant.tuple, grant.identity) === digest;
  }

  currentRevocationGeneration(identity: ConsentIdentity): number {
    const path = this.revocationFile(identity);
    if (!existsSync(path)) return 0;
    const stored = readPrivateJson<{ generation: number }>(path, this.uid);
    if (!Number.isSafeInteger(stored.generation) || stored.generation < 0) throw new Error('INVALID_REVOCATION_RECORD');
    return stored.generation;
  }

  readGrantByScope(scopeHash: string): TrustedHostGrant | null {
    const path = this.grantFile(scopeHash);
    if (!existsSync(path)) return null;
    const grant = readPrivateJson<TrustedHostGrant>(path, this.uid);
    if (grant.schemaVersion !== 1 || grant.scopeHash !== scopeHash ||
        scopeDigest(grant.tuple, grant.identity) !== scopeHash ||
        this.currentRevocationGeneration(grant.identity) !== grant.identity.revocationGeneration) return null;
    return grant;
  }

  revoke(identity: ConsentIdentity): void {
    const path = this.revocationFile(identity);
    const generation = Math.max(identity.revocationGeneration, this.currentRevocationGeneration(identity)) + 1;
    putPrivateFile(path, JSON.stringify({ generation, revokedAt: this.now() }), this.uid, false);
  }
}
