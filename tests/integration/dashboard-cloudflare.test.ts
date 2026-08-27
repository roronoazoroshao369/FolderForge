import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { buildRegistry } from '../../src/tools/index.js';

interface Harness {
  root: string;
  container: Container;
  server: Server;
  baseUrl: string;
}

async function startHarness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-dashboard-cf-'));
  const config = defaultConfig(root);
  config.rateLimit.enabled = false;
  config.policy.defaultMode = 'dev';
  const container = new Container(config);
  const registry = buildRegistry(container);
  const server = startDashboard(container, registry, { host: '127.0.0.1', port: 0 });
  if (!server.listening) await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { root, container, server, baseUrl: 'http://127.0.0.1:' + String(address.port) };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

interface FakeCf {
  server: Server;
  baseUrl: string;
  calls: Array<{ method: string; url: string }>;
  rejectVerify: boolean;
}

async function startFakeCloudflare(): Promise<FakeCf> {
  const fake: FakeCf = { server: undefined as unknown as Server, baseUrl: '', calls: [], rejectVerify: false };
  const server = createServer((req, res) => {
    fake.calls.push({ method: req.method ?? '', url: req.url ?? '' });
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/user/tokens/verify')) {
      if (fake.rejectVerify) {
        res.statusCode = 403;
        res.end(JSON.stringify({ success: false, errors: [{ message: 'invalid token' }] }));
        return;
      }
      res.end(JSON.stringify({ success: true, result: { id: 'tok' } }));
      return;
    }
    if (req.url?.startsWith('/zones')) {
      res.end(JSON.stringify({ success: true, result: [{ id: 'zone-1' }] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ success: false, errors: [{ message: 'not found' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  fake.server = server;
  fake.baseUrl = 'http://127.0.0.1:' + String((server.address() as AddressInfo).port);
  return fake;
}

async function postJson(url: string, body?: unknown, method = 'POST'): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

describe('dashboard cloudflare endpoints', () => {
  const harnesses: Harness[] = [];
  const fakes: FakeCf[] = [];

  afterEach(async () => {
    delete process.env.FOLDERFORGE_CF_API_BASE_URL;
    for (const harness of harnesses.splice(0)) {
      for (const process of harness.container.processes.list()) {
        if (process.status === 'running') harness.container.processes.kill(process.sessionId);
      }
      await closeServer(harness.server);
      rmSync(harness.root, { recursive: true, force: true });
    }
    for (const fake of fakes.splice(0)) {
      await closeServer(fake.server);
    }
  });

  it('reports unconfigured, links an account (token verified + zone resolved, stored 0600, never echoed), then unlinks', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    const fake = await startFakeCloudflare();
    fakes.push(fake);
    process.env.FOLDERFORGE_CF_API_BASE_URL = fake.baseUrl;

    const before = await fetch(harness.baseUrl + '/cloudflare/status');
    expect((await before.json()).configured).toBe(false);

    const rawToken = 'tok_super_secret_1234abcd';
    const linked = await postJson(harness.baseUrl + '/cloudflare/config', {
      apiToken: rawToken,
      accountId: 'acc1',
      domain: 'example.com',
    });
    expect(linked.status).toBe(200);
    expect(linked.json.configured).toBe(true);
    expect(linked.json.domain).toBe('example.com');
    expect(linked.json.zoneId).toBe('zone-1');
    expect(linked.text).not.toContain(rawToken);

    const cfPaths = fake.calls.map((c) => c.url);
    expect(cfPaths.some((u) => u.startsWith('/user/tokens/verify'))).toBe(true);
    expect(cfPaths.some((u) => u.startsWith('/zones'))).toBe(true);

    const configFile = join(harness.root, '.folderforge', 'cloudflare.json');
    expect(existsSync(configFile)).toBe(true);
    expect(statSync(configFile).mode & 0o777).toBe(0o600);

    const unlinked = await postJson(harness.baseUrl + '/cloudflare/config', undefined, 'DELETE');
    expect(unlinked.status).toBe(200);
    const after = await fetch(harness.baseUrl + '/cloudflare/status');
    expect((await after.json()).configured).toBe(false);
  });

  it('rejects malformed domains and Cloudflare-side token failures', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    const fake = await startFakeCloudflare();
    fakes.push(fake);
    process.env.FOLDERFORGE_CF_API_BASE_URL = fake.baseUrl;

    const badDomain = await postJson(harness.baseUrl + '/cloudflare/config', {
      apiToken: 'tok_x',
      accountId: 'acc1',
      domain: 'not a domain',
    });
    expect(badDomain.status).toBe(400);
    expect(badDomain.json.error).toBe('invalid_cloudflare_config');

    fake.rejectVerify = true;
    const rejected = await postJson(harness.baseUrl + '/cloudflare/config', {
      apiToken: 'tok_bad',
      accountId: 'acc1',
      domain: 'example.com',
    });
    expect(rejected.status).toBe(502);
    expect(rejected.json.error).toBe('cloudflare_rejected');
  });

  it('named tunnel start requires a running instance (guard fires before Cloudflare is called)', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    const fake = await startFakeCloudflare();
    fakes.push(fake);
    process.env.FOLDERFORGE_CF_API_BASE_URL = fake.baseUrl;

    await postJson(harness.baseUrl + '/cloudflare/config', {
      apiToken: 'tok_x',
      accountId: 'acc1',
      domain: 'example.com',
    });
    const provisioned = await postJson(harness.baseUrl + '/fleet', {
      projectPath: harness.root,
      toolsPreset: 'vibe',
      policyMode: 'safe',
    });
    expect(provisioned.status).toBe(201);
    const instanceId = (provisioned.json.data as { id: string }).id;

    const callsBefore = fake.calls.length;
    const named = await postJson(
      harness.baseUrl + '/fleet/' + encodeURIComponent(instanceId) + '/tunnel',
      { hostname: 'mcp1.example.com' },
    );
    expect(named.status).toBe(409);
    expect(named.json.error).toBe('not_running');
    expect(fake.calls.length).toBe(callsBefore);
  });
});
