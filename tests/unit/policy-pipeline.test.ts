import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { Container } from '../../src/core/container.js';
import { buildRegistry } from '../../src/tools/index.js';
import type { PolicyMode } from '../../src/core/types.js';
import { TS_FIXTURE } from '../integration/fixtures.js';

/**
 * End-to-end policy pipeline coverage.
 *
 * Exercises the full decision path that runs on every `registry.call()`:
 * risk classification -> mode gating (readonly/safe/dev/danger) -> approval
 * queue (creation, once vs session scope) -> rate-limit interaction -> audit
 * recording. Unit-level behavior of each policy lives in its own test file;
 * this file proves they compose correctly through the registry.
 */

function setup(mode: PolicyMode) {
  const config = loadConfig({ projectRoot: TS_FIXTURE });
  config.policy.defaultMode = mode;
  const container = new Container(config);
  container.policy.setMode(mode);
  const registry = buildRegistry(container);
  return { container, registry };
}

function dailyCount(container: Container, tool: string): number {
  const row = container.rateLimiter.snapshot().find((r) => r.tool === tool);
  return row ? row.dailyCount : 0;
}

describe('policy pipeline: mode gating', () => {
  it('readonly mode denies any mutating tool', async () => {
    const { registry } = setup('readonly');
    const res = await registry.call('file_write', { path: 'x.txt', content: 'hi' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/readonly/i);
  });

  it('readonly mode still allows pure reads', async () => {
    const { registry } = setup('readonly');
    const res = await registry.call('policy_get', {});
    expect(res.ok).toBe(true);
  });

  it('safe mode allows LOW reads without approval', async () => {
    const { registry } = setup('safe');
    const res = await registry.call('workspace_status', {});
    expect(res.ok).toBe(true);
  });
});

describe('policy pipeline: approval gating', () => {
  it('HIGH-risk tool returns an approvalId and creates a pending request', async () => {
    const { container, registry } = setup('safe');
    const before = container.policy.approvals.all().length;
    const res = await registry.call('file_delete', { path: 'src/calculator.ts' });
    expect(res.ok).toBe(false);
    expect(res.approvalId).toBeDefined();
    expect(container.policy.approvals.all().length).toBe(before + 1);
  });

  it('CRITICAL tool is denied outright in safe/dev mode (no approval offered)', async () => {
    const { registry } = setup('dev');
    const res = await registry.call('shell_exec', { command: 'git push --force origin main' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/CRITICAL/i);
    expect(res.approvalId).toBeUndefined();
  });

  it('CRITICAL tool is gated by approval in danger mode by default', async () => {
    const { registry } = setup('danger');
    const res = await registry.call('shell_exec', { command: 'git push --force origin main' });
    expect(res.ok).toBe(false);
    expect(res.approvalId).toBeDefined();
  });

  it('allows CRITICAL actions with the explicit autonomous danger escape hatch', async () => {
    const { container } = setup('danger');
    container.config.policy.allowCriticalInDanger = true;
    const decision = container.policy.evaluate(
      'shell_exec',
      'CRITICAL',
      true,
      { command: 'git push --force origin main' },
      'agent:test'
    );
    expect(decision.kind).toBe('allow');
    expect(container.policy.explain('shell_exec', 'CRITICAL', true).decision).toBe('allow');
  });

  it('a session-scoped approval lets the same tool through next time', async () => {
    const { container, registry } = setup('safe');
    const first = await registry.call('file_delete', { path: 'src/calculator.ts' });
    expect(first.approvalId).toBeDefined();
    container.policy.approvals.approve(first.approvalId!, 'session');

    // The same tool should now pass the gate. file_delete on a missing path
    // fails for an UNRELATED reason (not found), not because it was gated again.
    const second = await registry.call('file_delete', { path: 'does-not-exist.txt' });
    expect(second.approvalId).toBeUndefined();
  });

  it('a once-scoped approval does not grant a standing session allowance', async () => {
    const { container, registry } = setup('safe');
    const first = await registry.call('file_delete', { path: 'a.txt' });
    container.policy.approvals.approve(first.approvalId!, 'once');
    const second = await registry.call('file_delete', { path: 'b.txt' });
    expect(second.approvalId).toBeDefined();
  });
});

describe('policy pipeline: shell_exec runtime risk classification', () => {
  it('benign command runs in dev mode', async () => {
    const { registry } = setup('dev');
    const res = await registry.call('shell_exec', { command: 'echo hello' });
    expect(res.ok).toBe(true);
  });

  it('HIGH command (e.g. git push) is gated by approval', async () => {
    const { registry } = setup('dev');
    const res = await registry.call('shell_exec', { command: 'git push origin main' });
    expect(res.ok).toBe(false);
    expect(res.approvalId).toBeDefined();
  });
});

describe('policy pipeline: audit + rate-limit interaction', () => {
  it('records a tool_call and a terminal event for an allowed call', async () => {
    const { container, registry } = setup('safe');
    await registry.call('workspace_status', {});
    const events = container.audit.recent(20).map((e) => e.type);
    expect(events).toContain('tool_call');
    expect(events.some((t) => t === 'tool_result' || t === 'tool_error')).toBe(true);
  });

  it('records a policy_deny event when a call is denied', async () => {
    const { container, registry } = setup('readonly');
    await registry.call('file_write', { path: 'x.txt', content: 'hi' });
    const events = container.audit.recent(20).map((e) => e.type);
    expect(events).toContain('policy_deny');
  });

  it('denied calls do not consume rate-limit quota', async () => {
    const { container, registry } = setup('readonly');
    const before = dailyCount(container, 'file_write');
    await registry.call('file_write', { path: 'x.txt', content: 'hi' });
    expect(dailyCount(container, 'file_write')).toBe(before);
  });

  it('approval-gated calls do not consume rate-limit quota', async () => {
    const { container, registry } = setup('safe');
    const before = dailyCount(container, 'file_delete');
    await registry.call('file_delete', { path: 'src/calculator.ts' });
    expect(dailyCount(container, 'file_delete')).toBe(before);
  });
});

describe('policy pipeline: unknown tool', () => {
  it('returns a clear error and does not throw', async () => {
    const { registry } = setup('dev');
    const res = await registry.call('not_a_real_tool', {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Unknown tool/);
  });
});
