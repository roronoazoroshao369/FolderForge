import { afterEach, describe, it, expect } from 'vitest';
import { defaultConfig, loadConfig } from '../../src/core/config.js';
import { Container } from '../../src/core/container.js';
import { buildRegistry } from '../../src/tools/index.js';
import type { ToolResult } from '../../src/core/types.js';
import { TS_FIXTURE } from './fixtures.js';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * approval_approve / approval_deny (Godot integration Step 0).
 *
 * These tools let an MCP client resolve a pending HIGH/CRITICAL approval over
 * the tool channel when the dashboard is disabled and the client cannot elicit.
 * They are the prerequisite for shipping any CRITICAL game_* tool.
 */

function setup(mode: 'readonly' | 'safe' | 'dev' | 'danger') {
  const config = loadConfig({ projectRoot: TS_FIXTURE });
  config.policy.defaultMode = mode;
  const container = new Container(config);
  container.policy.setMode(mode);
  const registry = buildRegistry(container);
  return { container, registry };
}

function data<T = Record<string, unknown>>(res: ToolResult): T {
  expect(res.ok).toBe(true);
  return res.data as T;
}

describe('approval_approve / approval_deny', () => {

  const tempRoots: string[] = [];
  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('approves a pending request (once scope)', async () => {
    const { container, registry } = setup('safe');
    const req = container.policy.approvals.create('file_delete', {}, 'HIGH', 'test');
    const out = data<{ state: string; scope: string }>(
      await registry.call('approval_approve', { id: req.id })
    );
    expect(out.state).toBe('approved');
    expect(out.scope).toBe('once');
    expect(container.policy.approvals.get(req.id)?.state).toBe('approved');
  });

  it('approves with session scope so the tool is allowed for the session', async () => {
    const { container, registry } = setup('safe');
    const req = container.policy.approvals.create('file_delete', {}, 'HIGH', 'test');
    await registry.call('approval_approve', { id: req.id, scope: 'session' });
    expect(container.policy.approvals.isSessionAllowed('file_delete')).toBe(true);
  });

  it('denies a pending request', async () => {
    const { container, registry } = setup('safe');
    const req = container.policy.approvals.create('file_delete', {}, 'HIGH', 'test');
    const out = data<{ state: string }>(await registry.call('approval_deny', { id: req.id }));
    expect(out.state).toBe('denied');
    expect(container.policy.approvals.get(req.id)?.state).toBe('denied');
  });

  it('errors on an unknown approval id', async () => {
    const { registry } = setup('safe');
    const res = await registry.call('approval_approve', { id: 'appr_doesnotexist' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });

  it('refuses to re-resolve an already-resolved request', async () => {
    const { container, registry } = setup('safe');
    const req = container.policy.approvals.create('file_delete', {}, 'HIGH', 'test');
    await registry.call('approval_approve', { id: req.id });
    const res = await registry.call('approval_deny', { id: req.id });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already approved/i);
  });

  it('executes an approved once action exactly once without an approval loop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-approval-real-'));
    tempRoots.push(root);
    writeFileSync(join(root, 'delete-me.txt'), 'remove me\n');
    const config = defaultConfig(root);
    config.policy.defaultMode = 'safe';
    config.rateLimit.enabled = false;
    const container = new Container(config);
    container.policy.setMode('safe');
    const registry = buildRegistry(container);
    const args = { path: 'delete-me.txt' };

    const gated = await registry.call('file_delete', args);
    expect(gated.approvalId).toBeDefined();
    await registry.call('approval_approve', { id: gated.approvalId, scope: 'once' });

    const executed = await registry.call('file_delete', args);
    expect(executed.ok).toBe(true);
    expect(existsSync(join(root, 'delete-me.txt'))).toBe(false);

    const third = await registry.call('file_delete', args);
    expect(third.ok).toBe(false);
    expect(third.approvalId).toBeDefined();
    expect(third.approvalId).not.toBe(gated.approvalId);
  });

  it('unblocks a gated tool end-to-end via session approval', async () => {
    const { container, registry } = setup('safe');
    // First call to a HIGH tool creates a pending approval and is gated.
    const gated = await registry.call('file_delete', { path: 'does-not-matter.txt' });
    expect(gated.ok).toBe(false);
    const pending = container.policy.approvals.pending().find((r) => r.tool === 'file_delete');
    expect(pending).toBeDefined();
    // Approve it for the session.
    await registry.call('approval_approve', { id: pending!.id, scope: 'session' });
    expect(container.policy.approvals.isSessionAllowed('file_delete')).toBe(true);
  });
});
