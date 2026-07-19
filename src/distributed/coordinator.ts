import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export type DistributedReplayPolicy = 'idempotent' | 'no-replay';
export type DistributedJobState =
  | 'queued'
  | 'leased'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export interface DistributedWorkerView {
  id: string;
  name: string;
  capabilities: string[];
  publicKeyFingerprint: string;
  state: 'active' | 'revoked';
  createdAt: number;
  updatedAt: number;
  tokenExpiresAt?: number;
  lastSeenAt?: number;
  revokedAt?: number;
  revokeReason?: string;
}

export interface DistributedJobView {
  id: string;
  idempotencyKey: string;
  tool: string;
  argsDigest: string;
  payloadDigest: string;
  inputArtifacts: string[];
  requiredCapabilities: string[];
  replayPolicy: DistributedReplayPolicy;
  state: DistributedJobState;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  lease?: {
    id: string;
    workerId: string;
    fencingToken: number;
    issuedAt: number;
    expiresAt: number;
    acknowledgedAt?: number;
    lastHeartbeatAt?: number;
  };
  completedAt?: number;
  failure?: string;
  blockedReason?: string;
  completion?: DistributedCompletionRecord;
}

export interface DistributedLease {
  job: DistributedJobView;
  payload: {
    tool: string;
    args: Record<string, unknown>;
  };
}

export interface DistributedSandboxEvidence {
  mode: 'process' | 'docker' | 'podman' | 'remote';
  policyDigest: string;
  imageDigest?: string;
  network?: string;
  readOnlyRoot?: boolean;
  workerVersion?: string;
  platform?: string;
}

export interface DistributedWorkerEvidence {
  schemaVersion: 1;
  jobId: string;
  leaseId: string;
  fencingToken: number;
  workerId: string;
  tool: string;
  argsDigest: string;
  resultDigest: string;
  resultOk: boolean;
  resultSummary?: string;
  inputArtifacts: string[];
  outputArtifacts: string[];
  sandboxEvidence: DistributedSandboxEvidence;
  completedAt: number;
}

export interface DistributedCompletionRecord {
  evidence: DistributedWorkerEvidence;
  workerSignature: string;
  coordinatorSignature: string;
  coordinatorKeyFingerprint: string;
  acceptedAt: number;
}

interface EncryptedPayload {
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
}

interface WorkerRecord extends DistributedWorkerView {
  publicKeyPem: string;
  activeTokenId?: string;
}

interface JobRecord extends Omit<DistributedJobView, 'lease'> {
  encryptedPayload: EncryptedPayload;
  lease?: NonNullable<DistributedJobView['lease']> & { tokenId: string };
  leaseOutputArtifacts?: string[];
}

interface CoordinatorStore {
  schemaVersion: 1;
  nextFencingToken: number;
  workers: WorkerRecord[];
  jobs: JobRecord[];
}

interface TokenClaims {
  schemaVersion: 1;
  kind: 'folderforge-worker';
  workerId: string;
  tokenId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface DistributedCoordinatorOptions {
  now?: () => number;
  artifactExists?: (id: string) => boolean;
  maxQueuedJobs?: number;
  maxTokenTtlMs?: number;
  maxLeaseTtlMs?: number;
}

const ARTIFACT_ID = /^art_[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const CAPABILITY = /^[a-z][a-z0-9_.:-]{0,63}$/i;
const WORKER_ID = /^wrk_[a-f0-9]{12}$/;
const JOB_ID = /^job_[a-f0-9]{16}$/;
const MAX_ARGS_BYTES = 256_000;
const MAX_CAPABILITIES = 32;
const MAX_ARTIFACTS = 64;
const DEFAULT_MAX_QUEUED = 1000;
const DEFAULT_TOKEN_TTL = 15 * 60_000;
const DEFAULT_LEASE_TTL = 60_000;
const LOCK_STALE_MS = 30_000;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function signDistributedEvidence(
  evidence: DistributedWorkerEvidence,
  privateKeyPem: string,
): string {
  return cryptoSign(null, Buffer.from(canonicalJson(evidence)), createPrivateKey(privateKeyPem)).toString('base64url');
}

export function verifyDistributedEvidence(
  evidence: DistributedWorkerEvidence,
  signature: string,
  publicKeyPem: string,
): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(canonicalJson(evidence)),
      createPublicKey(publicKeyPem),
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

function boundedString(value: unknown, label: string, max = 256): string {
  const text = String(value ?? '').trim();
  if (!text || Buffer.byteLength(text) > max || /\0/.test(text)) {
    throw new Error(`${label} must be a non-empty string up to ${max} bytes.`);
  }
  return text;
}

function uniqueCapabilities(value: unknown, label = 'capabilities'): string[] {
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES) {
    throw new Error(`${label} must be an array with at most ${MAX_CAPABILITIES} entries.`);
  }
  const result = [...new Set(value.map((item) => String(item).trim()))].sort();
  if (!result.every((item) => CAPABILITY.test(item))) {
    throw new Error(`${label} contains an invalid capability.`);
  }
  return result;
}

function validateArtifactIds(
  value: unknown,
  artifactExists: (id: string) => boolean,
  label: string,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ARTIFACTS) {
    throw new Error(`${label} must contain at most ${MAX_ARTIFACTS} artifact ids.`);
  }
  const ids = [...new Set(value.map((item) => String(item)))];
  for (const id of ids) {
    if (!ARTIFACT_ID.test(id)) throw new Error(`${label} contains an invalid artifact id: ${id}`);
    if (!artifactExists(id)) throw new Error(`${label} references a missing artifact: ${id}`);
  }
  return ids.sort();
}

function publicKeyDetails(publicKeyPem: string): { normalized: string; fingerprint: string } {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Worker public key must be Ed25519.');
  const normalized = key.export({ type: 'spki', format: 'pem' }).toString();
  return { normalized, fingerprint: sha256(key.export({ type: 'spki', format: 'der' })) };
}

function cloneWorker(worker: WorkerRecord): DistributedWorkerView {
  const {
    publicKeyPem: _publicKeyPem,
    activeTokenId: _activeTokenId,
    ...view
  } = worker;
  return JSON.parse(JSON.stringify(view)) as DistributedWorkerView;
}

function cloneJob(job: JobRecord): DistributedJobView {
  const {
    encryptedPayload: _encryptedPayload,
    leaseOutputArtifacts: _leaseOutputArtifacts,
    ...view
  } = job;
  if (view.lease) {
    const { tokenId: _tokenId, ...lease } = view.lease;
    return JSON.parse(JSON.stringify({ ...view, lease })) as DistributedJobView;
  }
  return JSON.parse(JSON.stringify(view)) as DistributedJobView;
}

export class DistributedCoordinator {
  readonly root: string;
  private readonly storePath: string;
  private readonly lockPath: string;
  private readonly tokenPrivatePath: string;
  private readonly tokenPublicPath: string;
  private readonly payloadKeyPath: string;
  private readonly now: () => number;
  private readonly artifactExists: (id: string) => boolean;
  private readonly maxQueuedJobs: number;
  private readonly maxTokenTtlMs: number;
  private readonly maxLeaseTtlMs: number;

  constructor(projectRoot: string, options: DistributedCoordinatorOptions = {}) {
    this.root = join(projectRoot, '.folderforge', 'distributed');
    this.storePath = join(this.root, 'coordinator.json');
    this.lockPath = join(this.root, 'coordinator.lock');
    this.tokenPrivatePath = join(this.root, 'coordinator-private.pem');
    this.tokenPublicPath = join(this.root, 'coordinator-public.pem');
    this.payloadKeyPath = join(this.root, 'payload.key');
    this.now = options.now ?? Date.now;
    this.artifactExists = options.artifactExists ?? (() => true);
    this.maxQueuedJobs = options.maxQueuedJobs ?? DEFAULT_MAX_QUEUED;
    this.maxTokenTtlMs = options.maxTokenTtlMs ?? DEFAULT_TOKEN_TTL;
    this.maxLeaseTtlMs = options.maxLeaseTtlMs ?? DEFAULT_LEASE_TTL;
  }

  coordinatorPublicKey(): { publicKeyPem: string; fingerprint: string } {
    this.ensureKeys();
    const publicKeyPem = readFileSync(this.tokenPublicPath, 'utf8');
    return { publicKeyPem, fingerprint: publicKeyDetails(publicKeyPem).fingerprint };
  }

  registerWorker(input: {
    name: string;
    capabilities?: string[];
    publicKeyPem: string;
    tokenTtlMs?: number;
  }): { worker: DistributedWorkerView; token: string } {
    const name = boundedString(input.name, 'worker name', 128);
    const capabilities = uniqueCapabilities(input.capabilities ?? []);
    const key = publicKeyDetails(boundedString(input.publicKeyPem, 'worker public key', 16_384));
    const ttl = this.boundTtl(input.tokenTtlMs ?? this.maxTokenTtlMs, this.maxTokenTtlMs, 'tokenTtlMs');
    return this.mutate((store) => {
      const existing = store.workers.find(
        (worker) => worker.publicKeyFingerprint === key.fingerprint && worker.state === 'active',
      );
      if (existing) throw new Error(`An active worker already uses this public key: ${existing.id}`);
      const now = this.now();
      const worker: WorkerRecord = {
        id: `wrk_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        name,
        capabilities,
        publicKeyPem: key.normalized,
        publicKeyFingerprint: key.fingerprint,
        state: 'active',
        createdAt: now,
        updatedAt: now,
      };
      store.workers.push(worker);
      const token = this.issueTokenInStore(store, worker, ttl);
      return { worker: cloneWorker(worker), token };
    });
  }

  rotateWorkerToken(workerId: string, ttlMs = this.maxTokenTtlMs): { worker: DistributedWorkerView; token: string } {
    this.assertWorkerId(workerId);
    const ttl = this.boundTtl(ttlMs, this.maxTokenTtlMs, 'tokenTtlMs');
    return this.mutate((store) => {
      const worker = this.worker(store, workerId);
      if (worker.state !== 'active') throw new Error(`Worker is revoked: ${workerId}`);
      const token = this.issueTokenInStore(store, worker, ttl);
      return { worker: cloneWorker(worker), token };
    });
  }

  revokeWorker(workerId: string, reason = 'Revoked by operator.'): DistributedWorkerView {
    this.assertWorkerId(workerId);
    return this.mutate((store) => {
      const worker = this.worker(store, workerId);
      const now = this.now();
      worker.state = 'revoked';
      worker.revokedAt = now;
      worker.revokeReason = boundedString(reason, 'revoke reason', 512);
      worker.updatedAt = now;
      delete worker.activeTokenId;
      delete worker.tokenExpiresAt;
      for (const job of store.jobs) {
        if (job.lease?.workerId !== workerId || !['leased', 'running'].includes(job.state)) continue;
        this.expireLease(job, now, 'Worker revoked while holding lease.');
      }
      return cloneWorker(worker);
    });
  }

  listWorkers(): DistributedWorkerView[] {
    return this.read((store) => store.workers.map(cloneWorker).sort((a, b) => b.updatedAt - a.updatedAt));
  }

  submitJob(input: {
    tool: string;
    args: Record<string, unknown>;
    idempotencyKey?: string;
    replayPolicy?: DistributedReplayPolicy;
    requiredCapabilities?: string[];
    inputArtifacts?: string[];
  }): { job: DistributedJobView; duplicate: boolean } {
    const tool = boundedString(input.tool, 'tool', 128);
    if (!/^[a-z][a-z0-9_:-]{1,127}$/i.test(tool)) throw new Error('tool has an invalid format.');
    if (!input.args || typeof input.args !== 'object' || Array.isArray(input.args)) {
      throw new Error('args must be an object.');
    }
    const payloadText = canonicalJson({ tool, args: input.args });
    if (Buffer.byteLength(payloadText) > MAX_ARGS_BYTES) {
      throw new Error(`Distributed payload exceeds ${MAX_ARGS_BYTES} bytes.`);
    }
    const argsDigest = sha256(canonicalJson(input.args));
    const payloadDigest = sha256(payloadText);
    const idempotencyKey = input.idempotencyKey
      ? boundedString(input.idempotencyKey, 'idempotencyKey', 256)
      : `auto:${payloadDigest}`;
    const replayPolicy = input.replayPolicy ?? 'no-replay';
    if (!['idempotent', 'no-replay'].includes(replayPolicy)) throw new Error('Invalid replayPolicy.');
    const requiredCapabilities = uniqueCapabilities(input.requiredCapabilities ?? [], 'requiredCapabilities');
    const inputArtifacts = validateArtifactIds(input.inputArtifacts, this.artifactExists, 'inputArtifacts');

    return this.mutate((store) => {
      const duplicate = store.jobs.find((job) => job.idempotencyKey === idempotencyKey);
      if (duplicate) {
        if (duplicate.payloadDigest !== payloadDigest) {
          throw new Error('idempotencyKey already exists with a different payload.');
        }
        return { job: cloneJob(duplicate), duplicate: true };
      }
      const activeCount = store.jobs.filter((job) => !['completed', 'failed', 'cancelled'].includes(job.state)).length;
      if (activeCount >= this.maxQueuedJobs) throw new Error(`Coordinator active-job quota reached (${this.maxQueuedJobs}).`);
      const now = this.now();
      const job: JobRecord = {
        id: `job_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
        idempotencyKey,
        tool,
        argsDigest,
        payloadDigest,
        encryptedPayload: this.encryptPayload(payloadText),
        inputArtifacts,
        requiredCapabilities,
        replayPolicy,
        state: 'queued',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };
      store.jobs.push(job);
      return { job: cloneJob(job), duplicate: false };
    });
  }

  leaseJob(token: string, ttlMs = this.maxLeaseTtlMs): DistributedLease | null {
    const ttl = this.boundTtl(ttlMs, this.maxLeaseTtlMs, 'leaseTtlMs');
    return this.mutate((store) => {
      const { worker, claims } = this.authenticate(store, token);
      const now = this.now();
      worker.lastSeenAt = now;
      worker.updatedAt = now;
      const existing = store.jobs.find(
        (job) => job.lease?.workerId === worker.id && ['leased', 'running'].includes(job.state),
      );
      if (existing) return this.leaseView(existing);
      const capabilities = new Set(worker.capabilities);
      const job = store.jobs
        .filter((candidate) => candidate.state === 'queued')
        .sort((a, b) => a.createdAt - b.createdAt)
        .find((candidate) => candidate.requiredCapabilities.every((capability) => capabilities.has(capability)));
      if (!job) return null;
      store.nextFencingToken += 1;
      job.attempts += 1;
      job.state = 'leased';
      job.updatedAt = now;
      job.leaseOutputArtifacts = [];
      job.lease = {
        id: `lease_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
        workerId: worker.id,
        tokenId: claims.tokenId,
        fencingToken: store.nextFencingToken,
        issuedAt: now,
        expiresAt: now + ttl,
      };
      return this.leaseView(job);
    });
  }

  acknowledgeJob(token: string, jobId: string, leaseId: string, fencingToken: number): DistributedJobView {
    return this.mutate((store) => {
      const { worker } = this.authenticate(store, token);
      const job = this.matchLease(store, worker.id, jobId, leaseId, fencingToken);
      if (job.state !== 'leased') throw new Error(`Job cannot be acknowledged from state ${job.state}.`);
      const now = this.now();
      job.state = 'running';
      job.updatedAt = now;
      job.lease!.acknowledgedAt = now;
      job.lease!.lastHeartbeatAt = now;
      worker.lastSeenAt = now;
      worker.updatedAt = now;
      return cloneJob(job);
    });
  }

  heartbeat(token: string, jobId: string, leaseId: string, fencingToken: number, ttlMs = this.maxLeaseTtlMs): DistributedJobView {
    const ttl = this.boundTtl(ttlMs, this.maxLeaseTtlMs, 'leaseTtlMs');
    return this.mutate((store) => {
      const { worker } = this.authenticate(store, token);
      const job = this.matchLease(store, worker.id, jobId, leaseId, fencingToken);
      if (!['leased', 'running'].includes(job.state)) throw new Error(`Job is not heartbeat-eligible: ${job.state}.`);
      const now = this.now();
      job.lease!.lastHeartbeatAt = now;
      job.lease!.expiresAt = now + ttl;
      job.updatedAt = now;
      worker.lastSeenAt = now;
      worker.updatedAt = now;
      return cloneJob(job);
    });
  }

  completeJob(input: {
    token: string;
    evidence: DistributedWorkerEvidence;
    workerSignature: string;
  }): DistributedJobView {
    return this.mutate((store) => {
      const { worker } = this.authenticate(store, input.token);
      const evidence = this.validateEvidence(input.evidence);
      const job = this.matchLease(
        store,
        worker.id,
        evidence.jobId,
        evidence.leaseId,
        evidence.fencingToken,
      );
      if (job.state !== 'running') throw new Error(`Job completion requires running state; current=${job.state}.`);
      if (evidence.workerId !== worker.id || evidence.tool !== job.tool || evidence.argsDigest !== job.argsDigest) {
        throw new Error('Worker evidence does not match the leased job.');
      }
      if (canonicalJson(evidence.inputArtifacts) !== canonicalJson(job.inputArtifacts)) {
        throw new Error('Worker evidence inputArtifacts do not match the job.');
      }
      const outputArtifacts = validateArtifactIds(
        evidence.outputArtifacts,
        this.artifactExists,
        'outputArtifacts',
      );
      if (canonicalJson(outputArtifacts) !== canonicalJson(job.leaseOutputArtifacts ?? [])) {
        throw new Error('Worker evidence outputArtifacts were not uploaded by the active lease.');
      }
      if (!verifyDistributedEvidence(evidence, input.workerSignature, worker.publicKeyPem)) {
        throw new Error('Worker evidence signature is invalid.');
      }
      const now = this.now();
      if (Math.abs(now - evidence.completedAt) > 5 * 60_000) {
        throw new Error('Worker evidence completedAt exceeds the allowed clock-skew window.');
      }
      const coordinator = this.coordinatorPublicKey();
      const acceptance = {
        evidence,
        workerSignature: input.workerSignature,
        acceptedAt: now,
      };
      const coordinatorSignature = cryptoSign(
        null,
        Buffer.from(canonicalJson(acceptance)),
        createPrivateKey(readFileSync(this.tokenPrivatePath, 'utf8')),
      ).toString('base64url');
      job.state = evidence.resultOk ? 'completed' : 'failed';
      job.updatedAt = now;
      job.completedAt = now;
      if (!evidence.resultOk) job.failure = evidence.resultSummary ?? 'Remote worker reported a failed result.';
      job.completion = {
        evidence,
        workerSignature: input.workerSignature,
        coordinatorSignature,
        coordinatorKeyFingerprint: coordinator.fingerprint,
        acceptedAt: now,
      };
      this.clearLease(job);
      return cloneJob(job);
    });
  }

  authorizeLease(token: string, jobId: string, leaseId: string, fencingToken: number): DistributedJobView {
    return this.read((store) => {
      const { worker } = this.authenticate(store, token);
      const job = this.matchLease(store, worker.id, jobId, leaseId, fencingToken);
      return cloneJob(job);
    });
  }

  recordOutputArtifact(
    token: string,
    jobId: string,
    leaseId: string,
    fencingToken: number,
    artifactId: string,
  ): DistributedJobView {
    return this.mutate((store) => {
      const { worker } = this.authenticate(store, token);
      const job = this.matchLease(store, worker.id, jobId, leaseId, fencingToken);
      const [validated] = validateArtifactIds([artifactId], this.artifactExists, 'outputArtifacts');
      const outputArtifacts = new Set(job.leaseOutputArtifacts ?? []);
      outputArtifacts.add(validated!);
      if (outputArtifacts.size > MAX_ARTIFACTS) {
        throw new Error(`outputArtifacts must contain at most ${MAX_ARTIFACTS} artifact ids.`);
      }
      job.leaseOutputArtifacts = [...outputArtifacts].sort();
      job.updatedAt = this.now();
      return cloneJob(job);
    });
  }

  failJob(token: string, jobId: string, leaseId: string, fencingToken: number, reason: string): DistributedJobView {
    return this.mutate((store) => {
      const { worker } = this.authenticate(store, token);
      const job = this.matchLease(store, worker.id, jobId, leaseId, fencingToken);
      const now = this.now();
      job.state = 'failed';
      job.failure = boundedString(reason, 'failure reason', 2_000);
      job.updatedAt = now;
      job.completedAt = now;
      this.clearLease(job);
      return cloneJob(job);
    });
  }

  cancelJob(jobId: string, reason = 'Cancelled by operator.'): DistributedJobView {
    this.assertJobId(jobId);
    return this.mutate((store) => {
      const job = this.job(store, jobId);
      if (['completed', 'failed', 'cancelled'].includes(job.state)) return cloneJob(job);
      const now = this.now();
      job.state = 'cancelled';
      job.failure = boundedString(reason, 'cancel reason', 2_000);
      job.updatedAt = now;
      job.completedAt = now;
      this.clearLease(job);
      return cloneJob(job);
    });
  }

  retryBlocked(jobId: string): DistributedJobView {
    this.assertJobId(jobId);
    return this.mutate((store) => {
      const job = this.job(store, jobId);
      if (job.state !== 'blocked') throw new Error(`Job is not blocked: ${job.state}`);
      if (job.replayPolicy !== 'idempotent') throw new Error('Only idempotent blocked jobs may be retried automatically.');
      job.state = 'queued';
      job.updatedAt = this.now();
      delete job.blockedReason;
      this.clearLease(job);
      return cloneJob(job);
    });
  }

  getJob(jobId: string): DistributedJobView {
    this.assertJobId(jobId);
    return this.read((store) => cloneJob(this.job(store, jobId)));
  }

  listJobs(limit = 100): DistributedJobView[] {
    const bounded = Math.max(1, Math.min(1000, Math.floor(limit)));
    return this.read((store) => store.jobs.map(cloneJob).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, bounded));
  }

  recoverExpiredLeases(): { requeued: string[]; blocked: string[] } {
    this.ensureKeys();
    return this.withLock(() => {
      const store = this.loadStore();
      const recovered = this.recoverInStore(store);
      this.saveStore(store);
      return recovered;
    });
  }

  verifyCompletion(jobId: string): { valid: boolean; workerValid: boolean; coordinatorValid: boolean; job: DistributedJobView } {
    this.assertJobId(jobId);
    return this.read((store) => {
      const job = this.job(store, jobId);
      if (!job.completion) return { valid: false, workerValid: false, coordinatorValid: false, job: cloneJob(job) };
      const worker = this.worker(store, job.completion.evidence.workerId);
      const workerValid = verifyDistributedEvidence(
        job.completion.evidence,
        job.completion.workerSignature,
        worker.publicKeyPem,
      );
      const acceptance = {
        evidence: job.completion.evidence,
        workerSignature: job.completion.workerSignature,
        acceptedAt: job.completion.acceptedAt,
      };
      const coordinatorValid = cryptoVerify(
        null,
        Buffer.from(canonicalJson(acceptance)),
        createPublicKey(readFileSync(this.tokenPublicPath, 'utf8')),
        Buffer.from(job.completion.coordinatorSignature, 'base64url'),
      );
      return { valid: workerValid && coordinatorValid, workerValid, coordinatorValid, job: cloneJob(job) };
    });
  }

  stats(): Record<string, unknown> {
    return this.read((store) => ({
      workers: {
        total: store.workers.length,
        active: store.workers.filter((worker) => worker.state === 'active').length,
        revoked: store.workers.filter((worker) => worker.state === 'revoked').length,
      },
      jobs: Object.fromEntries(
        (['queued', 'leased', 'running', 'completed', 'failed', 'blocked', 'cancelled'] as DistributedJobState[])
          .map((state) => [state, store.jobs.filter((job) => job.state === state).length]),
      ),
      nextFencingToken: store.nextFencingToken,
      coordinatorKeyFingerprint: this.coordinatorPublicKey().fingerprint,
    }));
  }

  private leaseView(job: JobRecord): DistributedLease {
    const payload = JSON.parse(this.decryptPayload(job.encryptedPayload)) as { tool: string; args: Record<string, unknown> };
    return { job: cloneJob(job), payload };
  }

  private validateEvidence(value: DistributedWorkerEvidence): DistributedWorkerEvidence {
    if (!value || value.schemaVersion !== 1) throw new Error('Unsupported worker evidence schemaVersion.');
    this.assertJobId(value.jobId);
    this.assertWorkerId(value.workerId);
    boundedString(value.leaseId, 'leaseId', 128);
    boundedString(value.tool, 'evidence.tool', 128);
    if (!Number.isSafeInteger(value.fencingToken) || value.fencingToken < 1) throw new Error('Invalid evidence fencingToken.');
    if (!HASH.test(value.argsDigest) || !HASH.test(value.resultDigest)) throw new Error('Evidence digests must be SHA-256 hex.');
    if (typeof value.resultOk !== 'boolean') throw new Error('Evidence resultOk must be boolean.');
    if (value.resultSummary !== undefined) boundedString(value.resultSummary, 'resultSummary', 2000);
    validateArtifactIds(value.inputArtifacts, this.artifactExists, 'inputArtifacts');
    validateArtifactIds(value.outputArtifacts, this.artifactExists, 'outputArtifacts');
    if (!Number.isSafeInteger(value.completedAt) || value.completedAt < 1) throw new Error('Invalid evidence completedAt.');
    const sandbox = value.sandboxEvidence;
    if (!sandbox || !['process', 'docker', 'podman', 'remote'].includes(sandbox.mode)) {
      throw new Error('Worker evidence requires a valid sandbox mode.');
    }
    if (!HASH.test(sandbox.policyDigest)) throw new Error('sandboxEvidence.policyDigest must be SHA-256 hex.');
    if (sandbox.imageDigest !== undefined && !HASH.test(sandbox.imageDigest.replace(/^sha256:/, ''))) {
      throw new Error('sandboxEvidence.imageDigest must be SHA-256 hex.');
    }
    return JSON.parse(JSON.stringify(value)) as DistributedWorkerEvidence;
  }

  private issueTokenInStore(store: CoordinatorStore, worker: WorkerRecord, ttlMs: number): string {
    this.ensureKeys();
    const now = this.now();
    const claims: TokenClaims = {
      schemaVersion: 1,
      kind: 'folderforge-worker',
      workerId: worker.id,
      tokenId: randomUUID(),
      issuedAt: now,
      expiresAt: now + ttlMs,
    };
    const body = Buffer.from(canonicalJson(claims)).toString('base64url');
    const signature = cryptoSign(
      null,
      Buffer.from(`ffw1.${body}`),
      createPrivateKey(readFileSync(this.tokenPrivatePath, 'utf8')),
    ).toString('base64url');
    worker.activeTokenId = claims.tokenId;
    worker.tokenExpiresAt = claims.expiresAt;
    worker.updatedAt = now;
    return `ffw1.${body}.${signature}`;
  }

  private authenticate(store: CoordinatorStore, token: string): { worker: WorkerRecord; claims: TokenClaims } {
    this.ensureKeys();
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'ffw1') throw new Error('Invalid worker token format.');
    const body = parts[1]!;
    const valid = cryptoVerify(
      null,
      Buffer.from(`ffw1.${body}`),
      createPublicKey(readFileSync(this.tokenPublicPath, 'utf8')),
      Buffer.from(parts[2]!, 'base64url'),
    );
    if (!valid) throw new Error('Worker token signature is invalid.');
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenClaims;
    if (claims.schemaVersion !== 1 || claims.kind !== 'folderforge-worker') throw new Error('Unsupported worker token.');
    this.assertWorkerId(claims.workerId);
    if (!claims.tokenId || !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)) {
      throw new Error('Worker token claims are invalid.');
    }
    const worker = this.worker(store, claims.workerId);
    if (worker.state !== 'active') throw new Error('Worker is revoked.');
    if (worker.activeTokenId !== claims.tokenId) throw new Error('Worker token has been rotated or revoked.');
    if (claims.expiresAt <= this.now()) throw new Error('Worker token has expired.');
    return { worker, claims };
  }

  private matchLease(
    store: CoordinatorStore,
    workerId: string,
    jobId: string,
    leaseId: string,
    fencingToken: number,
  ): JobRecord {
    this.assertJobId(jobId);
    const job = this.job(store, jobId);
    const lease = job.lease;
    if (!lease) throw new Error('Job has no active lease.');
    if (lease.workerId !== workerId || lease.id !== leaseId || lease.fencingToken !== fencingToken) {
      throw new Error('Stale or mismatched lease/fencing token.');
    }
    if (lease.expiresAt <= this.now()) {
      this.expireLease(job, this.now(), 'Lease expired before worker operation.');
      throw new Error('Lease has expired.');
    }
    return job;
  }

  private recoverInStore(store: CoordinatorStore): { requeued: string[]; blocked: string[] } {
    const now = this.now();
    const requeued: string[] = [];
    const blocked: string[] = [];
    for (const job of store.jobs) {
      if (!job.lease || !['leased', 'running'].includes(job.state) || job.lease.expiresAt > now) continue;
      const next = this.expireLease(job, now, 'Lease expired during coordinator recovery.');
      if (next === 'queued') requeued.push(job.id);
      if (next === 'blocked') blocked.push(job.id);
    }
    return { requeued, blocked };
  }

  private expireLease(job: JobRecord, now: number, reason: string): 'queued' | 'blocked' {
    const executionMayHaveStarted = job.state === 'running' || Boolean(job.lease?.acknowledgedAt);
    if (!executionMayHaveStarted || job.replayPolicy === 'idempotent') {
      job.state = 'queued';
      job.updatedAt = now;
      this.clearLease(job);
      delete job.blockedReason;
      return 'queued';
    }
    job.state = 'blocked';
    job.updatedAt = now;
    job.blockedReason = `${reason} Side-effect status is unknown and replayPolicy=no-replay.`;
    this.clearLease(job);
    return 'blocked';
  }

  private clearLease(job: JobRecord): void {
    delete job.lease;
    delete job.leaseOutputArtifacts;
  }

  private worker(store: CoordinatorStore, id: string): WorkerRecord {
    const worker = store.workers.find((entry) => entry.id === id);
    if (!worker) throw new Error(`Worker not found: ${id}`);
    return worker;
  }

  private job(store: CoordinatorStore, id: string): JobRecord {
    const job = store.jobs.find((entry) => entry.id === id);
    if (!job) throw new Error(`Distributed job not found: ${id}`);
    return job;
  }

  private assertWorkerId(id: string): void {
    if (!WORKER_ID.test(id)) throw new Error('Invalid worker id.');
  }

  private assertJobId(id: string): void {
    if (!JOB_ID.test(id)) throw new Error('Invalid distributed job id.');
  }

  private boundTtl(value: number, maximum: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1_000 || value > maximum) {
      throw new Error(`${label} must be an integer from 1000 to ${maximum}.`);
    }
    return value;
  }

  private encryptPayload(plaintext: string): EncryptedPayload {
    this.ensureKeys();
    const key = readFileSync(this.payloadKeyPath);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    };
  }

  private decryptPayload(payload: EncryptedPayload): string {
    this.ensureKeys();
    if (payload.algorithm !== 'aes-256-gcm') throw new Error('Unsupported distributed payload encryption.');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      readFileSync(this.payloadKeyPath),
      Buffer.from(payload.iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  private ensureKeys(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
    const ignore = join(this.root, '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n!.gitignore\n', { mode: 0o600 });
    if (!existsSync(this.tokenPrivatePath) || !existsSync(this.tokenPublicPath)) {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      writeFileSync(
        this.tokenPrivatePath,
        privateKey.export({ type: 'pkcs8', format: 'pem' }),
        { mode: 0o600 },
      );
      writeFileSync(
        this.tokenPublicPath,
        publicKey.export({ type: 'spki', format: 'pem' }),
        { mode: 0o600 },
      );
    }
    if (!existsSync(this.payloadKeyPath)) writeFileSync(this.payloadKeyPath, randomBytes(32), { mode: 0o600 });
    chmodSync(this.tokenPrivatePath, 0o600);
    chmodSync(this.tokenPublicPath, 0o600);
    chmodSync(this.payloadKeyPath, 0o600);
  }

  private emptyStore(): CoordinatorStore {
    return { schemaVersion: 1, nextFencingToken: 0, workers: [], jobs: [] };
  }

  private loadStore(): CoordinatorStore {
    if (!existsSync(this.storePath)) return this.emptyStore();
    const value = JSON.parse(readFileSync(this.storePath, 'utf8')) as CoordinatorStore;
    if (value.schemaVersion !== 1 || !Array.isArray(value.workers) || !Array.isArray(value.jobs)) {
      throw new Error('Invalid distributed coordinator store.');
    }
    return value;
  }

  private saveStore(store: CoordinatorStore): void {
    this.ensureKeys();
    const temp = `${this.storePath}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(temp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, this.storePath);
    chmodSync(this.storePath, 0o600);
  }

  private read<T>(fn: (store: CoordinatorStore) => T): T {
    this.ensureKeys();
    return fn(this.loadStore());
  }

  private mutate<T>(fn: (store: CoordinatorStore) => T): T {
    this.ensureKeys();
    return this.withLock(() => {
      const store = this.loadStore();
      this.recoverInStore(store);
      const result = fn(store);
      this.saveStore(store);
      return result;
    });
  }

  private withLock<T>(fn: () => T): T {
    mkdirSync(dirname(this.lockPath), { recursive: true, mode: 0o700 });
    if (existsSync(this.lockPath)) {
      try {
        if (this.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) rmSync(this.lockPath, { force: true });
      } catch {
        // The lock may have disappeared between exists/stat.
      }
    }
    let fd: number;
    try {
      fd = openSync(this.lockPath, 'wx', 0o600);
    } catch {
      throw new Error('Distributed coordinator is busy; retry the operation.');
    }
    try {
      writeFileSync(fd, `${process.pid}\n${this.now()}\n`);
      return fn();
    } finally {
      closeSync(fd);
      rmSync(this.lockPath, { force: true });
    }
  }
}
