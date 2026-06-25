import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { Container } from '../../src/core/container.js';
import { buildRegistry } from '../../src/tools/index.js';
import type { ToolResult } from '../../src/core/types.js';
import { TS_FIXTURE } from './fixtures.js';

function setup(mode: 'readonly' | 'safe' | 'dev' | 'danger') {
  const config = loadConfig({ projectRoot: TS_FIXTURE });
  config.policy.defaultMode = mode;
  const container = new Container(config);
  container.policy.setMode(mode);
  const registry = buildRegistry(container);
  return { container, registry };
}

interface Explanation {
  tool: string;
  decision: 'allow' | 'deny' | 'approval';
  risk: string;
  reason: string;
  mode: string;
  factors: string[];
}

function explain(res: ToolResult): Explanation {
  expect(res.ok).toBe(true);
  return res.data as Explanation;
}

describe('policy_explain tool', () => {
  it('explains an allowed read in safe mode', async () => {
    const { registry } = setup('safe');
    const out = explain(await registry.call('policy_explain', { tool: 'file_read' }));
    expect(out.decision).toBe('allow');
    expect(out.mode).toBe('safe');
  });

  it('explains a denied mutation in readonly mode', async () => {
    const { registry } = setup('readonly');
    const out = explain(await registry.call('policy_explain', { tool: 'file_write' }));
    expect(out.decision).toBe('deny');
    expect(out.reason).toMatch(/readonly/i);
    expect(out.factors.join(' ')).toMatch(/readonly/i);
  });

  it('explains that file_delete needs approval in safe mode', async () => {
    const { registry } = setup('safe');
    const out = explain(await registry.call('policy_explain', { tool: 'file_delete' }));
    expect(out.decision).toBe('approval');
    expect(out.factors.join(' ')).toMatch(/requireApproval/);
  });

  it('classifies shell_exec risk from the command', async () => {
    const { registry } = setup('dev');
    const dangerous = explain(
      await registry.call('policy_explain', { tool: 'shell_exec', args: { command: 'rm -rf /' } })
    );
    expect(dangerous.risk).toBe('CRITICAL');
    expect(dangerous.decision).toBe('deny');

    const safe = explain(
      await registry.call('policy_explain', { tool: 'shell_exec', args: { command: 'ls -la' } })
    );
    expect(safe.decision).toBe('allow');
  });

  it('does NOT create an approval request (no side effects)', async () => {
    const { container, registry } = setup('safe');
    const before = container.policy.approvals.all().length;
    await registry.call('policy_explain', { tool: 'file_delete' });
    const after = container.policy.approvals.all().length;
    expect(after).toBe(before);
  });

  it('errors on an unknown tool', async () => {
    const { registry } = setup('dev');
    const res = await registry.call('policy_explain', { tool: 'nope_not_real' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Unknown tool/);
  });
});
