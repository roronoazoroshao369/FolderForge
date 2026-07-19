import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DistributedCoordinator,
  canonicalJson,
  sha256,
  signDistributedEvidence,
  type DistributedWorkerEvidence,
} from '../../src/distributed/coordinator.js';

function workerKeys(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

describe('distributed coordinator', () => {
  let root: string;
  let now: number;
  let coordinator: DistributedCoordinator;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'folderforge-distributed-'));
    now = 1_800_000_000_000;
    coordinator = new DistributedCoordinator(root, {
      now: () => now,
      artifactExists: (id) => /^art_[a-f0-9]{64}$/.test(id),
      maxLeaseTtlMs: 10_000,
      maxTokenTtlMs: 60_000,
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('leases with monotonic fencing and accepts doubly-signed completion evidence', () => {
    const keys = workerKeys();
    const registration = coordinator.registerWorker({
      name: 'linux-worker',
      capabilities: ['node22', 'docker'],
      publicKeyPem: keys.publicKeyPem,
      tokenTtlMs: 30_000,
    });
    const inputArtifact = `art_${'1'.repeat(64)}`;
    const outputArtifact = `art_${'2'.repeat(64)}`;
    const submission = coordinator.submitJob({
      tool: 'run_test',
      args: { command: 'npm test' },
      idempotencyKey: 'test-job-1',
      replayPolicy: 'idempotent',
      requiredCapabilities: ['node22'],
      inputArtifacts: [inputArtifact],
    });
    expect(submission.duplicate).toBe(false);
    expect(coordinator.submitJob({
      tool: 'run_test',
      args: { command: 'npm test' },
      idempotencyKey: 'test-job-1',
      replayPolicy: 'idempotent',
      requiredCapabilities: ['node22'],
      inputArtifacts: [inputArtifact],
    })).toMatchObject({ duplicate: true, job: { id: submission.job.id } });

    const lease = coordinator.leaseJob(registration.token, 5_000)!;
    expect(lease.payload).toEqual({ tool: 'run_test', args: { command: 'npm test' } });
    expect(lease.job.lease?.fencingToken).toBe(1);
    const acknowledged = coordinator.acknowledgeJob(
      registration.token,
      lease.job.id,
      lease.job.lease!.id,
      lease.job.lease!.fencingToken,
    );
    expect(acknowledged.state).toBe('running');

    const evidence: DistributedWorkerEvidence = {
      schemaVersion: 1,
      jobId: lease.job.id,
      leaseId: lease.job.lease!.id,
      fencingToken: lease.job.lease!.fencingToken,
      workerId: registration.worker.id,
      tool: lease.job.tool,
      argsDigest: lease.job.argsDigest,
      resultDigest: sha256(canonicalJson({ ok: true, tests: 525 })),
      resultOk: true,
      inputArtifacts: [inputArtifact],
      outputArtifacts: [outputArtifact],
      sandboxEvidence: {
        mode: 'docker',
        policyDigest: '3'.repeat(64),
        imageDigest: 'sha256:' + '4'.repeat(64),
        network: 'none',
        readOnlyRoot: true,
        workerVersion: '2.5.0',
        platform: 'linux-x64',
      },
      completedAt: now,
    };
    const workerSignature = signDistributedEvidence(evidence, keys.privateKeyPem);
    expect(() => coordinator.completeJob({
      token: registration.token,
      evidence,
      workerSignature,
    })).toThrow(/not uploaded by the active lease/);
    coordinator.recordOutputArtifact(
      registration.token,
      lease.job.id,
      lease.job.lease!.id,
      lease.job.lease!.fencingToken,
      outputArtifact,
    );
    const completed = coordinator.completeJob({ token: registration.token, evidence, workerSignature });
    expect(completed).toMatchObject({ state: 'completed', completion: { evidence, workerSignature } });
    expect(coordinator.verifyCompletion(completed.id)).toMatchObject({
      valid: true,
      workerValid: true,
      coordinatorValid: true,
    });
    expect(coordinator.stats()).toMatchObject({ jobs: { completed: 1 }, nextFencingToken: 1 });
  });

  it('blocks unknown no-replay work after an acknowledged lease expires', () => {
    const keys = workerKeys();
    const worker = coordinator.registerWorker({
      name: 'no-replay-worker',
      capabilities: [],
      publicKeyPem: keys.publicKeyPem,
      tokenTtlMs: 30_000,
    });
    const job = coordinator.submitJob({
      tool: 'git_push',
      args: { remote: 'origin' },
      replayPolicy: 'no-replay',
    }).job;
    const lease = coordinator.leaseJob(worker.token, 2_000)!;
    coordinator.acknowledgeJob(worker.token, job.id, lease.job.lease!.id, 1);
    now += 2_001;
    expect(coordinator.recoverExpiredLeases()).toEqual({ requeued: [], blocked: [job.id] });
    expect(coordinator.getJob(job.id)).toMatchObject({
      state: 'blocked',
      blockedReason: expect.stringContaining('replayPolicy=no-replay'),
    });
  });

  it('requeues idempotent work and rejects a stale fencing token', () => {
    const firstKeys = workerKeys();
    const first = coordinator.registerWorker({
      name: 'worker-a',
      capabilities: ['tests'],
      publicKeyPem: firstKeys.publicKeyPem,
      tokenTtlMs: 30_000,
    });
    const job = coordinator.submitJob({
      tool: 'run_test',
      args: {},
      replayPolicy: 'idempotent',
      requiredCapabilities: ['tests'],
    }).job;
    const firstLease = coordinator.leaseJob(first.token, 2_000)!;
    coordinator.acknowledgeJob(first.token, job.id, firstLease.job.lease!.id, 1);
    now += 2_001;
    expect(coordinator.recoverExpiredLeases()).toEqual({ requeued: [job.id], blocked: [] });

    const secondKeys = workerKeys();
    const second = coordinator.registerWorker({
      name: 'worker-b',
      capabilities: ['tests'],
      publicKeyPem: secondKeys.publicKeyPem,
      tokenTtlMs: 30_000,
    });
    const secondLease = coordinator.leaseJob(second.token, 5_000)!;
    expect(secondLease.job.lease?.fencingToken).toBe(2);
    expect(() => coordinator.acknowledgeJob(
      first.token,
      job.id,
      firstLease.job.lease!.id,
      1,
    )).toThrow(/Stale|mismatched|no active lease/);
  });

  it('rotates and revokes short-lived worker identity', () => {
    const keys = workerKeys();
    const initial = coordinator.registerWorker({
      name: 'rotating-worker',
      capabilities: [],
      publicKeyPem: keys.publicKeyPem,
      tokenTtlMs: 5_000,
    });
    const rotated = coordinator.rotateWorkerToken(initial.worker.id, 5_000);
    expect(() => coordinator.leaseJob(initial.token)).toThrow(/rotated|revoked/);
    expect(coordinator.leaseJob(rotated.token)).toBeNull();
    coordinator.revokeWorker(initial.worker.id, 'compromised');
    expect(() => coordinator.leaseJob(rotated.token)).toThrow(/revoked/);
    expect(coordinator.listWorkers()[0]).toMatchObject({ state: 'revoked', revokeReason: 'compromised' });
  });
});
