import { describe, expect, it, vi } from 'vitest';
import { browserTools } from '../../src/tools/browser-tools.js';
import type { ToolContext } from '../../src/core/types.js';

describe('browser composed flow', () => {
  const flow = browserTools().find((tool) => tool.name === 'browser_flow_run')!;

  it('re-enters the agent registry for every governed action and preserves bounded evidence', async () => {
    const callAgent = vi.fn(async (name: string) => ({
      ok: true,
      data: { name },
      ...(name === 'browser_screenshot'
        ? { content: [{ kind: 'image' as const, mimeType: 'image/png', data: Buffer.alloc(64).toString('base64') }] }
        : {}),
    }));
    const record = vi.fn();
    const ctx = {
      projectRoot: '/tmp/project',
      config: {} as ToolContext['config'],
      control: { principal: { id: 'flow-agent', role: 'agent' as const } },
      container: { registry: { callAgent }, audit: { record } },
    } as ToolContext;
    const result = await flow.handler({
      steps: [
        { name: 'open', action: 'browser_open', args: { url: 'http://localhost:3000' } },
        { action: 'wait', ms: 1 },
        { action: 'browser_screenshot', args: { fullPage: true } },
        { action: 'browser_accessibility_audit' },
      ],
    }, ctx);
    expect(result.ok).toBe(true);
    expect(callAgent.mock.calls.map((call) => call[0])).toEqual([
      'browser_open',
      'browser_screenshot',
      'browser_accessibility_audit',
    ]);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ tool: 'browser_flow_run:wait', ok: true }));
    expect(result.data).toMatchObject({ completedSteps: 4 });
    const evidence = (result.data as { evidence: Array<Record<string, unknown>> }).evidence;
    expect(evidence.find((item) => item.action === 'browser_screenshot')).toMatchObject({
      result: { content: [{ kind: 'image', mimeType: 'image/png', bytes: 64 }] },
    });
  });

  it('forbids arbitrary browser_eval and stops after the first failed step by default', async () => {
    const callAgent = vi.fn(async (name: string) => name === 'browser_click'
      ? { ok: false, error: 'not found' }
      : { ok: true });
    const ctx = {
      projectRoot: '/tmp/project',
      config: {} as ToolContext['config'],
      container: { registry: { callAgent }, audit: { record: vi.fn() } },
    } as ToolContext;
    expect(await flow.handler({ steps: [{ action: 'browser_eval', args: { function: '() => 1' } }] }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining('not allowed') });
    const failed = await flow.handler({ steps: [
      { action: 'browser_open', args: { url: 'http://localhost' } },
      { action: 'browser_click', args: { element: 'button', ref: 'e1' } },
      { action: 'browser_snapshot' },
    ] }, ctx);
    expect(failed).toMatchObject({ ok: false, data: { completedSteps: 2 } });
    expect(callAgent).toHaveBeenCalledTimes(2);
  });
});
