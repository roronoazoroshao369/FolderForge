import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import {
  LOOPBACK_DASHBOARD_ADMIN_PRINCIPAL,
  LOOPBACK_HTTP_AGENT_PRINCIPAL,
} from '../../src/core/principal.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { buildRegistry } from '../../src/tools/index.js';

interface DashboardHarness {
  root: string;
  container: Container;
  server: Server;
  baseUrl: string;
}

async function startHarness(): Promise<DashboardHarness> {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-dashboard-admin-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'FolderForge Test'], { cwd: root });
  writeFileSync(join(root, 'tracked.txt'), 'before\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root });
  const config = defaultConfig(root);
  config.rateLimit.enabled = false;
  const container = new Container(config);
  const registry = buildRegistry(container);
  const server = startDashboard(container, registry, { host: '127.0.0.1', port: 0 });
  if (!server.listening) await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    root,
    container,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('dashboard admin authorization plane', () => {
  const harnesses: DashboardHarness[] = [];

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      for (const process of harness.container.processes.list()) {
        if (process.status === 'running') harness.container.processes.kill(process.sessionId);
      }
      await closeServer(harness.server);
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it('serves the local control plane and exposes workspace startup diagnostics', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    harness.container.workspaceStartupError = 'simulated activation failure';

    const page = await fetch(`${harness.baseUrl}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('id="approvals-panel"');
    expect(html).toContain('Approval queue');
    expect(html).toContain('id="mission-control-panel"');
    expect(html).toContain('Mission Control');
    expect(html).toContain('id="policy-mode"');

    const status = await fetch(`${harness.baseUrl}/status`);
    expect(status.status).toBe(200);
    const body = (await status.json()) as {
      workspace: { startupError: string | null };
    };
    expect(body.workspace.startupError).toBe('simulated activation failure');
  });

  it('resolves a distinct requester but rejects self-approval', async () => {
    const harness = await startHarness();
    harnesses.push(harness);

    const distinct = harness.container.policy.approvals.create(
      'file_delete',
      { path: 'a.txt' },
      'HIGH',
      'test',
      LOOPBACK_HTTP_AGENT_PRINCIPAL.id
    );
    const approvedResponse = await fetch(
      `${harness.baseUrl}/approvals/${distinct.id}/approve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'once' }),
      }
    );
    expect(approvedResponse.status).toBe(200);
    const approved = (await approvedResponse.json()) as {
      approval: { state: string; approverId: string };
    };
    expect(approved.approval.state).toBe('approved');
    expect(approved.approval.approverId).toBe(LOOPBACK_DASHBOARD_ADMIN_PRINCIPAL.id);

    const self = harness.container.policy.approvals.create(
      'file_delete',
      { path: 'b.txt' },
      'HIGH',
      'test',
      LOOPBACK_DASHBOARD_ADMIN_PRINCIPAL.id
    );
    const selfResponse = await fetch(
      `${harness.baseUrl}/approvals/${self.id}/approve`,
      { method: 'POST' }
    );
    expect(selfResponse.status).toBe(409);
    const selfBody = (await selfResponse.json()) as { error: string };
    expect(selfBody.error).toBe('self_approval');
    expect(harness.container.policy.approvals.get(self.id)?.state).toBe('pending');
  });

  it('changes runtime policy only through the dashboard admin endpoint', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    expect(harness.container.policy.getMode()).toBe('safe');

    const response = await fetch(`${harness.baseUrl}/policy/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'dev' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mode: 'dev' });
    expect(harness.container.policy.getMode()).toBe('dev');

    const policyEvents = harness.container.audit
      .recent(20)
      .filter((event) => event.type === 'policy_change');
    expect(policyEvents).toHaveLength(1);
    expect(policyEvents[0]?.detail?.actorId).toBe(LOOPBACK_DASHBOARD_ADMIN_PRINCIPAL.id);
  });
  it('creates, lists, and revokes Workspace Capsules through the admin plane', async () => {
    const harness = await startHarness();
    harnesses.push(harness);

    const createdResponse = await fetch(`${harness.baseUrl}/capsules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        principalId: 'credential:agent-a',
        sessionId: 'session:a',
        profile: 'develop',
        ttlMs: 60_000,
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { capsule: { id: string; profile: string } };
    expect(created.capsule.profile).toBe('develop');

    const listResponse = await fetch(`${harness.baseUrl}/capsules`);
    expect(listResponse.status).toBe(200);
    const list = (await listResponse.json()) as { active: number; capsules: Array<{ id: string }> };
    expect(list.active).toBe(1);
    expect(list.capsules.map((item) => item.id)).toContain(created.capsule.id);

    const revokedResponse = await fetch(
      `${harness.baseUrl}/capsules/${created.capsule.id}/revoke`,
      { method: 'POST' },
    );
    expect(revokedResponse.status).toBe(200);
    const revoked = (await revokedResponse.json()) as { capsule: { revokedBy: string } };
    expect(revoked.capsule.revokedBy).toBe(LOOPBACK_DASHBOARD_ADMIN_PRINCIPAL.id);

    const policyEvents = harness.container.audit
      .recent(20)
      .filter((event) => event.type === 'policy_change');
    expect(policyEvents.map((event) => event.summary)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^capsule_created:/),
        expect.stringMatching(/^capsule_revoked:/),
      ]),
    );
  });

  it('freezes writes while preserving exact dashboard containment actions', async () => {
    const harness = await startHarness();
    harnesses.push(harness);

    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setInterval(() => {}, 1000)')}`;
    const managed = harness.container.processes.start(
      command,
      harness.root,
      harness.container.config.terminal.shell,
    );

    const initial = await fetch(`${harness.baseUrl}/mission-control`);
    expect(initial.status).toBe(200);
    const initialBody = (await initial.json()) as {
      summary: { activeProcesses: number };
      control: { writeFreeze: boolean };
    };
    expect(initialBody.control.writeFreeze).toBe(false);
    expect(initialBody.summary.activeProcesses).toBe(1);

    const freeze = await fetch(`${harness.baseUrl}/mission-control/write-freeze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(freeze.status).toBe(200);
    expect(await freeze.json()).toMatchObject({
      control: { writeFreeze: true, effectivePolicyMode: 'readonly' },
    });

    const blockedMutation = await fetch(`${harness.baseUrl}/isolations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'blocked-by-freeze' }),
    });
    expect(blockedMutation.status).toBe(409);
    expect(JSON.stringify(await blockedMutation.json())).toMatch(/readonly/i);

    const blockedMode = await fetch(`${harness.baseUrl}/policy/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'dev' }),
    });
    expect(blockedMode.status).toBe(409);

    const stopped = await fetch(
      `${harness.baseUrl}/mission-control/processes/${managed.sessionId}/stop`,
      { method: 'POST' },
    );
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({
      ok: true,
      data: { sessionId: managed.sessionId, status: 'killed' },
    });

    const unfreeze = await fetch(`${harness.baseUrl}/mission-control/write-freeze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(unfreeze.status).toBe(200);
    expect(await unfreeze.json()).toMatchObject({
      control: { writeFreeze: false, effectivePolicyMode: 'safe' },
    });
  });

  it('creates, reviews, applies, rolls back, and discards a managed isolation through the dashboard', async () => {
    const harness = await startHarness();
    harnesses.push(harness);

    const createdResponse = await fetch(`${harness.baseUrl}/isolations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'dashboard-task' }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      data: { isolation: { id: string; worktreeRoot: string } };
    };
    const isolation = created.data.isolation;
    writeFileSync(join(isolation.worktreeRoot, 'tracked.txt'), 'after\n');

    const diffResponse = await fetch(
      `${harness.baseUrl}/isolations/${isolation.id}/diff`,
    );
    expect(diffResponse.status).toBe(200);
    const diff = (await diffResponse.json()) as { diff: string };
    expect(diff.diff).toContain('after');

    const appliedResponse = await fetch(
      `${harness.baseUrl}/isolations/${isolation.id}/apply`,
      { method: 'POST' },
    );
    expect(appliedResponse.status).toBe(200);
    expect(readFileSync(join(harness.root, 'tracked.txt'), 'utf8')).toBe('after\n');

    const rollbackResponse = await fetch(
      `${harness.baseUrl}/isolations/${isolation.id}/rollback`,
      { method: 'POST' },
    );
    expect(rollbackResponse.status).toBe(200);
    expect(readFileSync(join(harness.root, 'tracked.txt'), 'utf8')).toBe('before\n');

    const discardedResponse = await fetch(
      `${harness.baseUrl}/isolations/${isolation.id}/discard`,
      { method: 'POST' },
    );
    expect(discardedResponse.status).toBe(200);
    const discarded = (await discardedResponse.json()) as {
      data: { isolation: { state: string } };
    };
    expect(discarded.data.isolation.state).toBe('discarded');

    const resolved = harness.container.audit
      .recent(50)
      .filter((event) => event.type === 'approval_resolved');
    expect(resolved.length).toBeGreaterThanOrEqual(3);
  });

});
