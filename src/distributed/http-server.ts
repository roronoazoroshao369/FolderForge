import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Server } from 'node:http';
import type { DistributedCoordinator, DistributedWorkerEvidence } from './coordinator.js';
import type { ArtifactStore } from '../artifacts/artifact-store.js';
import type { AuditLog } from '../audit/audit-log.js';

export interface DistributedHttpServerOptions {
  host: string;
  port: number;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY = 8 * 1024 * 1024;
const ARTIFACT_ID = /^art_[a-f0-9]{64}$/;
const JOB_ID = /^job_[a-f0-9]{16}$/;

function isLoopback(host: string): boolean {
  return ['127.0.0.1', '::1', 'localhost'].includes(host);
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !/^Bearer\s+/i.test(header)) {
    throw Object.assign(new Error('Worker bearer token required.'), { statusCode: 401 });
  }
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw Object.assign(new Error('Worker bearer token required.'), { statusCode: 401 });
  return token;
}

async function jsonBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw Object.assign(new Error(`Request body exceeds ${maxBytes} bytes.`), { statusCode: 413 });
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON body must be an object.');
    return value as Record<string, unknown>;
  } catch (error) {
    throw Object.assign(new Error(`Invalid JSON body: ${String(error)}`), { statusCode: 400 });
  }
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function routeMatch(pathname: string, suffix: string): { jobId: string } | null {
  const match = new RegExp(`^/v1/jobs/(job_[a-f0-9]{16})/${suffix}$`).exec(pathname);
  return match ? { jobId: match[1]! } : null;
}

export async function startDistributedHttpServer(
  coordinator: DistributedCoordinator,
  artifacts: ArtifactStore,
  audit: AuditLog,
  options: DistributedHttpServerOptions,
): Promise<Server> {
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error('Distributed server port must be 0-65535.');
  }
  const hasTls = Boolean(options.tlsCertPath && options.tlsKeyPath);
  if (Boolean(options.tlsCertPath) !== Boolean(options.tlsKeyPath)) {
    throw new Error('Distributed server TLS requires both certificate and private key paths.');
  }
  if (!isLoopback(options.host) && !hasTls) {
    throw new Error('Non-loopback distributed worker transport requires TLS.');
  }
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const run = async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://folderforge.invalid');
      const pathname = url.pathname;
      if (req.method === 'GET' && pathname === '/healthz') {
        writeJson(res, 200, { ok: true, service: 'folderforge-distributed' });
        return;
      }
      const token = bearer(req);

      if (req.method === 'POST' && pathname === '/v1/lease') {
        const body = await jsonBody(req, maxBody);
        const lease = coordinator.leaseJob(token, Number(body.leaseTtlMs ?? 60_000));
        audit.record({ type: 'process_event', tool: 'distributed_worker_lease', ok: true, summary: lease ? `leased ${lease.job.id}` : 'no compatible job' });
        writeJson(res, 200, { ok: true, lease });
        return;
      }

      const ack = routeMatch(pathname, 'ack');
      if (req.method === 'POST' && ack) {
        const body = await jsonBody(req, maxBody);
        const job = coordinator.acknowledgeJob(token, ack.jobId, String(body.leaseId ?? ''), Number(body.fencingToken));
        audit.record({ type: 'process_event', tool: 'distributed_worker_ack', ok: true, summary: `acknowledged ${job.id}` });
        writeJson(res, 200, { ok: true, job });
        return;
      }

      const heartbeat = routeMatch(pathname, 'heartbeat');
      if (req.method === 'POST' && heartbeat) {
        const body = await jsonBody(req, maxBody);
        const job = coordinator.heartbeat(
          token,
          heartbeat.jobId,
          String(body.leaseId ?? ''),
          Number(body.fencingToken),
          Number(body.leaseTtlMs ?? 60_000),
        );
        writeJson(res, 200, { ok: true, job });
        return;
      }

      const complete = routeMatch(pathname, 'complete');
      if (req.method === 'POST' && complete) {
        const body = await jsonBody(req, maxBody);
        const evidence = body.evidence as DistributedWorkerEvidence;
        if (!evidence || evidence.jobId !== complete.jobId) throw Object.assign(new Error('Completion evidence job id mismatch.'), { statusCode: 400 });
        const job = coordinator.completeJob({ token, evidence, workerSignature: String(body.workerSignature ?? '') });
        audit.record({
          type: job.state === 'completed' ? 'tool_result' : 'tool_error',
          tool: `distributed:${job.tool}`,
          ok: job.state === 'completed',
          summary: `${job.id} ${job.state}`,
          detail: { workerId: evidence.workerId, fencingToken: evidence.fencingToken, resultDigest: evidence.resultDigest },
        });
        writeJson(res, 200, { ok: true, job });
        return;
      }

      const fail = routeMatch(pathname, 'fail');
      if (req.method === 'POST' && fail) {
        const body = await jsonBody(req, maxBody);
        const job = coordinator.failJob(token, fail.jobId, String(body.leaseId ?? ''), Number(body.fencingToken), String(body.reason ?? 'Worker failed.'));
        audit.record({ type: 'tool_error', tool: `distributed:${job.tool}`, ok: false, summary: `${job.id} failed`, detail: { failure: job.failure } });
        writeJson(res, 200, { ok: true, job });
        return;
      }

      const artifactGet = /^\/v1\/jobs\/(job_[a-f0-9]{16})\/artifacts\/(art_[a-f0-9]{64})$/.exec(pathname);
      if (req.method === 'GET' && artifactGet) {
        const jobId = artifactGet[1]!;
        const artifactId = artifactGet[2]!;
        const leaseId = url.searchParams.get('leaseId') ?? '';
        const fencingToken = Number(url.searchParams.get('fencingToken'));
        const job = coordinator.authorizeLease(token, jobId, leaseId, fencingToken);
        if (!job.inputArtifacts.includes(artifactId)) throw Object.assign(new Error('Artifact is not an input of this job.'), { statusCode: 403 });
        const { metadata, data } = artifacts.read(artifactId);
        res.writeHead(200, {
          'content-type': metadata.mimeType,
          'content-length': String(data.byteLength),
          'cache-control': 'no-store',
          'x-folderforge-artifact-id': artifactId,
          'x-content-type-options': 'nosniff',
        });
        res.end(data);
        return;
      }

      const artifactPut = routeMatch(pathname, 'artifacts');
      if (req.method === 'POST' && artifactPut) {
        const body = await jsonBody(req, maxBody);
        coordinator.authorizeLease(token, artifactPut.jobId, String(body.leaseId ?? ''), Number(body.fencingToken));
        const encoded = String(body.data ?? '');
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
          throw Object.assign(new Error('Artifact data must be canonical base64.'), { statusCode: 400 });
        }
        const artifact = artifacts.put(Buffer.from(encoded, 'base64'), String(body.mimeType ?? 'application/octet-stream'), {
          sourceTool: 'distributed_worker_output',
          label: typeof body.label === 'string' ? body.label : `Output for ${artifactPut.jobId}`,
        });
        coordinator.recordOutputArtifact(
          token,
          artifactPut.jobId,
          String(body.leaseId ?? ''),
          Number(body.fencingToken),
          artifact.id,
        );
        audit.record({ type: 'process_event', tool: 'distributed_artifact_put', ok: true, summary: `${artifactPut.jobId} ${artifact.id}`, detail: { bytes: artifact.bytes, mimeType: artifact.mimeType } });
        writeJson(res, 201, { ok: true, artifact });
        return;
      }

      writeJson(res, 404, { ok: false, error: 'not_found' });
    };

    void run().catch((error) => {
      const status = typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? Number((error as { statusCode: number }).statusCode)
        : /token|revoked|expired|signature/i.test(String(error)) ? 401 : 400;
      audit.record({ type: 'process_event', tool: 'distributed_http', ok: false, summary: `HTTP ${status}: ${error instanceof Error ? error.message : String(error)}` });
      if (!res.headersSent) writeJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
      else res.end();
    });
  };

  const server = hasTls
    ? createHttpsServer({ cert: readFileSync(options.tlsCertPath!), key: readFileSync(options.tlsKeyPath!) }, handler)
    : createHttpServer(handler);
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  return server;
}
