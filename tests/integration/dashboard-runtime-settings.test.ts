import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Container } from '../../src/runtime/container.js';
import { defaultConfig } from '../../src/runtime/config.js';
import { RuntimeSettings } from '../../src/operator/runtime-settings.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { buildRegistry } from '../../src/tools/index.js';

function createHarness(root: string, token?: string) {
  const config = defaultConfig(root);
  config.rateLimit.enabled = false;
  const container = new Container(config);
  const server = startDashboard(container, buildRegistry(container), {
    host: '127.0.0.1',
    port: 0,
    ...(token ? { token, requireAuth: true } : {}),
  });
  return { container, server };
}

async function endpoint(server: Server): Promise<string> {
  if (!server.listening) await once(server, 'listening');
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

async function post(base: string, path: string, body: unknown, token?: string) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('Mission Control runtime settings', () => {
  const cleanup: Array<{ server?: Server; root: string }> = [];
  afterEach(async () => {
    for (const item of cleanup.splice(0)) {
      if (item.server?.listening) {
        await new Promise<void>((resolve, reject) =>
          item.server!.close((error) => error ? reject(error) : resolve()));
      }
      rmSync(item.root, { recursive: true, force: true });
    }
  });

  it('saves bounded terminal preferences and operator policy mode across restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-dashboard-runtime-'));
    const harness = createHarness(root);
    cleanup.push({ root, server: harness.server });
    const base = await endpoint(harness.server);
    const initial = await fetch(`${base}/runtime/settings`);
    expect(initial.status).toBe(200);
    expect((await initial.json()).terminal.sandbox).toEqual({
      mode: 'process', requireInDanger: true,
    });
    const changed = await post(base, '/runtime/settings', {
      defaultTimeoutMs: 30000,
      maxOutputBytes: 65536,
    });
    expect(changed.status).toBe(200);
    expect((await changed.json()).terminal).toMatchObject({
      defaultTimeoutMs: 30000,
      maxOutputBytes: 65536,
    });
    const selected = await post(base, '/policy/mode', { mode: 'dev' });
    expect(selected.status).toBe(200);

    const restarted = new Container(defaultConfig(root));
    expect(restarted.config.terminal.defaultTimeoutMs).toBe(30000);
    expect(restarted.config.terminal.maxOutputBytes).toBe(65536);
    expect(restarted.policy.getMode()).toBe('dev');
    expect(restarted.config.terminal.sandbox).toMatchObject({
      mode: 'process', requireInDanger: true,
    });
  });

  it('rejects sandbox switching and malformed budgets without changing state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-dashboard-runtime-'));
    const harness = createHarness(root);
    cleanup.push({ root, server: harness.server });
    const base = await endpoint(harness.server);
    const denied = await post(base, '/runtime/settings', {
      defaultTimeoutMs: 10000,
      maxOutputBytes: 20000,
      sandbox: { mode: 'process', requireInDanger: false },
    });
    expect(denied.status).toBe(400);
    const invalid = await post(base, '/runtime/settings', {
      defaultTimeoutMs: -10,
      maxOutputBytes: 20000,
    });
    expect(invalid.status).toBe(400);
    expect(harness.container.config.terminal.defaultTimeoutMs).toBe(120000);
    expect(harness.container.config.terminal.sandbox?.requireInDanger).toBe(true);
    harness.container.missionControl.setWriteFreeze(true, 'admin:operator');
    const frozen = await post(base, '/runtime/settings', {
      defaultTimeoutMs: 5000, maxOutputBytes: 5000,
    });
    expect(frozen.status).toBe(409);
  });

  it('requires the dashboard bearer token when authentication is enabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-dashboard-runtime-'));
    const harness = createHarness(root, 'private-dashboard-token');
    cleanup.push({ root, server: harness.server });
    const base = await endpoint(harness.server);
    const noToken = await post(base, '/runtime/settings', {
      defaultTimeoutMs: 10000, maxOutputBytes: 10000,
    });
    expect(noToken.status).toBe(401);
    const authorized = await post(base, '/runtime/settings', {
      defaultTimeoutMs: 10000, maxOutputBytes: 10000,
    }, 'private-dashboard-token');
    expect(authorized.status).toBe(200);
  });

  it('detects modified preference storage without applying it', () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-dashboard-runtime-'));
    cleanup.push({ root });
    const config = defaultConfig(root);
    new RuntimeSettings(root, config).update({
      defaultTimeoutMs: 10000,
      maxOutputBytes: 10000,
    }, 'admin:operator');
    const path = join(root, '.folderforge', 'runtime-settings.json');
    const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    data.maxOutputBytes = 2000000;
    writeFileSync(path, JSON.stringify(data));
    expect(() => new RuntimeSettings(root, defaultConfig(root))).toThrow(/integrity/i);
  });
});
