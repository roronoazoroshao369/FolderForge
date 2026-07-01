import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../../src/core/config.js';
import { Container } from '../../src/core/container.js';
import { buildRegistry, registerAdapterTools } from '../../src/tools/index.js';
import { TS_FIXTURE } from './fixtures.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_LARGE = resolve(__dirname, '..', 'fixtures', 'fake-large-mcp-server.mjs');

/**
 * Wire the `serena` adapter slot to a fake 121-tool child MCP server running in
 * facade mode, then build + register tools. Returns the container and registry.
 */
async function setupFacade(mode: 'dev' | 'safe' = 'dev') {
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
    // No flat per-tool namespacing leaked through.
    expect(names.some((n) => n.startsWith('serena__op_'))).toBe(false);

    const list = registry.get('serena__list_tools');
    expect(list?.risk).toBe('LOW');
    expect(list?.mutates).toBe(false);
  });

  it('list_tools filters by substring and paginates', async () => {
    const { container, registry } = await setupFacade();
    teardown = () => container.adapters.stopAll();

    const all = await registry.call('serena__list_tools', {});
    expect(all.ok).toBe(true);
    expect((all.data as { total: number }).total).toBe(121);

    const filtered = await registry.call('serena__list_tools', { name_contains: 'op_01' });
    const data = filtered.data as { total: number; tools: Array<{ name: string }> };
    // op_010 .. op_019 => 10 matches
    expect(data.total).toBe(10);
    expect(data.tools.every((t) => t.name.includes('op_01'))).toBe(true);

    const paged = await registry.call('serena__list_tools', { cursor: 0, limit: 5 });
    const pdata = paged.data as { tools: unknown[]; nextCursor: number | null };
    expect(pdata.tools).toHaveLength(5);
    expect(pdata.nextCursor).toBe(5);
  });

  it('call_tool dispatches a sub-op through to the child', async () => {
    const { container, registry } = await setupFacade();
    teardown = () => container.adapters.stopAll();

    const res = await registry.call('serena__call_tool', {
      tool: 'op_042',
      args: { value: 'hi' },
    });
    expect(res.ok).toBe(true);
    const data = res.data as { content?: Array<{ type: string; text: string }> };
    expect(JSON.parse(data.content?.[0]?.text ?? '{}')).toEqual({ echoed: { value: 'hi' } });
  });

  it('governs a CRITICAL sub-op per-op (not bypassed) - approval-gated in safe mode', async () => {
    const { container, registry } = await setupFacade('safe');
    teardown = () => container.adapters.stopAll();

    // A CRITICAL sub-op is governed per-op: in safe mode it is denied outright
    // (proving the dispatcher is not a governance bypass), never forwarded.
    const res = await registry.call('serena__call_tool', {
      tool: 'danger_eval',
      args: { code: 'get_tree().quit()' },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Denied:.*CRITICAL/i);

    // The audit trail records the REAL sub-tool identity, not just the dispatcher.
    const recent = container.audit.recent(20) as Array<{ tool: string; risk: string }>;
    expect(recent.some((r) => r.tool === 'serena__call_tool:danger_eval')).toBe(true);
  });

  it('a low-risk sub-op runs even in safe mode', async () => {
    const { container, registry } = await setupFacade('safe');
    teardown = () => container.adapters.stopAll();

    // op_* default to MEDIUM/mutates:true; in safe mode a non-approval MEDIUM
    // mutating op still runs (matching flat-adapter behaviour).
    const res = await registry.call('serena__call_tool', { tool: 'op_001', args: {} });
    expect(res.ok).toBe(true);
  });
});
