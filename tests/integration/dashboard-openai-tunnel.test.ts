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
  const root = mkdtempSync(join(tmpdir(), 'folderforge-dashboard-gpt-'));
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

async function postJson(
  url: string,
  body?: unknown,
  method = 'POST',
): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

interface FakeOpenAi {
  server: Server;
  baseUrl: string;
  calls: Array<{ method: string; url: string; authorization?: string }>;
  reject: boolean;
}

async function startFakeOpenAi(): Promise<FakeOpenAi> {
  const fake: FakeOpenAi = {
    server: undefined as unknown as Server,
    baseUrl: '',
    calls: [],
    reject: false,
  };
  const server = createServer((req, res) => {
    fake.calls.push({
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: req.headers.authorization,
    });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') {
      res.statusCode = fake.reject ? 401 : 200;
      res.end(JSON.stringify(fake.reject ? { error: { message: 'invalid key' } } : { data: [] }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  fake.server = server;
  fake.baseUrl = 'http://127.0.0.1:' + String((server.address() as AddressInfo).port);
  return fake;
}

describe('dashboard openai tunnel config', () => {
  const harnesses: Harness[] = [];
  const fakes: FakeOpenAi[] = [];

  afterEach(async () => {
    delete process.env.FOLDERFORGE_TEST_TUNNEL_KEY;
    delete process.env.FOLDERFORGE_OPENAI_API_BASE_URL;
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

  it('reports unconfigured, validates + saves config (0600, no secrets), then unlinks', async () => {
    const harness = await startHarness();
    harnesses.push(harness);

    const before = await fetch(harness.baseUrl + '/openai-tunnel/status');
    expect((await before.json()).configured).toBe(false);

    const badId = await postJson(harness.baseUrl + '/openai-tunnel/config', { tunnelId: 'nope' });
    expect(badId.status).toBe(400);
    expect(badId.json.error).toBe('invalid_openai_tunnel_config');

    const saved = await postJson(harness.baseUrl + '/openai-tunnel/config', {
      tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
    });
    expect(saved.status).toBe(200);
    expect(saved.json.configured).toBe(true);
    expect(saved.json.apiKeyEnv).toBe('CONTROL_PLANE_API_KEY');

    const configFile = join(harness.root, '.folderforge', 'openai-tunnel-config.json');
    expect(existsSync(configFile)).toBe(true);
    expect(statSync(configFile).mode & 0o777).toBe(0o600);

    const status = await fetch(harness.baseUrl + '/openai-tunnel/status');
    const statusJson = (await status.json()) as Record<string, unknown>;
    expect(statusJson.configured).toBe(true);
    expect(statusJson.tunnelId).toBe('tunnel_0123456789abcdef0123456789abcdef');
    expect(statusJson.running).toBe(false);

    const unlinked = await postJson(harness.baseUrl + '/openai-tunnel/config', undefined, 'DELETE');
    expect(unlinked.status).toBe(200);
    const after = await fetch(harness.baseUrl + '/openai-tunnel/status');
    expect((await after.json()).configured).toBe(false);
  });

  it('fails closed on start when the API-key env var is missing in the plane process', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    await postJson(harness.baseUrl + '/openai-tunnel/config', {
      tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
      apiKeyEnv: 'FOLDERFORGE_TEST_TUNNEL_KEY',
    });
    delete process.env.FOLDERFORGE_TEST_TUNNEL_KEY;

    const started = await postJson(harness.baseUrl + '/openai-tunnel/start');
    expect(started.status).toBe(409);
    expect(started.json.error).toBe('api_key_env_missing');

    // Stop without a running supervisor is a safe no-op.
    const stopped = await postJson(harness.baseUrl + '/openai-tunnel/stop');
    expect(stopped.status).toBe(200);
  });

  it('verify probes OpenAI with a pasted/stored/env key and never echoes it back', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    const fake = await startFakeOpenAi();
    fakes.push(fake);
    process.env.FOLDERFORGE_OPENAI_API_BASE_URL = fake.baseUrl;

    // No key anywhere → 409.
    const none = await postJson(harness.baseUrl + '/openai-tunnel/verify');
    expect(none.status).toBe(409);
    expect(none.json.error).toBe('no_key_available');

    // A pasted key is checked against OpenAI (never saved, never echoed).
    const good = await postJson(harness.baseUrl + '/openai-tunnel/verify', { apiKey: 'sk-live-secret' });
    expect(good.status).toBe(200);
    expect(good.json.ok).toBe(true);
    expect(good.text).not.toContain('sk-live-secret');
    expect(fake.calls.some((c) => c.authorization === 'Bearer sk-live-secret')).toBe(true);

    fake.reject = true;
    const bad = await postJson(harness.baseUrl + '/openai-tunnel/verify', { apiKey: 'sk-bad' });
    expect(bad.status).toBe(502);
    expect(bad.json.error).toBe('openai_key_invalid');
    fake.reject = false;

    // A pasted key saved with the config unlocks start without the env var,
    // and status/config responses only ever show the last-4 preview.
    const saved = await postJson(harness.baseUrl + '/openai-tunnel/config', {
      tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
      apiKeyEnv: 'FOLDERFORGE_TEST_TUNNEL_KEY',
      apiKey: 'sk-stored-secret-9abc',
    });
    expect(saved.status).toBe(200);
    expect(saved.json.apiKeyStored).toBe(true);
    expect(saved.json.keyPreview).toBe('…9abc');
    expect(saved.text).not.toContain('sk-stored-secret-9abc');

    delete process.env.FOLDERFORGE_TEST_TUNNEL_KEY;
    const status = await fetch(harness.baseUrl + '/openai-tunnel/status');
    const statusJson = (await status.json()) as Record<string, unknown>;
    expect(statusJson.apiKeyPresent).toBe(true); // the stored key counts
    expect(statusJson.keyPreview).toBe('…9abc');

    // The start guard now passes; in this checkout the built entrypoint is
    // absent, surfacing entrypoint_missing instead of spawning for real.
    const started = await postJson(harness.baseUrl + '/openai-tunnel/start');
    expect(started.status).toBe(409);
    expect(started.json.error).toBe('entrypoint_missing');

    // Verify falls back to the stored key when nothing is pasted.
    const verifyStored = await postJson(harness.baseUrl + '/openai-tunnel/verify');
    expect(verifyStored.status).toBe(200);
    expect(fake.calls.some((c) => c.authorization === 'Bearer sk-stored-secret-9abc')).toBe(true);
  });

  it('start requires a saved config first', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    const started = await postJson(harness.baseUrl + '/openai-tunnel/start');
    expect(started.status).toBe(409);
    expect(started.json.error).toBe('openai_tunnel_not_configured');
  });
});
