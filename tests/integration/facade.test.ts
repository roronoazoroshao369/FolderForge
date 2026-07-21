import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { buildRegistry, registerAdapterTools } from '../../src/tools/index.js';
import { TS_FIXTURE } from './fixtures.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_LARGE = resolve(__dirname, '..', 'fixtures', 'fake-large-mcp-server.mjs');

type TestMode = 'readonly' | 'safe' | 'dev' | 'danger';

/**
 * Wire the `serena` adapter slot to a fake 124-tool child MCP server running in
 * facade mode, then build + register tools. Returns the container and registry.
 */
async function setupFacade(mode: TestMode = 'dev') {
  const config = loadConfig({ projectRoot: TS_FIXTURE });
  config.policy.defaultMode = mode;
  config.adapters.serena = {
    enabled: true,
    facade: true,
    command: process.execPath,
    args: [FAKE_LARGE],
  };
  const container = new Container(config);
  container.policy.setMode(mode);
  const registry = buildRegistry(container);
  const added = await registerAdapterTools(container, registry);
  return { container, registry, added };
}

interface AuditEvent {
  type: string;
  tool: string;
  risk: string;
}

function facadeAudit(container: Container): AuditEvent[] {
  return (container.audit.recent(100) as AuditEvent[]).filter((event) =>
    event.tool.startsWith('serena__call_tool')
  );
}

describe('facade adapter (MCP-in-MCP)', () => {
  let teardown: (() => void) | null = null;
  afterEach(() => {
    teardown?.();
    teardown = null;
  });

  it('advertises only the two facade tools regardless of child size', async () => {
    const { container, registry, added } = await setupFacade();
    teardown = () => container.adapters.stopAll();

    expect(added).toBe(2);
    const names = registry.listAll().map((t) => t.name);
    expect(names).toContain('serena__list_tools');
    expect(names).toContain('serena__call_tool');
    expect(names.some((n) => n.startsWith('serena__op_'))).toBe(false);
    expect(registry.get('serena__list_tools')).toMatchObject({ risk: 'LOW', mutates: false });
  });

  it('list_tools filters by substring and paginates', async () => {
    const { container, registry } = await setupFacade();
    teardown = () => container.adapters.stopAll();

    const all = await registry.call('serena__list_tools', {});
    expect(all.ok).toBe(true);
    expect((all.data as { total: number }).total).toBe(124);

    const filtered = await registry.call('serena__list_tools', { name_contains: 'op_01' });
    const data = filtered.data as { total: number; tools: Array<{ name: string }> };
    expect(data.total).toBe(10);
    expect(data.tools.every((t) => t.name.includes('op_01'))).toBe(true);

    const paged = await registry.call('serena__list_tools', { cursor: 0, limit: 5 });
    const pdata = paged.data as { tools: unknown[]; nextCursor: number | null };
    expect(pdata.tools).toHaveLength(5);
    expect(pdata.nextCursor).toBe(5);
  });

  it('dispatches through one governance pipeline and one sub-op audit identity', async () => {
    const { container, registry } = await setupFacade();
    teardown = () => container.adapters.stopAll();

    const res = await registry.call('serena__call_tool', {
      tool: 'op_042',
      args: { value: 'hi' },
    });
    expect(res.ok).toBe(true);
    const data = res.data as { content?: Array<{ type: string; text: string }> };
    expect(JSON.parse(data.content?.[0]?.text ?? '{}')).toEqual({ echoed: { value: 'hi' } });

    const calls = facadeAudit(container).filter((event) => event.type === 'tool_call');
    expect(calls.map((event) => event.tool)).toEqual(['serena__call_tool:op_042']);
    const usage = container.rateLimiter.snapshot();
    expect(usage.find((item) => item.tool === 'serena__call_tool')).toBeUndefined();
    expect(usage.find((item) => item.tool === 'serena__call_tool:op_042')?.windowCount).toBe(1);
  });

  it('denies a CRITICAL sub-op in safe mode without consuming quota', async () => {
    const { container, registry } = await setupFacade('safe');
    teardown = () => container.adapters.stopAll();

    const res = await registry.call('serena__call_tool', {
      tool: 'danger_eval',
      args: { code: 'get_tree().quit()' },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Denied:.*CRITICAL/i);

    const events = facadeAudit(container);
    expect(events.some((event) => event.tool === 'serena__call_tool')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'policy_deny',
      tool: 'serena__call_tool:danger_eval',
    }));
    expect(container.rateLimiter.snapshot().some((item) =>
      item.tool.startsWith('serena__call_tool')
    )).toBe(false);
  });

  it('list_tools ranks by relevance when a query is given', async () => {
    const { container, registry } = await setupFacade();
    teardown = () => container.adapters.stopAll();

    const res = await registry.call('serena__list_tools', { query: 'compile shader' });
    expect(res.ok).toBe(true);
    const data = res.data as {
      ranked: boolean;
      total: number;
      tools: Array<{ name: string; score: number }>;
    };
    expect(data.ranked).toBe(true);
    expect(data.tools[0].name).toBe('compile_shader');
    expect(data.tools[0].score).toBeGreaterThan(0);
    expect(data.total).toBeLessThan(10);
    expect(data.tools.every((t) => t.name !== 'op_000')).toBe(true);

    const plain = await registry.call('serena__list_tools', {});
    expect((plain.data as { ranked: boolean }).ranked).toBe(false);
  });

  it('allows a default MEDIUM mutating sub-op in safe mode', async () => {
    const { container, registry } = await setupFacade('safe');
    teardown = () => container.adapters.stopAll();
    const res = await registry.call('serena__call_tool', { tool: 'op_001', args: {} });
    expect(res.ok).toBe(true);
  });

  it('allows a LOW read-only sub-op in readonly mode with read-only OAuth scope', async () => {
    const { container, registry } = await setupFacade('readonly');
    teardown = () => container.adapters.stopAll();

    const listed = await registry.call('serena__list_tools', { name_contains: 'inspect_state' });
    const tool = (listed.data as {
      tools: Array<{ name: string; risk: string; mutates: boolean }>;
    }).tools[0];
    expect(tool).toMatchObject({ name: 'inspect_state', risk: 'LOW', mutates: false });

    const res = await registry.callAgent(
      'serena__call_tool',
      { tool: 'inspect_state', args: {} },
      {
        principal: {
          id: 'oauth:reader',
          role: 'agent',
          authMode: 'oauth',
          scopes: ['folderforge:read'],
          readScope: 'folderforge:read',
          writeScope: 'folderforge:write',
        },
      }
    );
    expect(res.ok).toBe(true);
    expect(facadeAudit(container).some((event) => event.tool === 'serena__call_tool')).toBe(false);
    expect(facadeAudit(container).some((event) =>
      event.tool === 'serena__call_tool:inspect_state'
    )).toBe(true);
  });

  it('blocks a mutating sub-op in readonly mode without consuming quota', async () => {
    const { container, registry } = await setupFacade('readonly');
    teardown = () => container.adapters.stopAll();

    const res = await registry.call('serena__call_tool', { tool: 'op_001', args: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/readonly/i);
    expect(container.rateLimiter.snapshot().some((item) =>
      item.tool.startsWith('serena__call_tool')
    )).toBe(false);
  });

  it('policy_explain reports the same effective sub-op identity and decision', async () => {
    const { container, registry } = await setupFacade('readonly');
    teardown = () => container.adapters.stopAll();

    const read = await registry.call('policy_explain', {
      tool: 'serena__call_tool',
      args: { tool: 'inspect_state', args: {} },
    });
    expect(read.data).toMatchObject({
      effectiveTool: 'serena__call_tool:inspect_state',
      decision: 'allow',
      risk: 'LOW',
      mutates: false,
    });

    const write = await registry.call('policy_explain', {
      tool: 'serena__call_tool',
      args: { tool: 'op_001', args: {} },
    });
    expect(write.data).toMatchObject({
      effectiveTool: 'serena__call_tool:op_001',
      decision: 'deny',
      risk: 'MEDIUM',
      mutates: true,
    });
  });

  it('binds HIGH approval to exact sub-op args and charges quota only after execution', async () => {
    const { container, registry } = await setupFacade('safe');
    teardown = () => container.adapters.stopAll();
    const control = { principal: { id: 'agent:facade-test', role: 'agent' as const } };

    const first = await registry.call(
      'serena__call_tool',
      { tool: 'sensitive_write', args: { value: 'approved-value' } },
      control
    );
    expect(first.approvalId).toMatch(/^appr_/);
    expect(container.rateLimiter.snapshot().some((item) =>
      item.tool.startsWith('serena__call_tool')
    )).toBe(false);

    container.policy.approvals.approve(first.approvalId!, 'once', 'admin:reviewer');
    const wrongArgs = await registry.call(
      'serena__call_tool',
      { tool: 'sensitive_write', args: { value: 'different-value' } },
      control
    );
    expect(wrongArgs.approvalId).toMatch(/^appr_/);
    expect(wrongArgs.approvalId).not.toBe(first.approvalId);

    const approved = await registry.call(
      'serena__call_tool',
      { tool: 'sensitive_write', args: { value: 'approved-value' } },
      control
    );
    expect(approved.ok).toBe(true);
    const usage = container.rateLimiter.snapshot();
    expect(usage.find((item) => item.tool === 'serena__call_tool')).toBeUndefined();
    expect(usage.find((item) =>
      item.tool === 'serena__call_tool:sensitive_write'
    )?.windowCount).toBe(1);
  });
});
