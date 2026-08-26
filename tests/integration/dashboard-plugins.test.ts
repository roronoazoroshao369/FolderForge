import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { buildRegistry } from '../../src/tools/index.js';

interface PluginHarness {
  root: string;
  container: Container;
  server: Server;
  baseUrl: string;
}

async function startHarness(): Promise<PluginHarness> {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-dashboard-plugins-'));
  const config = defaultConfig(root);
  config.rateLimit.enabled = false;
  config.policy.defaultMode = 'dev';
  const container = new Container(config);
  const registry = buildRegistry(container);
  const server = startDashboard(container, registry, { host: '127.0.0.1', port: 0 });
  if (!server.listening) await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { root, container, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('dashboard plugins and marketplace endpoints', () => {
  const harnesses: PluginHarness[] = [];

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      for (const process of harness.container.processes.list()) {
        if (process.status === 'running') harness.container.processes.kill(process.sessionId);
      }
      await closeServer(harness.server);
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it('lists installed plugins, reads the marketplace index, and rejects unknown lifecycle targets', async () => {
    const harness = await startHarness();
    harnesses.push(harness);

    const pluginsResponse = await fetch(`${harness.baseUrl}/plugins`);
    expect(pluginsResponse.status).toBe(200);
    const plugins = (await pluginsResponse.json()) as { plugins?: unknown[] };
    expect(Array.isArray(plugins.plugins)).toBe(true);
    expect(plugins.plugins).toHaveLength(0);

    // A fresh project has no synced marketplace index yet; both a clean empty
    // list (200) and a governed error (409) prove the route is wired correctly.
    const marketplaceResponse = await fetch(`${harness.baseUrl}/marketplace`);
    expect([200, 409]).toContain(marketplaceResponse.status);

    const enable = await fetch(`${harness.baseUrl}/plugins/no-such-plugin/enable`, {
      method: 'POST',
    });
    expect(enable.status).not.toBe(200);
    const enableBody = (await enable.json()) as { ok?: boolean };
    expect(enableBody.ok).not.toBe(true);
  });
});
