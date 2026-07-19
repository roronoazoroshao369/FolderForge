import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../src/core/types.js';
import { distributedTools } from '../../src/tools/distributed-tools.js';

function context(distributed: Record<string, unknown>): ToolContext {
  return {
    projectRoot: '/tmp/project',
    config: {} as ToolContext['config'],
    container: { distributed },
  } as ToolContext;
}

function tool(name: string) {
  const found = distributedTools().find((item) => item.name === name);
  if (!found) throw new Error(`Missing distributed tool ${name}`);
  return found;
}

describe('distributed tool governance surface', () => {
  it('routes every agent-visible operation to the coordinator with normalized arguments', async () => {
    const distributed = {
      stats: vi.fn(() => ({ jobs: { queued: 1 } })),
      submitJob: vi.fn(() => ({ job: { id: 'job_1234567890abcdef' }, duplicate: false })),
      getJob: vi.fn(() => ({ id: 'job_1234567890abcdef' })),
      listJobs: vi.fn(() => [{ id: 'job_1234567890abcdef' }]),
      cancelJob: vi.fn(() => ({ state: 'cancelled' })),
      retryBlocked: vi.fn(() => ({ state: 'queued' })),
      verifyCompletion: vi.fn(() => ({ valid: true })),
    };
    const ctx = context(distributed);

    expect(await tool('distributed_status').handler({}, ctx)).toMatchObject({ ok: true });
    expect(await tool('distributed_job_submit').handler({
      tool: 'run_test',
      args: { command: 'npm test' },
      idempotencyKey: 'key-1',
      replayPolicy: 'idempotent',
      requiredCapabilities: ['node22'],
      inputArtifacts: [`art_${'a'.repeat(64)}`],
    }, ctx)).toMatchObject({ ok: true });
    expect(distributed.submitJob).toHaveBeenCalledWith({
      tool: 'run_test',
      args: { command: 'npm test' },
      idempotencyKey: 'key-1',
      replayPolicy: 'idempotent',
      requiredCapabilities: ['node22'],
      inputArtifacts: [`art_${'a'.repeat(64)}`],
    });
    expect(await tool('distributed_job_status').handler({ id: 'job_1234567890abcdef' }, ctx)).toMatchObject({ ok: true });
    expect(await tool('distributed_job_list').handler({ limit: 10 }, ctx)).toMatchObject({ ok: true, data: { jobs: expect.any(Array) } });
    expect(await tool('distributed_job_cancel').handler({ id: 'job_1234567890abcdef', reason: 'operator' }, ctx)).toMatchObject({ ok: true });
    expect(await tool('distributed_job_retry').handler({ id: 'job_1234567890abcdef' }, ctx)).toMatchObject({ ok: true });
    expect(await tool('distributed_completion_verify').handler({ id: 'job_1234567890abcdef' }, ctx)).toMatchObject({ ok: true, data: { valid: true } });
  });

  it('routes every admin/worker operation and preserves token/lease/evidence arguments', async () => {
    const distributed = {
      recoverExpiredLeases: vi.fn(() => ({ requeued: [], blocked: [] })),
      registerWorker: vi.fn(() => ({ worker: { id: 'wrk_123456789abc' }, token: 'token' })),
      rotateWorkerToken: vi.fn(() => ({ worker: { id: 'wrk_123456789abc' }, token: 'token2' })),
      revokeWorker: vi.fn(() => ({ state: 'revoked' })),
      listWorkers: vi.fn(() => [{ id: 'wrk_123456789abc' }]),
      leaseJob: vi.fn(() => null),
      acknowledgeJob: vi.fn(() => ({ state: 'running' })),
      heartbeat: vi.fn(() => ({ state: 'running' })),
      completeJob: vi.fn(() => ({ state: 'completed' })),
      failJob: vi.fn(() => ({ state: 'failed' })),
    };
    const ctx = context(distributed);
    const evidence = { schemaVersion: 1, jobId: 'job_1234567890abcdef' };

    expect(await tool('distributed_recover').handler({}, ctx)).toMatchObject({ ok: true });
    expect(await tool('distributed_worker_register').handler({
      name: 'worker', publicKeyPem: 'pem', capabilities: ['node'], tokenTtlMs: 5000,
    }, ctx)).toMatchObject({ ok: true });
    expect(distributed.registerWorker).toHaveBeenCalledWith({ name: 'worker', publicKeyPem: 'pem', capabilities: ['node'], tokenTtlMs: 5000 });
    expect(await tool('distributed_worker_rotate').handler({ id: 'wrk_123456789abc', tokenTtlMs: 5000 }, ctx)).toMatchObject({ ok: true });
    expect(await tool('distributed_worker_revoke').handler({ id: 'wrk_123456789abc', reason: 'incident' }, ctx)).toMatchObject({ ok: true });
    expect(await tool('distributed_worker_list').handler({}, ctx)).toMatchObject({ ok: true, data: { workers: expect.any(Array) } });
    expect(await tool('distributed_worker_lease').handler({ token: 'token', leaseTtlMs: 5000 }, ctx)).toMatchObject({ ok: true, data: { lease: null } });
    expect(await tool('distributed_worker_ack').handler({ token: 'token', jobId: 'job_1234567890abcdef', leaseId: 'lease', fencingToken: 1 }, ctx)).toMatchObject({ ok: true });
    expect(await tool('distributed_worker_heartbeat').handler({ token: 'token', jobId: 'job_1234567890abcdef', leaseId: 'lease', fencingToken: 1, leaseTtlMs: 5000 }, ctx)).toMatchObject({ ok: true });
    expect(await tool('distributed_worker_complete').handler({ token: 'token', evidence, workerSignature: 'sig' }, ctx)).toMatchObject({ ok: true });
    expect(distributed.completeJob).toHaveBeenCalledWith({ token: 'token', evidence, workerSignature: 'sig' });
    expect(await tool('distributed_worker_fail').handler({ token: 'token', jobId: 'job_1234567890abcdef', leaseId: 'lease', fencingToken: 1, reason: 'failed' }, ctx)).toMatchObject({ ok: true });
  });

  it('returns bounded tool errors when coordinator methods reject', async () => {
    const error = new Error('coordinator rejected request');
    const distributed = Object.fromEntries([
      'submitJob', 'getJob', 'cancelJob', 'retryBlocked', 'verifyCompletion',
      'registerWorker', 'rotateWorkerToken', 'revokeWorker', 'leaseJob',
      'acknowledgeJob', 'heartbeat', 'completeJob', 'failJob',
    ].map((name) => [name, vi.fn(() => { throw error; })]));
    const ctx = context(distributed);
    const cases: Array<[string, Record<string, unknown>]> = [
      ['distributed_job_submit', { tool: 'x', args: {} }],
      ['distributed_job_status', { id: 'bad' }],
      ['distributed_job_cancel', { id: 'bad' }],
      ['distributed_job_retry', { id: 'bad' }],
      ['distributed_completion_verify', { id: 'bad' }],
      ['distributed_worker_register', { name: 'x', publicKeyPem: 'bad' }],
      ['distributed_worker_rotate', { id: 'bad' }],
      ['distributed_worker_revoke', { id: 'bad' }],
      ['distributed_worker_lease', { token: 'bad' }],
      ['distributed_worker_ack', { token: 'bad', jobId: 'bad', leaseId: 'bad', fencingToken: 1 }],
      ['distributed_worker_heartbeat', { token: 'bad', jobId: 'bad', leaseId: 'bad', fencingToken: 1 }],
      ['distributed_worker_complete', { token: 'bad', evidence: {}, workerSignature: 'bad' }],
      ['distributed_worker_fail', { token: 'bad', jobId: 'bad', leaseId: 'bad', fencingToken: 1, reason: 'bad' }],
    ];
    for (const [name, args] of cases) {
      await expect(tool(name).handler(args, ctx)).resolves.toMatchObject({ ok: false, error: 'coordinator rejected request' });
    }
  });
});
