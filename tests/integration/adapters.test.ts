import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../../src/core/config.js';
import { Container } from '../../src/core/container.js';
import { buildRegistry, registerAdapterTools } from '../../src/tools/index.js';
import { namespacedName, NS_SEP } from '../../src/tools/adapter-tools.js';
import { TS_FIXTURE } from './fixtures.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = resolve(__dirname, '..', 'fixtures', 'fake-mcp-server.mjs');
const DIAGNOSTIC_SERVER = resolve(__dirname, '..', 'fixtures', 'diagnostic-mcp-server.mjs');

/**
 * Build a container whose `serena` adapter points at the fake stdio MCP server,
 * then wire its tools into the registry. Returns both so tests can call tools
 * and shut the child down.
 */
async function setupWithFakeAdapter() {
  const config = loadConfig({ projectRoot: TS_FIXTURE });
  config.policy.defaultMode = 'dev';
  // Point the serena adapter at our fake child MCP server.
  config.adapters.serena = {
    enabled: true,
    command: process.execPath, // node
    args: [FAKE_SERVER],
  };
  const container = new Container(config);
  container.policy.setMode('dev');
  const registry = buildRegistry(container);
  const added = await registerAdapterTools(container, registry);
  return { container, registry, added };
}

describe('child MCP adapter wiring', () => {
  let teardown: (() => void) | null = null;
  afterEach(() => {
    teardown?.();
    teardown = null;
  });

  it('namespacedName joins adapter and tool with the separator', () => {
    expect(namespacedName('serena', 'find_symbol')).toBe(`serena${NS_SEP}find_symbol`);
    expect(NS_SEP).toBe('__');
  });

  it('discovers and namespaces child tools into the registry', async () => {
    const { container, registry, added } = await setupWithFakeAdapter();
    teardown = () => container.adapters.stopAll();

    expect(added).toBe(2);
    const names = registry.listAll().map((t) => t.name);
    expect(names).toContain('serena__echo');
    expect(names).toContain('serena__add');

    // Native tools are still present alongside adapter tools.
    expect(names).toContain('file_read');

    const echo = registry.get('serena__echo');
    expect(echo?.group).toBe('adapter:serena');
  });

  it('proxies a call through the policy + audit pipeline to the child', async () => {
    const { container, registry } = await setupWithFakeAdapter();
    teardown = () => container.adapters.stopAll();

    const res = await registry.call('serena__add', { a: 2, b: 3 });
    expect(res.ok).toBe(true);
    // The fake server returns the sum as a text content block.
    const data = res.data as { content?: Array<{ type: string; text: string }> };
    expect(data.content?.[0]?.text).toBe('5');
  });

  it('skips disabled adapters during discovery', async () => {
    const config = loadConfig({ projectRoot: TS_FIXTURE });
    config.adapters.serena = { enabled: false, command: process.execPath, args: [FAKE_SERVER] };
    const container = new Container(config);
    const registry = buildRegistry(container);
    const added = await registerAdapterTools(container, registry);
    teardown = () => container.adapters.stopAll();

    expect(added).toBe(0);
    expect(registry.listAll().some((t) => t.name.startsWith('serena__'))).toBe(false);
  });

  it('continues degraded without advertising browser wrappers and retains the failure diagnostic', async () => {
    const config = loadConfig({ projectRoot: TS_FIXTURE });
    config.adapters.serena = { enabled: false, command: 'serena', args: [] };
    config.adapters.playwright = {
      enabled: true,
      command: process.execPath,
      args: [DIAGNOSTIC_SERVER, 'exit-before-init'],
    };
    const container = new Container(config);
    const registry = buildRegistry(container);
    teardown = () => container.adapters.stopAll();

    const added = await registerAdapterTools(container, registry);
    const names = registry.listAll().map((tool) => tool.name);
    const status = container.adapters.status().find((adapter) => adapter.name === 'playwright');

    expect(added).toBe(0);
    expect(names.some((name) => name.startsWith('browser_'))).toBe(false);
    expect(status).toMatchObject({
      enabled: true,
      started: false,
      ready: false,
      diagnostic: {
        phase: 'initialize',
        kind: 'invalid_adapter_arguments',
        exitCode: 1,
      },
    });
    expect(status?.diagnostic?.stderrTail).toContain('invalid adapter arguments');
  });

});
