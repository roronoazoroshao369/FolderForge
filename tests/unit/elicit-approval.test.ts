import { describe, expect, it } from 'vitest';
import { ToolRegistry, defineTool } from '../../src/tools/registry.js';
import { toCallToolResult } from '../../src/server/mcp-server.js';
import type { ToolCallControl, ToolResult } from '../../src/core/types.js';
import { SecretPolicy } from '../../src/policy/secret-policy.js';

interface FakeApprovalState {
  created: string[];
}

function fakeContainer(state: FakeApprovalState, auditSummaries: string[] = []) {
  let counter = 0;
  return {
    config: {},
    projectRoot: () => '/tmp',
    audit: {
      record(event: { summary?: string }) {
        if (event.summary) auditSummaries.push(event.summary);
      },
    },
    rateLimiter: { hit: () => ({ allowed: true }) },
    policy: {
      evaluate: (_name: string, risk: string) => {
        const id = `appr_${++counter}`;
        state.created.push(id);
        return {
          kind: 'approval' as const,
          risk,
          approvalId: id,
          reason: 'test approval',
        };
      },
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

describe('approval separation from MCP elicitation', () => {
  it('never lets the requesting MCP client resolve its own approval', async () => {
    const state: FakeApprovalState = { created: [] };
    const container = fakeContainer(state);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = new ToolRegistry(container as any);
    let ran = false;
    let elicited = false;
    registry.register(approvalTool(() => (ran = true)));

    const control: ToolCallControl = {
      principal: { id: 'principal:agent', role: 'agent' },
      elicitInput: async () => {
        elicited = true;
        return { action: 'accept', content: { approve: true, scope: 'session' } };
      },
    };
    const result = await registry.callAgent('danger_tool', {}, control);

    expect(result.ok).toBe(false);
    expect(result.approvalId).toBe('appr_1');
    expect(result.error).toMatch(/dashboard admin plane/i);
    expect(elicited).toBe(false);
    expect(ran).toBe(false);
    expect(state.created).toEqual(['appr_1']);
  });

  it('redacts sensitive arguments from the audit evidence without prompting the agent', async () => {
    const state: FakeApprovalState = { created: [] };
    const summaries: string[] = [];
    const container = fakeContainer(state, summaries);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = new ToolRegistry(container as any);
    registry.register(approvalTool());
    const token = ['plain', 'token', 'value'].join('-');
    const password = ['plain', 'password', 'value'].join('-');

    const result = await registry.callAgent(
      'danger_tool',
      { token, nested: { password, keep: 1 } },
      { principal: { id: 'principal:agent', role: 'agent' } }
    );

    expect(result.ok).toBe(false);
    const evidence = summaries.join('\n');
    expect(evidence).not.toContain(token);
    expect(evidence).not.toContain(password);
    expect(evidence).toContain('[REDACTED]');
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
