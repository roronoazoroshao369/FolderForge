import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AdapterUnavailableError,
  ChildMcpRegistry,
  type ChildMcpRegistryOptions,
} from '../../src/adapters/child-mcp/registry.js';
import { ChildMcpError } from '../../src/adapters/child-mcp/client.js';

const fixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'diagnostic-mcp-server.mjs'
);

const registries: ChildMcpRegistry[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.stopAllAndWait(100)));
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `${label}-`));
  tempRoots.push(root);
  return root;
}

function registry(
  mode: string,
  args: string[] = [],
  options: ChildMcpRegistryOptions = {}
): ChildMcpRegistry {
  const instance = new ChildMcpRegistry(
    {
      serena: {
        enabled: true,
        command: process.execPath,
        args: [fixture, mode, ...args],
      },
    },
    [],
    options
  );
  registries.push(instance);
  return instance;
}

function launchCount(path: string): number {
  return Number(readFileSync(path, 'utf8'));
}

function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  const text = content?.find((block) => block.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error('Expected a text child MCP result.');
  return text;
}

async function waitForExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  return false;
}

describe('ChildMcpRegistry lifecycle resilience', () => {
  it('single-flights concurrent lazy starts into one child process', async () => {
    const root = tempRoot('folderforge-registry-singleflight');
    const counter = join(root, 'starts.txt');
    const adapters = registry('slow-initialize-counted', [counter]);

    const clients = await Promise.all(
      Array.from({ length: 12 }, () => adapters.ensure('serena'))
    );

    expect(new Set(clients).size).toBe(1);
    expect(launchCount(counter)).toBe(1);
    expect(adapters.status()[0]).toMatchObject({
      state: 'ready',
      ready: true,
      degraded: false,
      startAttempts: 1,
      successfulStarts: 1,
      restartCount: 0,
      consecutiveFailures: 0,
    });
  });

  it('enforces exponential backoff and reconnects on demand after cooldown', async () => {
    const root = tempRoot('folderforge-registry-backoff');
    const counter = join(root, 'starts.txt');
    let now = Date.parse('2026-07-18T12:00:00.000Z');
    const adapters = registry('initialize-fail-until', [counter, '1'], {
      retryBaseMs: 100,
      retryMaxMs: 1_000,
      circuitFailureThreshold: 3,
      circuitOpenMs: 5_000,
      now: () => now,
    });

    await expect(adapters.ensure('serena')).rejects.toBeInstanceOf(ChildMcpError);
    expect(launchCount(counter)).toBe(1);
    expect(adapters.status()[0]).toMatchObject({
      state: 'backoff',
      ready: false,
      degraded: true,
      startAttempts: 1,
      successfulStarts: 0,
      consecutiveFailures: 1,
      nextRetryAt: '2026-07-18T12:00:00.100Z',
    });

    await expect(adapters.ensure('serena')).rejects.toMatchObject({
      name: 'AdapterUnavailableError',
      state: 'backoff',
      retryAt: '2026-07-18T12:00:00.100Z',
    });
    expect(launchCount(counter)).toBe(1);

    now += 100;
    await expect(adapters.ensure('serena')).resolves.toBeDefined();
    expect(launchCount(counter)).toBe(2);
    expect(adapters.status()[0]).toMatchObject({
      state: 'ready',
      ready: true,
      startAttempts: 2,
      successfulStarts: 1,
      restartCount: 1,
      consecutiveFailures: 0,
    });
  });

  it('opens the circuit after repeated failures and allows one half-open recovery', async () => {
    const root = tempRoot('folderforge-registry-circuit');
    const counter = join(root, 'starts.txt');
    let now = Date.parse('2026-07-18T13:00:00.000Z');
    const adapters = registry('initialize-fail-until', [counter, '3'], {
      retryBaseMs: 100,
      retryMaxMs: 1_000,
      circuitFailureThreshold: 3,
      circuitOpenMs: 5_000,
      now: () => now,
    });

    await expect(adapters.ensure('serena')).rejects.toBeInstanceOf(ChildMcpError);
    now += 100;
    await expect(adapters.ensure('serena')).rejects.toBeInstanceOf(ChildMcpError);
    now += 200;
    await expect(adapters.ensure('serena')).rejects.toBeInstanceOf(ChildMcpError);

    expect(launchCount(counter)).toBe(3);
    expect(adapters.status()[0]).toMatchObject({
      state: 'open',
      consecutiveFailures: 3,
      nextRetryAt: '2026-07-18T13:00:05.300Z',
    });

    await expect(adapters.ensure('serena')).rejects.toBeInstanceOf(AdapterUnavailableError);
    expect(launchCount(counter)).toBe(3);

    now += 5_000;
    const recovery = adapters.ensure('serena');
    expect(adapters.status()[0]).toMatchObject({ state: 'half_open', startAttempts: 4 });
    await expect(recovery).resolves.toBeDefined();

    expect(launchCount(counter)).toBe(4);
    expect(adapters.status()[0]).toMatchObject({
      state: 'ready',
      ready: true,
      startAttempts: 4,
      successfulStarts: 1,
      restartCount: 1,
      consecutiveFailures: 0,
    });
  });

  it('does not replay a crashed tool call and reconnects only on the next call path', async () => {
    const root = tempRoot('folderforge-registry-runtime');
    const crashMarker = join(root, 'crashed-once');
    let now = Date.parse('2026-07-18T14:00:00.000Z');
    const adapters = registry('crash-once', [crashMarker], {
      retryBaseMs: 100,
      retryMaxMs: 1_000,
      circuitFailureThreshold: 3,
      circuitOpenMs: 5_000,
      now: () => now,
    });

    const firstClient = await adapters.ensure('serena');
    await expect(firstClient.callTool('echo', { text: 'must-not-replay' }))
      .rejects.toBeInstanceOf(ChildMcpError);
    expect(existsSync(crashMarker)).toBe(true);
    expect(adapters.status()[0]).toMatchObject({
      state: 'backoff',
      ready: false,
      consecutiveFailures: 1,
    });

    await expect(adapters.ensure('serena')).rejects.toBeInstanceOf(AdapterUnavailableError);
    now += 100;
    const recoveredClient = await adapters.ensure('serena');
    expect(recoveredClient).toBe(firstClient);
    expect(resultText(await recoveredClient.callTool('echo', { text: 'after-restart' })))
      .toBe('after-restart');
    expect(adapters.status()[0]).toMatchObject({
      state: 'ready',
      restartCount: 1,
      consecutiveFailures: 0,
    });
  });

  it('reports lifecycle evidence through health and status without respawn storms', async () => {
    const root = tempRoot('folderforge-registry-health');
    const counter = join(root, 'starts.txt');
    let now = Date.parse('2026-07-18T15:00:00.000Z');
    const adapters = registry('initialize-fail-until', [counter, '1'], {
      retryBaseMs: 500,
      retryMaxMs: 2_000,
      circuitFailureThreshold: 3,
      circuitOpenMs: 5_000,
      now: () => now,
    });

    const first = await adapters.health('serena');
    expect(first).toMatchObject({
      enabled: true,
      ready: false,
      state: 'backoff',
      nextRetryAt: '2026-07-18T15:00:00.500Z',
    });
    const second = await adapters.health('serena');
    expect(second).toMatchObject({ enabled: true, ready: false, state: 'backoff' });
    expect(launchCount(counter)).toBe(1);

    now += 500;
    const recovered = await adapters.health('serena');
    expect(recovered).toMatchObject({ enabled: true, ready: true, state: 'ready', tools: 1 });
    expect(launchCount(counter)).toBe(2);
  });

  it('blocks compatibility failures until the adapter definition is replaced', async () => {
    const adapters = registry('unsupported-protocol');

    await expect(adapters.ensure('serena')).rejects.toBeInstanceOf(ChildMcpError);
    expect(adapters.status()[0]).toMatchObject({
      state: 'blocked',
      ready: false,
      degraded: true,
      startAttempts: 1,
      consecutiveFailures: 1,
      failureDisposition: 'compatibility',
      metrics: {
        totalFailures: 1,
        failuresByKind: { unsupported_protocol_version: 1 },
        failuresByDisposition: { compatibility: 1 },
      },
    });

    await expect(adapters.ensure('serena')).rejects.toMatchObject({
      name: 'AdapterUnavailableError',
      state: 'blocked',
      retryAt: null,
    });
    expect(adapters.status()[0]?.startAttempts).toBe(1);

    adapters.upsert('serena', {
      enabled: true,
      command: process.execPath,
      args: [fixture, 'success'],
    });
    await expect(adapters.ensure('serena')).resolves.toBeDefined();
    expect(adapters.status()[0]).toMatchObject({
      state: 'ready',
      ready: true,
      startAttempts: 1,
      consecutiveFailures: 0,
      metrics: { totalFailures: 0 },
    });
  });

  it('calculates uptime, availability, recovery time, histograms, and transport evidence', async () => {
    const root = tempRoot('folderforge-registry-metrics');
    const counter = join(root, 'starts.txt');
    let now = Date.parse('2026-07-18T16:00:00.000Z');
    const adapters = registry('initialize-fail-until', [counter, '1'], {
      retryBaseMs: 100,
      retryMaxMs: 1_000,
      circuitFailureThreshold: 3,
      circuitOpenMs: 5_000,
      now: () => now,
    });

    await expect(adapters.ensure('serena')).rejects.toBeInstanceOf(ChildMcpError);
    now += 100;
    await adapters.ensure('serena');
    now += 900;

    const status = adapters.status()[0];
    expect(status).toMatchObject({
      state: 'ready',
      metrics: {
        observedMs: 1_000,
        currentUptimeMs: 900,
        totalReadyMs: 900,
        availability: 0.9,
        totalFailures: 1,
        failureRatePerHour: 3_600,
        recoveries: 1,
        meanRecoveryMs: 100,
        failuresByKind: { child_exited_before_initialize: 1 },
        failuresByDisposition: { transient: 1 },
      },
      transport: {
        pendingRequests: 0,
      },
    });
    expect(status?.transport?.requestsSent).toBeGreaterThanOrEqual(1);
    expect(status?.transport?.responsesReceived).toBeGreaterThanOrEqual(1);
  });

  it('gracefully stops every child and exposes the stopped state', async () => {
    const adapters = registry('success');
    await adapters.ensure('serena');
    const pid = adapters.status()[0]?.pid;
    expect(pid).toBeTypeOf('number');

    await adapters.stopAllAndWait(50);

    expect(await waitForExit(pid!)).toBe(true);
    expect(adapters.status()[0]).toMatchObject({
      state: 'stopped',
      ready: false,
      degraded: false,
    });
    await expect(adapters.ensure('serena')).rejects.toMatchObject({
      name: 'AdapterUnavailableError',
      state: 'stopped',
      retryAt: null,
    });
  });
});
