import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { buildRegistry } from '../../src/tools/index.js';

interface TunnelHarness {
  root: string;
  container: Container;
  server: Server;
  baseUrl: string;
}

async function startHarness(): Promise<TunnelHarness> {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-dashboard-tunnels-'));
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

describe('dashboard tunnel endpoints', () => {
  const harnesses: TunnelHarness[] = [];

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      for (const process of harness.container.processes.list()) {
        if (process.status === 'running') harness.container.processes.kill(process.sessionId);
      }
      await closeServer(harness.server);
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it('lists tunnels, validates the start payload, and rejects unknown stops', async () => {
    const harness = await startHarness();
    harnesses.push(harness);

    const listResponse = await fetch(`${harness.baseUrl}/tunnels`);
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({ tunnels: [] });

    const invalid = await fetch(`${harness.baseUrl}/tunnels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(invalid.status).toBe(400);

    // Never actually spawn cloudflared in tests: starting requires the binary
    // and opens a public URL, so only the validation + governance paths run here.
    const stopUnknown = await fetch(`${harness.baseUrl}/tunnels/tun_missing/stop`, {
      method: 'POST',
    });
    expect(stopUnknown.status).toBe(409);
  });

  it('refuses generic public tunnel exposure for a no-auth Fleet port', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    const project = join(harness.root, 'no-auth-project');
    mkdirSync(project);
    const created = harness.container.fleet.create({ projectPath: project, authMode: 'none' });

    const response = await fetch(`${harness.baseUrl}/tunnels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetPort: created.instance.port }),
    });
    expect(response.status).toBe(409);
    const body = await response.json() as { error?: string; message?: string };
    expect(body.error).toBe('authentication_required');
    expect(body.message).toContain(created.instance.id);
  });
});
