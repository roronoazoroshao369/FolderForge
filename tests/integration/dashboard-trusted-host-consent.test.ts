import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { buildRegistry } from '../../src/tools/index.js';
import { TrustedHostStore } from '../../src/operator/trusted-host-store.js';
import { TrustedHostConsentService } from '../../src/operator/trusted-host-consent.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
  roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true }));
});

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'ff-host-api-'));
  roots.push(root);
  const config = defaultConfig(root);
  config.rateLimit.enabled = false;
  const container = new Container(config);
  const project = join(root, 'project');
  mkdirSync(project);
  const { instance } = container.fleet.create({ projectPath: project, authMode: 'api-key' });
  const store = new TrustedHostStore({ operatorRoot: join(root, 'operator'), currentUid: process.getuid?.() ?? 0, now: Date.now });
  const service = new TrustedHostConsentService({
    fleet: container.fleet, store, installationId: 'test-install',
    serviceUid: process.getuid?.() ?? 0, now: Date.now,
    isWriteFrozen: () => false, recordAudit: () => {},
  });
  vi.spyOn(container, 'trustedHostConsentService').mockReturnValue(service);
  const server = startDashboard(container, buildRegistry(container), {
    host: '127.0.0.1', port: 0, token: 'dev-host-token', requireAuth: false,
  });
  servers.push(server);
  if (!server.listening) await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const path = `/fleet/${instance.id}/profile-intents`;
  const tuple = { toolsPreset: 'full', policyMode: 'danger', terminalExecution: 'trusted-host' };
  const request = (headers: Record<string,string>, suffix = '', method = 'POST') =>
    fetch(`${base}${path}${suffix}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'POST' ? JSON.stringify(tuple) : undefined });
  return { container, instance, base, path, service, store, request };
}

describe('sensitive Fleet profile-intents API', () => {
  it('denies anonymous, query-token, cross-origin, and missing-origin requests', async () => {
    const h = await harness();
    const origin = h.base;
    expect((await h.request({ origin })).status).toBe(401);
    expect((await h.request({ origin }, '?token=dev-host-token')).status).toBe(401);
    expect((await h.request({ origin: 'https://attacker.example', authorization: 'Bearer dev-host-token' })).status).toBe(403);
    expect((await h.request({ authorization: 'Bearer dev-host-token' })).status).toBe(403);
    expect(h.store.findPendingByInstance(h.instance.id)).toBeNull();
  });

  it('rejects a request ID that does not exist for the Fleet instance', async () => {
    const h = await harness();
    const headers = { origin: h.base, authorization: 'Bearer dev-host-token' };
    const invalid = await fetch(`${h.base}${h.path}/req_missing`, { headers });
    expect(invalid.status).toBe(409);
  });

  it('creates one pending intent with bearer admin and never grants host execution over HTTP', async () => {
    const h = await harness();
    const headers = { origin: h.base, authorization: 'Bearer dev-host-token' };
    const result = await h.request(headers);
    expect(result.status).toBe(202);
    const body = await result.json() as { requestId: string; status: string };
    expect(body.status).toBe('pending');
    expect(body.requestId).toMatch(/^req_/);
    expect(h.store.findPendingByInstance(h.instance.id)?.requestId).toBe(body.requestId);
    const status = await fetch(`${h.base}${h.path}/${body.requestId}`, { headers });
    expect(status.status).toBe(200);
    expect((await status.json() as {status:string}).status).toBe('pending');
    expect(h.container.fleet.get(h.instance.id).terminalExecution).not.toBe('trusted-host');
  });

  it('refuses apply until local approval, then commits the exact scope without a remote approval endpoint', async () => {
    const h = await harness();
    const headers = { origin: h.base, authorization: 'Bearer dev-host-token', 'content-type': 'application/json' };
    const created = await h.request(headers);
    const { requestId } = await created.json() as { requestId: string };
    const applyUrl = `${h.base}${h.path}/${requestId}/apply`;
    const before = await fetch(applyUrl, { method: 'POST', headers });
    expect(before.status).toBe(409);
    expect(h.container.fleet.get(h.instance.id).toolsPreset).not.toBe('full');
    const pending = h.store.readPending(requestId)!;
    h.store.consumeLocalApproval(requestId, pending.scopeHash);
    const applied = await fetch(applyUrl, { method: 'POST', headers });
    expect(applied.status).toBe(200);
    expect(h.container.fleet.get(h.instance.id).toolsPreset).toBe('full');
    expect(h.container.fleet.get(h.instance.id).policyMode).toBe('danger');
    expect(h.container.fleet.get(h.instance.id).terminalExecution).toBe('trusted-host');
    expect((await fetch(applyUrl, { method: 'POST', headers: { origin: h.base } })).status).toBe(401);
  });
});
