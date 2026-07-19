import type { ToolDefinition, ToolResult } from '../core/types.js';
import type { DistributedWorkerEvidence } from '../distributed/coordinator.js';
import { defineTool } from './registry.js';

function fail(error: unknown): ToolResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

const objectOutput = { type: 'object', additionalProperties: true } as const;

export function distributedTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'distributed_status',
      description: 'Read durable coordinator worker/job counts and the coordinator signing-key fingerprint.',
      group: 'distributed',
      mutates: false,
      risk: 'LOW',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: objectOutput,
      handler: async (_args, ctx) => ({ ok: true, data: ctx.container.distributed.stats() }),
    }),
    defineTool({
      name: 'distributed_job_submit',
      description: 'Submit an encrypted durable job with an idempotency key, artifact inputs, required capabilities, and explicit replay policy.',
      group: 'distributed',
      mutates: true,
      risk: 'MEDIUM',
      inputSchema: {
        type: 'object',
        properties: {
          tool: { type: 'string' },
          args: { type: 'object', additionalProperties: true },
          idempotencyKey: { type: 'string', maxLength: 256 },
          replayPolicy: { type: 'string', enum: ['idempotent', 'no-replay'], default: 'no-replay' },
          requiredCapabilities: { type: 'array', maxItems: 32, items: { type: 'string' } },
          inputArtifacts: { type: 'array', maxItems: 64, items: { type: 'string', pattern: '^art_[a-f0-9]{64}$' } },
        },
        required: ['tool', 'args'],
      },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try {
          return {
            ok: true,
            data: ctx.container.distributed.submitJob({
              tool: String(args.tool ?? ''),
              args: (args.args ?? {}) as Record<string, unknown>,
              ...(typeof args.idempotencyKey === 'string' ? { idempotencyKey: args.idempotencyKey } : {}),
              ...(typeof args.replayPolicy === 'string'
                ? { replayPolicy: args.replayPolicy as 'idempotent' | 'no-replay' }
                : {}),
              ...(Array.isArray(args.requiredCapabilities)
                ? { requiredCapabilities: args.requiredCapabilities.map(String) }
                : {}),
              ...(Array.isArray(args.inputArtifacts)
                ? { inputArtifacts: args.inputArtifacts.map(String) }
                : {}),
            }),
          };
        } catch (error) {
          return fail(error);
        }
      },
    }),
    defineTool({
      name: 'distributed_job_status',
      description: 'Read one distributed job without exposing its encrypted argument payload.',
      group: 'distributed',
      mutates: false,
      risk: 'LOW',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try { return { ok: true, data: ctx.container.distributed.getJob(String(args.id ?? '')) }; }
        catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'distributed_job_list',
      description: 'List recent durable distributed jobs without decrypted payloads.',
      group: 'distributed',
      mutates: false,
      risk: 'LOW',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 1000 } } },
      outputSchema: objectOutput,
      handler: async (args, ctx) => ({
        ok: true,
        data: { jobs: ctx.container.distributed.listJobs(Number(args.limit ?? 100)) },
      }),
    }),
    defineTool({
      name: 'distributed_job_cancel',
      description: 'Cancel a non-terminal distributed job; stale worker completions are rejected by lease and fencing checks.',
      group: 'distributed',
      mutates: true,
      risk: 'HIGH',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, reason: { type: 'string', maxLength: 2000 } },
        required: ['id'],
      },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try {
          return { ok: true, data: ctx.container.distributed.cancelJob(String(args.id ?? ''), String(args.reason ?? 'Cancelled by operator.')) };
        } catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'distributed_job_retry',
      description: 'Requeue a blocked job only when its replay policy is explicitly idempotent.',
      group: 'distributed',
      mutates: true,
      risk: 'HIGH',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try { return { ok: true, data: ctx.container.distributed.retryBlocked(String(args.id ?? '')) }; }
        catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'distributed_completion_verify',
      description: 'Verify both the worker signature and coordinator acceptance signature for a completed job.',
      group: 'distributed',
      mutates: false,
      risk: 'LOW',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try { return { ok: true, data: ctx.container.distributed.verifyCompletion(String(args.id ?? '')) }; }
        catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'distributed_recover',
      description: 'Recover expired leases: requeue safe/idempotent work and block acknowledged no-replay work with unknown side effects.',
      group: 'distributed',
      audience: 'admin',
      mutates: true,
      risk: 'MEDIUM',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: objectOutput,
      handler: async (_args, ctx) => ({ ok: true, data: ctx.container.distributed.recoverExpiredLeases() }),
    }),
    defineTool({
      name: 'distributed_worker_register',
      description: 'Register an Ed25519 worker identity and return one short-lived bearer token exactly once.',
      group: 'distributed',
      audience: 'admin',
      mutates: true,
      risk: 'HIGH',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 128 },
          capabilities: { type: 'array', maxItems: 32, items: { type: 'string' } },
          publicKeyPem: { type: 'string', maxLength: 16384 },
          tokenTtlMs: { type: 'integer', minimum: 1000, maximum: 900000 },
        },
        required: ['name', 'publicKeyPem'],
      },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try {
          return {
            ok: true,
            data: ctx.container.distributed.registerWorker({
              name: String(args.name ?? ''),
              publicKeyPem: String(args.publicKeyPem ?? ''),
              ...(Array.isArray(args.capabilities) ? { capabilities: args.capabilities.map(String) } : {}),
              ...(typeof args.tokenTtlMs === 'number' ? { tokenTtlMs: args.tokenTtlMs } : {}),
            }),
          };
        } catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'distributed_worker_rotate',
      description: 'Invalidate the previous worker token and issue a new short-lived token.',
      group: 'distributed',
      audience: 'admin',
      mutates: true,
      risk: 'HIGH',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, tokenTtlMs: { type: 'integer', minimum: 1000, maximum: 900000 } },
        required: ['id'],
      },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try { return { ok: true, data: ctx.container.distributed.rotateWorkerToken(String(args.id ?? ''), Number(args.tokenTtlMs ?? 900000)) }; }
        catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'distributed_worker_revoke',
      description: 'Revoke a worker identity and recover or block any active lease according to replay policy.',
      group: 'distributed',
      audience: 'admin',
      mutates: true,
      risk: 'HIGH',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, reason: { type: 'string', maxLength: 512 } },
        required: ['id'],
      },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try { return { ok: true, data: ctx.container.distributed.revokeWorker(String(args.id ?? ''), String(args.reason ?? 'Revoked by operator.')) }; }
        catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'distributed_worker_list',
      description: 'List registered worker identities and revocation/token-expiry metadata without bearer tokens or public-key material.',
      group: 'distributed',
      audience: 'admin',
      mutates: false,
      risk: 'LOW',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: objectOutput,
      handler: async (_args, ctx) => ({ ok: true, data: { workers: ctx.container.distributed.listWorkers() } }),
    }),
    defineTool({
      name: 'distributed_worker_lease',
      description: 'Worker control-plane operation: authenticate a short-lived token and lease one capability-compatible job.',
      group: 'distributed',
      audience: 'admin',
      mutates: true,
      risk: 'MEDIUM',
      inputSchema: {
        type: 'object',
        properties: { token: { type: 'string' }, leaseTtlMs: { type: 'integer', minimum: 1000, maximum: 60000 } },
        required: ['token'],
      },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try { return { ok: true, data: { lease: ctx.container.distributed.leaseJob(String(args.token ?? ''), Number(args.leaseTtlMs ?? 60000)) } }; }
        catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'distributed_worker_ack',
      description: 'Worker control-plane operation: acknowledge execution before side effects begin.',
      group: 'distributed',
      audience: 'admin',
      mutates: true,
      risk: 'MEDIUM',
      inputSchema: {
        type: 'object',
        properties: { token: { type: 'string' }, jobId: { type: 'string' }, leaseId: { type: 'string' }, fencingToken: { type: 'integer' } },
        required: ['token', 'jobId', 'leaseId', 'fencingToken'],
      },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try { return { ok: true, data: ctx.container.distributed.acknowledgeJob(String(args.token ?? ''), String(args.jobId ?? ''), String(args.leaseId ?? ''), Number(args.fencingToken)) }; }
        catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'distributed_worker_heartbeat',
      description: 'Worker control-plane operation: renew only the exact current lease and fencing token.',
      group: 'distributed',
      audience: 'admin',
      mutates: true,
      risk: 'MEDIUM',
      inputSchema: {
        type: 'object',
        properties: {
          token: { type: 'string' }, jobId: { type: 'string' }, leaseId: { type: 'string' }, fencingToken: { type: 'integer' }, leaseTtlMs: { type: 'integer', minimum: 1000, maximum: 60000 },
        },
        required: ['token', 'jobId', 'leaseId', 'fencingToken'],
      },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try { return { ok: true, data: ctx.container.distributed.heartbeat(String(args.token ?? ''), String(args.jobId ?? ''), String(args.leaseId ?? ''), Number(args.fencingToken), Number(args.leaseTtlMs ?? 60000)) }; }
        catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'distributed_worker_complete',
      description: 'Worker control-plane operation: verify Ed25519 result evidence, artifact hashes, lease and fencing token, then countersign acceptance.',
      group: 'distributed',
      audience: 'admin',
      mutates: true,
      risk: 'MEDIUM',
      inputSchema: {
        type: 'object',
        properties: {
          token: { type: 'string' },
          evidence: { type: 'object', additionalProperties: true },
          workerSignature: { type: 'string' },
        },
        required: ['token', 'evidence', 'workerSignature'],
      },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try {
          return { ok: true, data: ctx.container.distributed.completeJob({ token: String(args.token ?? ''), evidence: args.evidence as DistributedWorkerEvidence, workerSignature: String(args.workerSignature ?? '') }) };
        } catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'distributed_worker_fail',
      description: 'Worker control-plane operation: fail the exact current lease without allowing stale-worker updates.',
      group: 'distributed',
      audience: 'admin',
      mutates: true,
      risk: 'MEDIUM',
      inputSchema: {
        type: 'object',
        properties: { token: { type: 'string' }, jobId: { type: 'string' }, leaseId: { type: 'string' }, fencingToken: { type: 'integer' }, reason: { type: 'string', maxLength: 2000 } },
        required: ['token', 'jobId', 'leaseId', 'fencingToken', 'reason'],
      },
      outputSchema: objectOutput,
      handler: async (args, ctx) => {
        try { return { ok: true, data: ctx.container.distributed.failJob(String(args.token ?? ''), String(args.jobId ?? ''), String(args.leaseId ?? ''), Number(args.fencingToken), String(args.reason ?? 'Worker failed.')) }; }
        catch (error) { return fail(error); }
      },
    }),
  ];
}
