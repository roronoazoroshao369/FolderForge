import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { buildRegistry } from '../../src/tools/index.js';

interface FleetHarness {
  root: string;
  container: Container;
  server: Server;
  baseUrl: string;
}

interface FleetInstanceView {
  id: string;
  state: string;
  authMode?: string;
  token?: string;
  apiKey?: string;
  credential?: string;
  kind?: 'token' | 'api-key';
  tokenSha256?: string;
}

interface FleetToolResult {
  ok?: boolean;
  data?: FleetInstanceView;
  error?: string;
}

async function startHarness(trustedHost = false): Promise<FleetHarness> {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-dashboard-fleet-'));
  const config = defaultConfig(root);
  config.rateLimit.enabled = false;
  config.policy.defaultMode = 'dev';
  if (trustedHost) config.terminal.sandbox = { mode: 'process', requireInDanger: false };
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

describe('dashboard fleet endpoints', () => {
  const harnesses: FleetHarness[] = [];

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      for (const process of harness.container.processes.list()) {
        if (process.status === 'running') harness.container.processes.kill(process.sessionId);
      }
      await closeServer(harness.server);
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it('lists, provisions, dedupes, and stops per-folder instances', async () => {
    const harness = await startHarness();
    harnesses.push(harness);

    const empty = await fetch(`${harness.baseUrl}/fleet`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ instances: [] });

    const created = await postJson(`${harness.baseUrl}/fleet`, { projectPath: harness.root });
    expect(created.status).toBe(201);
    expect(created.json.ok).toBe(true);
    const instance = created.json.data;
    expect(instance).toBeDefined();
    expect(instance?.id).toMatch(/^flt_/);
    expect(instance?.state).toBe('stopped');
    expect(typeof instance?.token).toBe('string');
    expect(String(instance?.token).length).toBeGreaterThan(20);
    expect(instance?.tokenSha256).toHaveLength(64);

    const listedResponse = await fetch(`${harness.baseUrl}/fleet`);
    const listed = (await listedResponse.json()) as { instances: FleetInstanceView[] };
    expect(listed.instances).toHaveLength(1);
    expect(listed.instances[0]?.id).toBe(instance?.id);
    // Raw tokens never appear in list responses; only the SHA-256 hash persists.
    expect(JSON.stringify(listed)).not.toContain(String(instance?.token));

    const duplicate = await postJson(`${harness.baseUrl}/fleet`, { projectPath: harness.root });
    expect(duplicate.status).toBe(409);
    expect(duplicate.json.ok).toBe(false);

    const invalid = await postJson(`${harness.baseUrl}/fleet`, {});
    expect(invalid.status).toBe(400);

    const stopped = await postJson(`${harness.baseUrl}/fleet/${instance?.id ?? ''}/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.json.ok).toBe(true);
    expect(stopped.json.data?.state).toBe('stopped');

    const missing = await postJson(`${harness.baseUrl}/fleet/flt_missing/stop`);
    expect(missing.status).toBe(409);
  });

  it('toggles auto-restart through the governed route', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    const created = await postJson(`${harness.baseUrl}/fleet`, { projectPath: harness.root });
    const id = created.json.data?.id ?? '';

    const enabled = await postJson(`${harness.baseUrl}/fleet/${id}/auto-restart`, { enabled: true });
    expect(enabled.status).toBe(200);
    expect(enabled.json.ok).toBe(true);

    const listedResponse = await fetch(`${harness.baseUrl}/fleet`);
    const listed = (await listedResponse.json()) as {
      instances: Array<FleetInstanceView & { autoRestart?: boolean }>;
    };
    expect(listed.instances[0]?.autoRestart).toBe(true);

    const invalid = await postJson(`${harness.baseUrl}/fleet/${id}/auto-restart`, {});
    expect(invalid.status).toBe(400);
  });

  it('treats the legacy critical escape hatch as an ignored compatibility no-op', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    const created = await postJson(`${harness.baseUrl}/fleet`, { projectPath: harness.root });
    const id = created.json.data?.id ?? '';

    const legacyDev = await postJson(`${harness.baseUrl}/fleet/${id}/policy`, {
      policyMode: 'dev',
      allowCriticalInDanger: true,
    });
    expect(legacyDev.status).toBe(200);
    expect(legacyDev.json.ok).toBe(true);

    let listed = (await (await fetch(`${harness.baseUrl}/fleet`)).json()) as {
      instances: Array<FleetInstanceView & { allowCriticalInDanger?: boolean; policyMode?: string }>;
    };
    expect(listed.instances[0]?.policyMode).toBe('dev');
    expect(listed.instances[0]?.allowCriticalInDanger).toBeUndefined();

    const legacyDanger = await postJson(`${harness.baseUrl}/fleet/${id}/policy`, {
      policyMode: 'danger',
      allowCriticalInDanger: true,
    });
    expect(legacyDanger.status).toBe(200);
    expect(legacyDanger.json.ok).toBe(true);

    listed = (await (await fetch(`${harness.baseUrl}/fleet`)).json()) as {
      instances: Array<FleetInstanceView & { allowCriticalInDanger?: boolean; policyMode?: string }>;
    };
    expect(listed.instances[0]?.policyMode).toBe('danger');
    expect(listed.instances[0]?.allowCriticalInDanger).toBeUndefined();

    const demoted = await postJson(`${harness.baseUrl}/fleet/${id}/policy`, { policyMode: 'safe' });
    expect(demoted.status).toBe(200);
    listed = (await (await fetch(`${harness.baseUrl}/fleet`)).json()) as {
      instances: Array<FleetInstanceView & { allowCriticalInDanger?: boolean; policyMode?: string }>;
    };
    expect(listed.instances[0]?.policyMode).toBe('safe');
    expect(listed.instances[0]?.allowCriticalInDanger).toBeUndefined();
  });

  it('changes policy mode and rotates the token through governed routes', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    const created = await postJson(`${harness.baseUrl}/fleet`, { projectPath: harness.root });
    const id = created.json.data?.id ?? '';
    const firstToken = String(created.json.data?.token ?? '');

    const badPolicy = await postJson(`${harness.baseUrl}/fleet/${id}/policy`, { policyMode: 'nope' });
    expect(badPolicy.status).toBe(409);

    const policy = await postJson(`${harness.baseUrl}/fleet/${id}/policy`, { policyMode: 'safe' });
    expect(policy.status).toBe(200);
    expect(policy.json.ok).toBe(true);

    const listedResponse = await fetch(`${harness.baseUrl}/fleet`);
    const listed = (await listedResponse.json()) as {
      instances: Array<FleetInstanceView & { policyMode?: string }>;
    };
    expect(listed.instances[0]?.policyMode).toBe('safe');

    const rotated = await postJson(`${harness.baseUrl}/fleet/${id}/rotate-token`);
    expect(rotated.status).toBe(200);
    expect(rotated.json.ok).toBe(true);
    const newToken = String(rotated.json.data?.token ?? '');
    expect(newToken.length).toBeGreaterThan(20);
    expect(newToken).not.toBe(firstToken);

    const listedAfter = (await (await fetch(`${harness.baseUrl}/fleet`)).json()) as unknown;
    expect(JSON.stringify(listedAfter)).not.toContain(newToken);

    const missing = await postJson(`${harness.baseUrl}/fleet/flt_missing/rotate-token`);
    expect(missing.status).toBe(409);
  });

  it('provisions and reconfigures Fleet authentication modes through governed routes', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    const noAuthProject = join(harness.root, 'no-auth-project');
    const apiProject = join(harness.root, 'api-project');
    mkdirSync(noAuthProject);
    mkdirSync(apiProject);

    const noAuth = await postJson(`${harness.baseUrl}/fleet`, {
      projectPath: noAuthProject,
      authMode: 'none',
    });
    expect(noAuth.status).toBe(201);
    expect(noAuth.json.data?.authMode).toBe('none');
    expect(noAuth.json.data?.token).toBeUndefined();
    expect(noAuth.json.data?.tokenSha256).toBeUndefined();

    const apiCreated = await postJson(`${harness.baseUrl}/fleet`, {
      projectPath: apiProject,
      authMode: 'api-key',
    });
    expect(apiCreated.status).toBe(201);
    expect(apiCreated.json.data?.authMode).toBe('api-key');
    expect(apiCreated.json.data?.apiKey).toMatch(/^ffk_/);
    const apiId = apiCreated.json.data?.id ?? '';

    const changed = await postJson(`${harness.baseUrl}/fleet/${apiId}/auth`, { mode: 'token' });
    expect(changed.status).toBe(200);
    expect(changed.json.ok).toBe(true);
    expect(changed.json.data?.authMode).toBe('token');
    expect(changed.json.data?.token).toBeTruthy();

    const rotated = await postJson(`${harness.baseUrl}/fleet/${apiId}/rotate-credential`);
    expect(rotated.status).toBe(200);
    expect(rotated.json.data?.credential).toBeTruthy();
    expect(rotated.json.data?.kind).toBe('token');
  });

  it('fails closed on OpenAI tunnel start when the referenced control-plane key is not in Mission Control env', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    const created = await postJson(`${harness.baseUrl}/fleet`, { projectPath: harness.root });
    const id = created.json.data?.id ?? '';
    delete process.env.FOLDERFORGE_MISSING_DASHBOARD_TEST_KEY;

    const result = await postJson(`${harness.baseUrl}/fleet/${id}/openai-tunnel/start`, {
      tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
      apiKeyEnv: 'FOLDERFORGE_MISSING_DASHBOARD_TEST_KEY',
      oauth: false,
    });
    expect(result.status).toBe(409);
    expect(result.json.ok).toBe(false);
    expect(result.json.error).toMatch(/not set in the Mission Control process/);
  });

  it('browses and creates directories within the bounded browse point only', async () => {
    const harness = await startHarness();
    harnesses.push(harness);

    const browseRoot = await postJson(`${harness.baseUrl}/fs/browse`, {});
    expect(browseRoot.status).toBe(200);
    const rootBody = browseRoot.json as unknown as { path?: string };
    // defaultConfig scopes the workspace to the temp root, so browsing starts there.
    expect(rootBody.path).toBe(harness.root);

    const outside = await postJson(`${harness.baseUrl}/fs/browse`, { path: '/' });
    expect(outside.status).toBe(403);

    const made = await postJson(`${harness.baseUrl}/fs/mkdir`, { path: harness.root, name: 'fleet-pick-demo' });
    expect(made.status).toBe(200);
    expect(existsSync(join(harness.root, 'fleet-pick-demo'))).toBe(true);

    const badName = await postJson(`${harness.baseUrl}/fs/mkdir`, { path: harness.root, name: 'a/b' });
    expect(badName.status).toBe(400);
  });

  it('GET /fleet/:id/logs: 404 for unknown ids, 409 no_logs before the instance is started', async () => {
    const harness = await startHarness();
    harnesses.push(harness);

    const provisioned = await postJson(`${harness.baseUrl}/fleet`, {
      projectPath: harness.root,
      toolsPreset: 'vibe',
      policyMode: 'safe',
    });
    expect(provisioned.status).toBe(201);
    const id = (provisioned.json.data as { id: string }).id;

    const logs = await fetch(`${harness.baseUrl}/fleet/${encodeURIComponent(id)}/logs`);
    expect(logs.status).toBe(409);
    expect(((await logs.json()) as { error: string }).error).toBe('no_logs');

    const missing = await fetch(`${harness.baseUrl}/fleet/flt_missing/logs`);
    expect(missing.status).toBe(404);
  });
  it('requires host operator opt-in for Fleet trusted execution, and persists selection in the child config', async () => {
    const guarded = await startHarness();
    harnesses.push(guarded);
    const blocked = await postJson(`${guarded.baseUrl}/fleet`, {
      projectPath: guarded.root,
      policyMode: 'danger',
      authMode: 'token',
      terminalExecution: 'trusted-host',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toMatch(/host.*opt-in/i);

    const allowed = await startHarness(true);
    harnesses.push(allowed);
    const created = await postJson(`${allowed.baseUrl}/fleet`, {
      projectPath: allowed.root,
      policyMode: 'danger',
      authMode: 'token',
    });
    expect(created.status).toBe(201);
    const instance = created.json.data!;
    expect((instance as FleetInstanceView & { terminalExecution?: string }).terminalExecution).toBe('trusted-host');
    const configPath = join(allowed.root, '.folderforge', 'fleet', `${instance.id}.yaml`);
    expect(readFileSync(configPath, 'utf8')).toContain('requireInDanger: false');

    const sandbox = await postJson(`${allowed.baseUrl}/fleet/${instance.id}/terminal`, {
      terminalExecution: 'sandbox-required',
    });
    expect(sandbox.status).toBe(200);
    expect(readFileSync(configPath, 'utf8')).toContain('requireInDanger: true');

    const restore = await postJson(`${allowed.baseUrl}/fleet/${instance.id}/terminal`, {
      terminalExecution: 'trusted-host',
    });
    expect(restore.status).toBe(200);
    expect(readFileSync(configPath, 'utf8')).toContain('requireInDanger: false');

    const invalid = await postJson(`${allowed.baseUrl}/fleet/${instance.id}/terminal`, {
      terminalExecution: 'disable-everything',
    });
    expect(invalid.status).toBe(400);
    expect(readFileSync(configPath, 'utf8')).toContain('requireInDanger: false');

    const noAuth = await postJson(`${allowed.baseUrl}/fleet`, {
      projectPath: join(allowed.root, 'anon'),
      policyMode: 'danger',
      authMode: 'none',
      terminalExecution: 'trusted-host',
    });
    // A missing folder or anonymous trusted-host mode must not produce an instance.
    expect(noAuth.status).not.toBe(201);
  });

});
