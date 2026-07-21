import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, loadConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { buildRegistry } from '../../src/tools/index.js';
import type { ToolPrincipal, ToolResult } from '../../src/core/types.js';
import { TS_FIXTURE } from './fixtures.js';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const AGENT: ToolPrincipal = { id: 'principal:agent-a', role: 'agent' };
const OTHER_AGENT: ToolPrincipal = { id: 'principal:agent-b', role: 'agent' };
const ADMIN: ToolPrincipal = { id: 'principal:admin', role: 'admin' };

function setup(mode: 'readonly' | 'safe' | 'dev' | 'danger') {
  const config = loadConfig({ projectRoot: TS_FIXTURE });
  config.policy.defaultMode = mode;
  config.rateLimit.enabled = false;
  const container = new Container(config);
  container.policy.setMode(mode);
  const registry = buildRegistry(container);
  return { container, registry };
}

function data<T = Record<string, unknown>>(res: ToolResult): T {
  expect(res.ok).toBe(true);
  return res.data as T;
}

describe('P0 authorization boundary', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('does not advertise approval resolution or runtime policy mutation to agents', () => {
    const { registry } = setup('safe');
    const names = new Set(registry.listAgentActive().map((tool) => tool.name));
    expect(names.has('approval_approve')).toBe(false);
    expect(names.has('approval_deny')).toBe(false);
    expect(names.has('policy_set_mode')).toBe(false);
    expect(names.has('approval_status')).toBe(true);
  });

  it('does not leak admin tool names through workspace routing responses', async () => {
    const { registry } = setup('safe');
    const routed = data<{ active: string[] }>(
      await registry.callAgent('workspace_route', { preset: 'all' }, { principal: AGENT })
    );
    expect(routed.active).toContain('approval_status');
    expect(routed.active).not.toContain('approval_approve');
    expect(routed.active).not.toContain('approval_deny');
    expect(routed.active).not.toContain('policy_set_mode');
  });

  it('blocks direct agent calls to admin tools without mutating state', async () => {
    const { container, registry } = setup('safe');
    const request = container.policy.approvals.create(
      'file_delete',
      { path: 'x.txt' },
      'HIGH',
      'test',
      AGENT.id
    );

    const approve = await registry.callAgent(
      'approval_approve',
      { id: request.id },
      { principal: AGENT }
    );
    expect(approve.ok).toBe(false);
    expect(approve.error).toMatch(/admin-only/i);
    expect(container.policy.approvals.get(request.id)?.state).toBe('pending');

    const escalate = await registry.callAgent(
      'policy_set_mode',
      { mode: 'danger' },
      { principal: AGENT }
    );
    expect(escalate.ok).toBe(false);
    expect(escalate.error).toMatch(/admin-only/i);
    expect(container.policy.getMode()).toBe('safe');
  });

  it('rejects approval by the same principal even when presented with an admin role', async () => {
    const { container, registry } = setup('safe');
    const request = container.policy.approvals.create(
      'file_delete',
      { path: 'x.txt' },
      'HIGH',
      'test',
      AGENT.id
    );

    const result = await registry.call(
      'approval_approve',
      { id: request.id },
      { principal: { id: AGENT.id, role: 'admin' } }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot approve its own request/i);
    expect(container.policy.approvals.get(request.id)?.state).toBe('pending');
  });

  it('allows a distinct admin principal to approve or deny', async () => {
    const { container, registry } = setup('safe');
    const approveRequest = container.policy.approvals.create(
      'file_delete',
      { path: 'x.txt' },
      'HIGH',
      'test',
      AGENT.id
    );
    const approved = data<{ state: string; approverId: string }>(
      await registry.call(
        'approval_approve',
        { id: approveRequest.id },
        { principal: ADMIN }
      )
    );
    expect(approved.state).toBe('approved');
    expect(approved.approverId).toBe(ADMIN.id);

    const denyRequest = container.policy.approvals.create(
      'file_delete',
      { path: 'y.txt' },
      'HIGH',
      'test',
      AGENT.id
    );
    const denied = data<{ state: string; approverId: string }>(
      await registry.call('approval_deny', { id: denyRequest.id }, { principal: ADMIN })
    );
    expect(denied.state).toBe('denied');
    expect(denied.approverId).toBe(ADMIN.id);
  });

  it('binds a once approval to requester and exact arguments and consumes it once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-approval-boundary-'));
    tempRoots.push(root);
    writeFileSync(join(root, 'delete-me.txt'), 'remove me\n');

    const config = defaultConfig(root);
    config.policy.defaultMode = 'safe';
    config.rateLimit.enabled = false;
    const container = new Container(config);
    container.policy.setMode('safe');
    const registry = buildRegistry(container);
    const args = { path: 'delete-me.txt' };

    const gated = await registry.callAgent('file_delete', args, { principal: AGENT });
    expect(gated.approvalId).toBeDefined();
    await registry.call(
      'approval_approve',
      { id: gated.approvalId, scope: 'once' },
      { principal: ADMIN }
    );

    const wrongRequester = await registry.callAgent('file_delete', args, {
      principal: OTHER_AGENT,
    });
    expect(wrongRequester.approvalId).toBeDefined();
    expect(existsSync(join(root, 'delete-me.txt'))).toBe(true);

    const wrongArgs = await registry.callAgent(
      'file_delete',
      { path: 'other.txt' },
      { principal: AGENT }
    );
    expect(wrongArgs.approvalId).toBeDefined();
    expect(existsSync(join(root, 'delete-me.txt'))).toBe(true);

    const executed = await registry.callAgent('file_delete', args, { principal: AGENT });
    expect(executed.ok).toBe(true);
    expect(existsSync(join(root, 'delete-me.txt'))).toBe(false);

    const replay = await registry.callAgent('file_delete', args, { principal: AGENT });
    expect(replay.ok).toBe(false);
    expect(replay.approvalId).toBeDefined();
    expect(replay.approvalId).not.toBe(gated.approvalId);
  });

  it('binds session approval to the requester principal', async () => {
    const { container, registry } = setup('safe');
    const gated = await registry.callAgent(
      'file_delete',
      { path: 'missing.txt' },
      { principal: AGENT }
    );
    expect(gated.approvalId).toBeDefined();
    await registry.call(
      'approval_approve',
      { id: gated.approvalId, scope: 'session' },
      { principal: ADMIN }
    );

    expect(container.policy.approvals.isSessionAllowed('file_delete', AGENT.id)).toBe(true);
    expect(container.policy.approvals.isSessionAllowed('file_delete', OTHER_AGENT.id)).toBe(false);

    const sameRequester = await registry.callAgent(
      'file_delete',
      { path: 'missing.txt' },
      { principal: AGENT }
    );
    expect(sameRequester.approvalId).toBeUndefined();
    expect(sameRequester.error).toMatch(/does not exist|not found/i);

    const otherRequester = await registry.callAgent(
      'file_delete',
      { path: 'missing.txt' },
      { principal: OTHER_AGENT }
    );
    expect(otherRequester.approvalId).toBeDefined();
  });
});
