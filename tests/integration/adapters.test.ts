import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { createMcpServer } from '../../src/server/mcp-server.js';
import { buildRegistry, registerAdapterTools } from '../../src/tools/index.js';
import { namespacedName, NS_SEP } from '../../src/tools/adapter-tools.js';
import { TS_FIXTURE } from './fixtures.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = resolve(__dirname, '..', 'fixtures', 'fake-mcp-server.mjs');
const DIAGNOSTIC_SERVER = resolve(__dirname, '..', 'fixtures', 'diagnostic-mcp-server.mjs');

async function within<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

  it('retains direct wrappers when child catalog refresh validation fails', async () => {
    const config = loadConfig({ projectRoot: TS_FIXTURE });
    config.policy.defaultMode = 'dev';
    config.adapters.serena = {
      enabled: true,
      command: process.execPath,
      args: [DIAGNOSTIC_SERVER, 'list-change-invalid-refresh'],
    };
    config.adapters.playwright.enabled = false;
    config.adapters.desktopCommander.enabled = false;
    const container = new Container(config);
    const registry = buildRegistry(container);
    await registerAdapterTools(container, registry);
    teardown = () => container.adapters.stopAll();

    let parentChanges = 0;
    const dispose = registry.onListChanged(() => {
      parentChanges += 1;
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    dispose();

    expect(registry.get('serena__echo-v1')).toBeDefined();
    expect(registry.get('serena__echo-v2')).toBeUndefined();
    expect(parentChanges).toBe(0);
  });

  it('propagates a direct child tool-list change through the parent MCP connection', async () => {
    const config = loadConfig({ projectRoot: TS_FIXTURE });
    config.policy.defaultMode = 'dev';
    config.adapters.serena = {
      enabled: true,
      command: process.execPath,
      args: [DIAGNOSTIC_SERVER, 'list-change-delayed'],
    };
    config.adapters.playwright.enabled = false;
    config.adapters.desktopCommander.enabled = false;
    const container = new Container(config);
    const registry = buildRegistry(container);
    await registerAdapterTools(container, registry);
    teardown = () => container.adapters.stopAll();

    expect(registry.get('serena__echo-v1')).toBeDefined();
    const server = createMcpServer(registry, {
      name: 'folderforge-adapter-refresh-test',
      version: '0.0.0-test',
    });
    const client = new Client(
      { name: 'folderforge-adapter-refresh-client', version: '1.0.0' },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const changed = new Promise<void>((resolveNotification) => {
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          resolveNotification();
        });
      });

      await within(changed);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('serena__echo-v2');
      expect(names).not.toContain('serena__echo-v1');
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
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
