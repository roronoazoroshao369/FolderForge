import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../../src/core/config.js';
import { Container } from '../../src/core/container.js';
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
      await closeServer(harness.server);
      rmSync(harness.root, { recursive: true, force: true });
    }
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
});
