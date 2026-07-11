import { describe, it, expect } from 'vitest';
import { ToolRegistry, defineTool } from '../../src/tools/registry.js';
import { toCallToolResult } from '../../src/server/mcp-server.js';
import type { ToolCallControl, ToolResult } from '../../src/core/types.js';
import { SecretPolicy } from '../../src/policy/secret-policy.js';

/**
 * Interactive approval via MCP elicitation.
 *
 * When the connected client advertises the `elicitation` capability the
 * approval-gated tool no longer dead-ends at the dashboard: the registry asks
 * the user to Approve/Deny right in the chat and, on accept, runs the tool.
 * Clients without elicitation keep the original dashboard fallback (a
 * non-`ok` result carrying an approvalId).
 */

interface FakeApprovals {
  created: Array<{ id: string }>;
  approved: Array<{ id: string; scope: string }>;
  denied: string[];
}

function fakeContainer(approvalState: FakeApprovals, auditSummaries: string[] = []) {
  let counter = 0;
  const approvals = {
    create() {
      const id = `appr_${++counter}`;
      approvalState.created.push({ id });
      return { id };
    },
    approve(id: string, scope: string) {
      approvalState.approved.push({ id, scope });
      return { id, tool: 'x', risk: 'HIGH', state: 'approved' };
    },
    deny(id: string) {
      approvalState.denied.push(id);
      return { id, tool: 'x', risk: 'HIGH', state: 'denied' };
    },
  };
  return {
    config: {},
    projectRoot: () => '/tmp',
    audit: { record(event: { summary?: string }) { if (event.summary) auditSummaries.push(event.summary); } },
    rateLimiter: { hit: () => ({ allowed: true }) },
    policy: {
      // Always route this tool to approval so we exercise the new branch.
      evaluate: (_n: string, risk: string) => ({
        kind: 'approval' as const,
        risk,
        approvalId: approvals.create().id,
        reason: 'test approval',
      }),
      approvals,
      secret: new SecretPolicy(),
      command: { classify: () => ({ risk: 'LOW' as const }) },
    },
  };
}

function approvalTool(onRun?: () => void) {
  return defineTool({
    name: 'danger_tool',
    description: 'an approval-gated tool',
    group: 'test',
    mutates: true,
    risk: 'HIGH',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      onRun?.();
      return { ok: true, data: { ran: true } };
    },
  });
}

describe('elicitation-based approval', () => {
  it('runs the tool when the user accepts via elicitation', async () => {
    const state: FakeApprovals = { created: [], approved: [], denied: [] };
    const container = fakeContainer(state);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = new ToolRegistry(container as any);
    let ran = false;
    registry.register(approvalTool(() => (ran = true)));

    const control: ToolCallControl = {
      elicitInput: async () => ({
        action: 'accept',
        content: { approve: true, scope: 'session' },
      }),
    };
    const res = await registry.call('danger_tool', {}, control);
    expect(res.ok).toBe(true);
    expect(ran).toBe(true);
    expect(state.approved).toEqual([{ id: 'appr_1', scope: 'session' }]);
  });

  it('redacts sensitive args from audit summaries and elicitation prompts', async () => {
    const state: FakeApprovals = { created: [], approved: [], denied: [] };
    const summaries: string[] = [];
    const container = fakeContainer(state, summaries);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = new ToolRegistry(container as any);
    registry.register(approvalTool());
    let message = '';

    const res = await registry.call(
      'danger_tool',
      { token: 'plain-token-value', nested: { password: 'plain-password-value', keep: 1 } },
      {
        elicitInput: async (params) => {
          message = params.message;
          return { action: 'accept', content: { approve: true, scope: 'once' } };
        },
      }
    );

    expect(res.ok).toBe(true);
    const evidence = `${summaries.join('\n')}\n${message}`;
    expect(evidence).not.toContain('plain-token-value');
    expect(evidence).not.toContain('plain-password-value');
    expect(evidence).toContain('[REDACTED]');
  });

  it('denies and skips the tool when the user declines', async () => {
    const state: FakeApprovals = { created: [], approved: [], denied: [] };
    const container = fakeContainer(state);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = new ToolRegistry(container as any);
    let ran = false;
    registry.register(approvalTool(() => (ran = true)));

    const control: ToolCallControl = {
      elicitInput: async () => ({ action: 'decline' }),
    };
    const res = await registry.call('danger_tool', {}, control);
    expect(res.ok).toBe(false);
    expect(ran).toBe(false);
    expect(state.denied).toEqual(['appr_1']);
    expect(res.error).toMatch(/not approved/i);
  });

  it('treats accept with approve:false as a denial', async () => {
    const state: FakeApprovals = { created: [], approved: [], denied: [] };
    const container = fakeContainer(state);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = new ToolRegistry(container as any);
    let ran = false;
    registry.register(approvalTool(() => (ran = true)));

    const control: ToolCallControl = {
      elicitInput: async () => ({ action: 'accept', content: { approve: false } }),
    };
    const res = await registry.call('danger_tool', {}, control);
    expect(res.ok).toBe(false);
    expect(ran).toBe(false);
    expect(state.denied).toEqual(['appr_1']);
  });

  it('falls back to the dashboard flow when elicitation is unsupported', async () => {
    const state: FakeApprovals = { created: [], approved: [], denied: [] };
    const container = fakeContainer(state);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = new ToolRegistry(container as any);
    let ran = false;
    registry.register(approvalTool(() => (ran = true)));

    // No elicitInput on the control: original behaviour.
    const res = await registry.call('danger_tool', {}, {});
    expect(res.ok).toBe(false);
    expect(ran).toBe(false);
    expect(res.approvalId).toBe('appr_1');
    expect(res.error).toMatch(/dashboard/i);
  });

  it('falls back to the dashboard when elicitation throws', async () => {
    const state: FakeApprovals = { created: [], approved: [], denied: [] };
    const container = fakeContainer(state);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = new ToolRegistry(container as any);
    registry.register(approvalTool());

    const control: ToolCallControl = {
      elicitInput: async () => {
        throw new Error('transport closed');
      },
    };
    const res = await registry.call('danger_tool', {}, control);
    expect(res.ok).toBe(false);
    expect(res.approvalId).toBe('appr_1');
    expect(res.error).toMatch(/dashboard/i);
  });
});

describe('rich content blocks in tools/call result', () => {
  it('appends an embedded resource block after the text block', () => {
    const result: ToolResult = {
      ok: true,
      data: { diff: '--- a\n+++ b' },
      content: [
        {
          kind: 'resource',
          uri: 'folderforge://diff/working%20tree',
          title: 'git diff (working tree)',
          mimeType: 'text/x-diff',
          text: '--- a\n+++ b',
        },
      ],
    };
    const out = toCallToolResult(result);
    expect(out.content).toHaveLength(2);
    expect(out.content[0]).toMatchObject({ type: 'text' });
    expect(out.content[1]).toMatchObject({
      type: 'resource',
      resource: {
        uri: 'folderforge://diff/working%20tree',
        mimeType: 'text/x-diff',
      },
    });
  });

  it('maps a resource_link block the client can open', () => {
    const out = toCallToolResult({
      ok: true,
      data: { ok: true },
      content: [
        {
          kind: 'resource_link',
          uri: 'file:///tmp/app.ts',
          name: 'app.ts',
          mimeType: 'text/x-typescript',
        },
      ],
    });
    expect(out.content[1]).toMatchObject({
      type: 'resource_link',
      uri: 'file:///tmp/app.ts',
      name: 'app.ts',
    });
  });

  it('still returns just the text block when no content is attached', () => {
    const out = toCallToolResult({ ok: true, data: { a: 1 } });
    expect(out.content).toHaveLength(1);
    expect(out.content[0]).toMatchObject({ type: 'text' });
  });
});
