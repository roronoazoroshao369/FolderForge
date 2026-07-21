import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ToolPrincipal, ToolResult } from '../core/types.js';
import type { Container } from '../runtime/container.js';
import type { ToolRegistry } from '../tools/registry.js';
import {
  canonicalJson,
  sha256,
  signDistributedEvidence,
  type DistributedLease,
  type DistributedWorkerEvidence,
} from './coordinator.js';

export interface RemoteWorkerRuntimeOptions {
  coordinatorUrl: string;
  token: string;
  privateKeyPem: string;
  allowedTools: string[];
  projectRoot: string;
  workerVersion: string;
  container: Container;
  registry: ToolRegistry;
  leaseTtlMs?: number;
  heartbeatMs?: number;
  signal?: AbortSignal;
}

export interface RemoteWorkerIteration {
  leased: boolean;
  jobId?: string;
  state?: string;
  resultOk?: boolean;
}

const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_RESULT_BYTES = 5 * 1024 * 1024;
const BLOCKED_TOOL_PREFIXES = ['distributed_', 'marketplace_'];

export function validateCoordinatorUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.username || url.password || url.hash) throw new Error('Coordinator URL must not contain userinfo or a fragment.');
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error('Coordinator URL must use HTTPS; loopback HTTP is allowed for local testing only.');
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  return url;
}

async function readBounded(response: Response): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > MAX_RESPONSE_BYTES) throw new Error(`Coordinator response exceeds ${MAX_RESPONSE_BYTES} bytes.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error(`Coordinator response exceeds ${MAX_RESPONSE_BYTES} bytes.`);
  return bytes;
}

async function requestJson(
  base: URL,
  token: string,
  method: 'POST' | 'GET',
  path: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const url = new URL(path, `${base.toString().replace(/\/$/, '')}/`);
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  const bytes = await readBounded(response);
  let value: unknown = {};
  if (bytes.length > 0) {
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error(`Coordinator returned invalid JSON (HTTP ${response.status}).`); }
  }
  if (!response.ok) {
    const message = value && typeof value === 'object' && typeof (value as Record<string, unknown>).error === 'string'
      ? String((value as Record<string, unknown>).error)
      : `HTTP ${response.status}`;
    throw new Error(`Coordinator request failed: ${message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Coordinator response must be an object.');
  return value as Record<string, unknown>;
}

async function downloadArtifact(
  base: URL,
  token: string,
  lease: DistributedLease,
  artifactId: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const leaseInfo = lease.job.lease!;
  const path = `/v1/jobs/${lease.job.id}/artifacts/${artifactId}?leaseId=${encodeURIComponent(leaseInfo.id)}&fencingToken=${leaseInfo.fencingToken}`;
  const response = await fetch(new URL(path, `${base.toString().replace(/\/$/, '')}/`), {
    headers: { authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const bytes = await readBounded(response);
    throw new Error(`Input artifact download failed: HTTP ${response.status} ${bytes.toString('utf8').slice(0, 500)}`);
  }
  const bytes = await readBounded(response);
  writeFileSync(destination, bytes, { mode: 0o600 });
}

async function resolveArtifactReferences(
  value: unknown,
  context: {
    base: URL;
    token: string;
    lease: DistributedLease;
    root: string;
    cache: Map<string, string>;
    signal?: AbortSignal;
  },
): Promise<unknown> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => resolveArtifactReferences(item, context)));
  }
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (typeof record.$artifact === 'string') {
    const keys = Object.keys(record);
    if (!keys.every((key) => key === '$artifact' || key === 'filename')) {
      throw new Error('Artifact references may contain only $artifact and optional filename.');
    }
    const id = record.$artifact;
    if (!context.lease.job.inputArtifacts.includes(id)) throw new Error(`Artifact reference is not a declared job input: ${id}`);
    const cached = context.cache.get(id);
    if (cached) return cached;
    const rawName = typeof record.filename === 'string' ? basename(record.filename) : `${id}.bin`;
    if (!rawName || rawName === '.' || rawName === '..' || /\0/.test(rawName)) throw new Error('Invalid artifact filename.');
    const path = join(context.root, `${id.slice(4, 16)}-${rawName}`);
    await downloadArtifact(context.base, context.token, context.lease, id, path, context.signal);
    context.cache.set(id, path);
    return path;
  }
  return Object.fromEntries(
    await Promise.all(
      Object.entries(record).map(async ([key, item]) => [key, await resolveArtifactReferences(item, context)]),
    ),
  );
}

function resultPayload(result: ToolResult, container: Container): Buffer {
  const redacted = container.policy.secret.redact(canonicalJson(result));
  const bytes = Buffer.from(redacted, 'utf8');
  if (bytes.byteLength > MAX_RESULT_BYTES) {
    return Buffer.from(JSON.stringify({
      ok: result.ok,
      error: result.error ? container.policy.secret.redact(result.error).slice(0, 8_000) : undefined,
      truncated: true,
      originalBytes: bytes.byteLength,
      digest: sha256(bytes),
    }), 'utf8');
  }
  return bytes;
}

function allowedTool(registry: ToolRegistry, allowlist: Set<string>, name: string): void {
  if (!allowlist.has(name)) throw new Error(`Remote worker tool is not allowlisted: ${name}`);
  if (BLOCKED_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    throw new Error(`Remote control-plane recursion is forbidden: ${name}`);
  }
  const tool = registry.get(name);
  if (!tool || tool.audience !== 'agent') throw new Error(`Remote worker tool is unavailable to the agent plane: ${name}`);
}

export async function runRemoteWorkerOnce(options: RemoteWorkerRuntimeOptions): Promise<RemoteWorkerIteration> {
  const base = validateCoordinatorUrl(options.coordinatorUrl);
  const allowlist = new Set(options.allowedTools);
  if (allowlist.size === 0) throw new Error('Remote worker requires at least one --allow-tools entry.');
  const leaseTtlMs = options.leaseTtlMs ?? 60_000;
  const heartbeatMs = options.heartbeatMs ?? Math.max(1_000, Math.floor(leaseTtlMs / 3));
  if (heartbeatMs >= leaseTtlMs) throw new Error('heartbeatMs must be less than leaseTtlMs.');

  const leaseResponse = await requestJson(base, options.token, 'POST', '/v1/lease', { leaseTtlMs }, options.signal);
  const lease = leaseResponse.lease as DistributedLease | null;
  if (!lease) return { leased: false };
  const leaseInfo = lease.job.lease;
  if (!leaseInfo) throw new Error('Coordinator lease response omitted lease metadata.');
  await requestJson(base, options.token, 'POST', `/v1/jobs/${lease.job.id}/ack`, {
    leaseId: leaseInfo.id,
    fencingToken: leaseInfo.fencingToken,
  }, options.signal);

  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  let heartbeatFailure: Error | null = null;
  const timer = setInterval(() => {
    void requestJson(base, options.token, 'POST', `/v1/jobs/${lease.job.id}/heartbeat`, {
      leaseId: leaseInfo.id,
      fencingToken: leaseInfo.fencingToken,
      leaseTtlMs,
    }, controller.signal).catch((error) => {
      heartbeatFailure = error instanceof Error ? error : new Error(String(error));
      controller.abort(heartbeatFailure);
    });
  }, heartbeatMs);
  timer.unref();

  try {
    allowedTool(options.registry, allowlist, lease.job.tool);
    const inputRoot = join(options.projectRoot, '.folderforge', 'worker-inputs', lease.job.id);
    mkdirSync(inputRoot, { recursive: true, mode: 0o700 });
    const resolved = await resolveArtifactReferences(lease.payload.args, {
      base,
      token: options.token,
      lease,
      root: inputRoot,
      cache: new Map(),
      signal: controller.signal,
    });
    if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) throw new Error('Resolved remote job args are not an object.');
    const principal: ToolPrincipal = {
      id: `remote-worker:${leaseInfo.workerId}`,
      role: 'agent',
      authMode: 'token',
    };
    const result = await options.registry.callAgent(
      lease.job.tool,
      resolved as Record<string, unknown>,
      { principal, signal: controller.signal },
    );
    if (heartbeatFailure) throw heartbeatFailure;

    const resultBytes = resultPayload(result, options.container);
    const uploaded = await requestJson(base, options.token, 'POST', `/v1/jobs/${lease.job.id}/artifacts`, {
      leaseId: leaseInfo.id,
      fencingToken: leaseInfo.fencingToken,
      data: resultBytes.toString('base64'),
      mimeType: 'application/json',
      label: `Signed remote result for ${lease.job.tool}`,
    }, controller.signal);
    const artifact = uploaded.artifact as { id?: unknown } | undefined;
    if (!artifact || typeof artifact.id !== 'string') throw new Error('Coordinator did not return an output artifact id.');

    const evidence: DistributedWorkerEvidence = {
      schemaVersion: 1,
      jobId: lease.job.id,
      leaseId: leaseInfo.id,
      fencingToken: leaseInfo.fencingToken,
      workerId: leaseInfo.workerId,
      tool: lease.job.tool,
      argsDigest: lease.job.argsDigest,
      resultDigest: sha256(resultBytes),
      resultOk: result.ok,
      ...(result.error ? { resultSummary: options.container.policy.secret.redact(result.error).slice(0, 2_000) } : {}),
      inputArtifacts: lease.job.inputArtifacts,
      outputArtifacts: [artifact.id],
      sandboxEvidence: {
        mode: 'remote',
        policyDigest: sha256(canonicalJson({
          policyMode: options.container.policy.getMode(),
          allowedTools: [...allowlist].sort(),
        })),
        workerVersion: options.workerVersion,
        platform: `${process.platform}-${process.arch}`,
      },
      completedAt: Date.now(),
    };
    const workerSignature = signDistributedEvidence(evidence, options.privateKeyPem);
    const completion = await requestJson(base, options.token, 'POST', `/v1/jobs/${lease.job.id}/complete`, {
      evidence,
      workerSignature,
    }, controller.signal);
    const job = completion.job as { state?: unknown } | undefined;
    return {
      leased: true,
      jobId: lease.job.id,
      ...(typeof job?.state === 'string' ? { state: job.state } : {}),
      resultOk: result.ok,
    };
  } catch (error) {
    try {
      await requestJson(base, options.token, 'POST', `/v1/jobs/${lease.job.id}/fail`, {
        leaseId: leaseInfo.id,
        fencingToken: leaseInfo.fencingToken,
        reason: options.container.policy.secret.redact(error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      });
    } catch {
      // Preserve the primary worker failure; coordinator recovery handles an expired lease.
    }
    throw error;
  } finally {
    clearInterval(timer);
    controller.abort();
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}
