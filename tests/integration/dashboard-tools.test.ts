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
import { buildRegistry, GROUP_PRESETS } from '../../src/tools/index.js';

interface ToolsHarness {
  root: string;
  container: Container;
  server: Server;
  baseUrl: string;
}

interface ToolView {
  name: string;
  group: string;
  risk: string;
  mutates: boolean;
}

interface FleetToolResult {
  ok?: boolean;
  data?: { id?: string };
  error?: string;
}

async function startHarness(): Promise<ToolsHarness> {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-dashboard-tools-'));
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

async function postJson(url: string, body?: unknown): Promise<{ status: number; json: FleetToolResult }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as FleetToolResult };
}

describe('dashboard tools endpoints', () => {
  const harnesses: ToolsHarness[] = [];

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      for (const process of harness.container.processes.list()) {
        if (process.status === 'running') harness.container.processes.kill(process.sessionId);
      }
      await closeServer(harness.server);
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it('serves the tool catalog with groups, risk, and preset coverage', async () => {
    const harness = await startHarness();
    harnesses.push(harness);

    const response = await fetch(`${harness.baseUrl}/tools`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tools?: ToolView[];
      presets?: Record<string, { groups: string[]; toolCount: number }>;
    };
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools!.length).toBeGreaterThan(100);
    const names = new Set(body.tools!.map((t) => t.name));
    expect(names.has('file_read')).toBe(true);
    expect(names.has('provision_update')).toBe(true);
    for (const preset of Object.keys(GROUP_PRESETS)) {
      expect(body.presets?.[preset]?.toolCount).toBeGreaterThan(0);
    }
  });

  it('changes an instance tool preset through the governed route', async () => {
    const harness = await startHarness();
    harnesses.push(harness);

    const created = await postJson(`${harness.baseUrl}/fleet`, { projectPath: harness.root });
    expect(created.status).toBe(201);
    const id = created.json.data?.id ?? '';
    expect(id).toMatch(/^flt_/);

    const missing = await postJson(`${harness.baseUrl}/fleet/${id}/preset`, {});
    expect(missing.status).toBe(400);

    const invalid = await postJson(`${harness.baseUrl}/fleet/${id}/preset`, { toolsPreset: 'nope' });
    expect(invalid.status).toBe(409);

    const updated = await postJson(`${harness.baseUrl}/fleet/${id}/preset`, { toolsPreset: 'full' });
    expect(updated.status).toBe(200);
    expect(updated.json.ok).toBe(true);

    const listedResponse = await fetch(`${harness.baseUrl}/fleet`);
    const listed = (await listedResponse.json()) as {
      instances?: Array<{ id: string; toolsPreset: string }>;
    };
    const record = (listed.instances ?? []).find((i) => i.id === id);
    expect(record?.toolsPreset).toBe('full');
  });
});
