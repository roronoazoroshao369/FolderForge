import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { startDistributedHttpServer } from '../../src/distributed/http-server.js';
import { runRemoteWorkerOnce } from '../../src/distributed/worker-runtime.js';
import { buildRegistry } from '../../src/tools/index.js';

function keys(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

describe('remote distributed worker transport', () => {
  let root: string;
  let coordinator: Container;
  let worker: Container;
  let server: Awaited<ReturnType<typeof startDistributedHttpServer>> | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'folderforge-remote-worker-'));
    const coordinatorConfig = defaultConfig(root);
    coordinatorConfig.policy.defaultMode = 'dev';
    coordinator = new Container(coordinatorConfig);
    const workerConfig = defaultConfig(root);
    workerConfig.policy.defaultMode = 'dev';
    worker = new Container(workerConfig);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    rmSync(root, { recursive: true, force: true });
  });

  it('downloads input artifacts, executes an allowlisted tool, and verifies signed output evidence', async () => {
    server = await startDistributedHttpServer(
      coordinator.distributed,
      coordinator.artifacts,
      coordinator.audit,
      { host: '127.0.0.1', port: 0 },
    );
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('Missing test server address.');
    const keypair = keys();
    const registration = coordinator.distributed.registerWorker({
      name: 'integration-worker',
      capabilities: ['filesystem'],
      publicKeyPem: keypair.publicKeyPem,
      tokenTtlMs: 60_000,
    });
    const input = coordinator.artifacts.put(Buffer.from('hello from coordinator\n'), 'text/plain', {
      sourceTool: 'distributed-test',
    });
    const submitted = coordinator.distributed.submitJob({
      tool: 'file_read',
      args: { path: { $artifact: input.id, filename: 'remote-input.txt' } },
      inputArtifacts: [input.id],
      requiredCapabilities: ['filesystem'],
      replayPolicy: 'idempotent',
    }).job;

    const iteration = await runRemoteWorkerOnce({
      coordinatorUrl: `http://127.0.0.1:${address.port}`,
      token: registration.token,
      privateKeyPem: keypair.privateKeyPem,
      allowedTools: ['file_read'],
      projectRoot: root,
      workerVersion: 'test',
      container: worker,
      registry: buildRegistry(worker),
      leaseTtlMs: 10_000,
      heartbeatMs: 2_000,
    });

    expect(iteration).toMatchObject({ leased: true, jobId: submitted.id, state: 'completed', resultOk: true });
    const verified = coordinator.distributed.verifyCompletion(submitted.id);
    expect(verified).toMatchObject({ valid: true, workerValid: true, coordinatorValid: true, job: { state: 'completed' } });
    const outputId = verified.job.completion!.evidence.outputArtifacts[0]!;
    const output = coordinator.artifacts.read(outputId).data.toString('utf8');
    expect(output).toContain('hello from coordinator');
    expect(coordinator.audit.recent(20).some((event) => event.tool === 'distributed:file_read' && event.ok === true)).toBe(true);
  });

  it('fails closed when a remote job is outside the worker allowlist/control-plane boundary', async () => {
    server = await startDistributedHttpServer(coordinator.distributed, coordinator.artifacts, coordinator.audit, { host: '127.0.0.1', port: 0 });
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('Missing test server address.');
    const keypair = keys();
    const registration = coordinator.distributed.registerWorker({ name: 'restricted-worker', capabilities: [], publicKeyPem: keypair.publicKeyPem, tokenTtlMs: 60_000 });
    const job = coordinator.distributed.submitJob({ tool: 'distributed_status', args: {}, replayPolicy: 'no-replay' }).job;

    await expect(runRemoteWorkerOnce({
      coordinatorUrl: `http://127.0.0.1:${address.port}`,
      token: registration.token,
      privateKeyPem: keypair.privateKeyPem,
      allowedTools: ['distributed_status'],
      projectRoot: root,
      workerVersion: 'test',
      container: worker,
      registry: buildRegistry(worker),
      leaseTtlMs: 10_000,
      heartbeatMs: 2_000,
    })).rejects.toThrow(/recursion is forbidden/);
    expect(coordinator.distributed.getJob(job.id)).toMatchObject({ state: 'failed', failure: expect.stringContaining('recursion is forbidden') });
  });

  it('requires TLS for non-loopback binds', async () => {
    await expect(startDistributedHttpServer(coordinator.distributed, coordinator.artifacts, coordinator.audit, {
      host: '0.0.0.0',
      port: 0,
    })).rejects.toThrow(/requires TLS/);
  });
});
