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

interface WorkspaceHarness {
  root: string;
  container: Container;
  server: Server;
  baseUrl: string;
}

async function startHarness(): Promise<WorkspaceHarness> {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-dashboard-workspaces-'));
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

describe('dashboard workspaces endpoints', () => {
  const harnesses: WorkspaceHarness[] = [];

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      for (const process of harness.container.processes.list()) {
        if (process.status === 'running') harness.container.processes.kill(process.sessionId);
      }
      await closeServer(harness.server);
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it('lists workspaces, validates the switch payload, and rejects unknown paths', async () => {
    const harness = await startHarness();
    harnesses.push(harness);

    const listResponse = await fetch(`${harness.baseUrl}/workspaces`);
    expect(listResponse.status).toBe(200);
    const list = (await listResponse.json()) as { workspaces?: unknown[] };
    expect(Array.isArray(list.workspaces)).toBe(true);
    // The harness project is auto-activated as the default workspace.
    expect(list.workspaces!.length).toBeGreaterThanOrEqual(1);

    const invalid = await fetch(`${harness.baseUrl}/workspaces/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(invalid.status).toBe(400);

    const unknown = await fetch(`${harness.baseUrl}/workspaces/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: join(harness.root, 'never-activated') }),
    });
    expect(unknown.status).not.toBe(200);
    const unknownBody = (await unknown.json()) as { ok?: boolean };
    expect(unknownBody.ok).not.toBe(true);
  });

  it('activates a new folder from the dashboard and validates the payload', async () => {
    const harness = await startHarness();
    harnesses.push(harness);

    const invalid = await fetch(`${harness.baseUrl}/workspaces/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(invalid.status).toBe(400);

    const folder = join(harness.root, 'extra-folder');
    mkdirSync(folder, { recursive: true });
    const activated = await fetch(`${harness.baseUrl}/workspaces/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: folder }),
    });
    expect(activated.status).toBe(200);

    const list = await fetch(`${harness.baseUrl}/workspaces`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      workspaces?: Array<{ projectRoot?: string; path?: string }>;
    };
    const paths = (body.workspaces ?? []).map((w) => w.projectRoot ?? w.path);
    expect(paths).toContain(folder);
  });
});
