import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../../src/core/config.js';
import { Container } from '../../src/core/container.js';
import { buildRegistry } from '../../src/tools/index.js';

function writePlugin(source: string, version = '1.0.0'): void {
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'server.mjs'), `
import { createInterface } from 'node:readline';
let dangerCount = 0;
const tools = [
  { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'add', description: 'Add numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
  { name: 'env', description: 'Read test environment', inputSchema: { type: 'object' } },
  { name: 'danger', description: 'Approval-gated operation', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }
];
const rl = createInterface({ input: process.stdin });
const send = (x) => process.stdout.write(JSON.stringify(x) + '\\n');
rl.on('line', (line) => {
  const m = JSON.parse(line); if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'demo', version: '${version}' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  if (m.method === 'tools/call') {
    const n=m.params?.name, a=m.params?.arguments ?? {};
    let text;
    if (n === 'echo') text = String(a.text ?? '');
    else if (n === 'danger') text = String(a.text ?? '') + ':' + String(++dangerCount);
    else if (n === 'env') text = JSON.stringify({ allowed: process.env.PLUGIN_ALLOWED ?? null, secret: process.env.PLUGIN_SECRET ?? null });
    else text = String(Number(a.a ?? 0)+Number(a.b ?? 0));
    return send({ jsonrpc:'2.0', id:m.id, result:{ content:[{ type:'text', text }] } });
  }
});
`);
  writeFileSync(join(source, 'folderforge.plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'demo-plugin',
    name: 'Demo Plugin',
    version,
    compatibility: { folderforge: '>=1.6.0' },
    runtime: { command: 'node', args: ['{pluginDir}/server.mjs'], facade: true },
    permissions: { network: false, filesystem: 'none', env: ['PLUGIN_ALLOWED'] },
    risk: { default: { risk: 'MEDIUM', mutates: true }, tools: {
      echo: { risk: 'LOW', mutates: false },
      add: { risk: 'MEDIUM', mutates: true },
      env: { risk: 'LOW', mutates: false },
      danger: { risk: 'CRITICAL', mutates: true }
    } }
  }, null, 2));
}

function writeBrokenPlugin(source: string, version = '1.2.0'): void {
  writePlugin(source, version);
  writeFileSync(join(source, 'server.mjs'), 'process.exit(1);\n');
}

describe('plugin lifecycle tools', () => {
  let root: string;
  let source: string;
  let container: Container;
  let previousAllowed: string | undefined;
  let previousSecret: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'folderforge-plugin-tools-'));
    source = join(root, 'plugin-source');
    writePlugin(source);
    previousAllowed = process.env.PLUGIN_ALLOWED;
    previousSecret = process.env.PLUGIN_SECRET;
    process.env.PLUGIN_ALLOWED = 'visible-to-plugin';
    process.env.PLUGIN_SECRET = 'must-not-reach-plugin';
    const config = defaultConfig(root);
    config.policy.defaultMode = 'danger';
    config.rateLimit.enabled = false;
    container = new Container(config);
    buildRegistry(container);
  });

  afterEach(() => {
    container.adapters.stopAll();
    if (previousAllowed === undefined) delete process.env.PLUGIN_ALLOWED;
    else process.env.PLUGIN_ALLOWED = previousAllowed;
    if (previousSecret === undefined) delete process.env.PLUGIN_SECRET;
    else process.env.PLUGIN_SECRET = previousSecret;
    rmSync(root, { recursive: true, force: true });
  });

  it('hot-installs, calls, disables, updates, and uninstalls a facade plugin', async () => {
    const registry = container.registry;
    const installed = await registry.call('plugin_install', { source, enable: true });
    expect(installed.ok).toBe(true);
    expect(registry.get('demo-plugin__list_tools')).toBeDefined();
    expect(registry.get('demo-plugin__call_tool')).toBeDefined();

    const catalog = await registry.call('demo-plugin__list_tools', {});
    expect(catalog.ok).toBe(true);
    expect(catalog.data).toMatchObject({
      tools: expect.arrayContaining([expect.objectContaining({ name: 'echo', risk: 'LOW', mutates: false })])
    });

    const echoed = await registry.call('demo-plugin__call_tool', { tool: 'echo', args: { text: 'hello plugin' } });
    expect(echoed.ok).toBe(true);
    expect(echoed.content).toContainEqual({ kind: 'text', text: 'hello plugin' });

    const envResult = await registry.call('demo-plugin__call_tool', { tool: 'env', args: {} });
    expect(envResult.ok).toBe(true);
    const envText = envResult.content?.find((block) => block.kind === 'text')?.text ?? '';
    expect(JSON.parse(envText)).toEqual({ allowed: 'visible-to-plugin', secret: null });
    expect(envText).not.toContain('must-not-reach-plugin');

    const criticalArgs = { tool: 'danger', args: { text: 'approved plugin operation' } };
    const gated = await registry.call('demo-plugin__call_tool', criticalArgs);
    expect(gated.ok).toBe(false);
    expect(gated.approvalId).toBeDefined();
    container.policy.approvals.approve(gated.approvalId!, 'once');
    const approved = await registry.call('demo-plugin__call_tool', criticalArgs);
    expect(approved.ok).toBe(true);
    expect(approved.content).toContainEqual({ kind: 'text', text: 'approved plugin operation:1' });
    const gatedAgain = await registry.call('demo-plugin__call_tool', criticalArgs);
    expect(gatedAgain.approvalId).toBeDefined();

    const invalidUpdate = join(root, 'invalid-update');
    mkdirSync(invalidUpdate, { recursive: true });
    const failedUpdate = await registry.call('plugin_update', {
      id: 'demo-plugin',
      source: invalidUpdate,
    });
    expect(failedUpdate.ok).toBe(false);
    expect(registry.get('demo-plugin__call_tool')).toBeDefined();
    const stillWorks = await registry.call('demo-plugin__call_tool', {
      tool: 'echo',
      args: { text: 'after failed update' },
    });
    expect(stillWorks.ok).toBe(true);
    expect(stillWorks.content).toContainEqual({ kind: 'text', text: 'after failed update' });

    const brokenUpdate = join(root, 'broken-update');
    writeBrokenPlugin(brokenUpdate);
    const activationFailure = await registry.call('plugin_update', {
      id: 'demo-plugin',
      source: brokenUpdate,
    });
    expect(activationFailure.ok).toBe(false);
    expect(container.plugins.inspect('demo-plugin').installed.version).toBe('1.0.0');
    const afterActivationRollback = await registry.call('demo-plugin__call_tool', {
      tool: 'echo',
      args: { text: 'after activation rollback' },
    });
    expect(afterActivationRollback.ok).toBe(true);
    expect(afterActivationRollback.content).toContainEqual({ kind: 'text', text: 'after activation rollback' });

    const health = await registry.call('plugin_health', { id: 'demo-plugin' });
    expect(health.ok).toBe(true);
    expect(health.data).toMatchObject({ ready: true, tools: 4 });

    const disabled = await registry.call('plugin_disable', { id: 'demo-plugin' });
    expect(disabled.ok).toBe(true);
    expect(registry.get('demo-plugin__list_tools')).toBeUndefined();

    const updateSource = join(root, 'plugin-update');
    writePlugin(updateSource, '1.1.0');
    const updated = await registry.call('plugin_update', { id: 'demo-plugin', source: updateSource });
    expect(updated.ok).toBe(true);
    expect(container.plugins.inspect('demo-plugin').installed.version).toBe('1.1.0');

    const enabled = await registry.call('plugin_enable', { id: 'demo-plugin' });
    expect(enabled.ok).toBe(true);
    expect(registry.get('demo-plugin__call_tool')).toBeDefined();

    const removed = await registry.call('plugin_uninstall', { id: 'demo-plugin' });
    expect(removed.ok).toBe(true);
    expect(container.plugins.list()).toEqual([]);
    expect(registry.get('demo-plugin__call_tool')).toBeUndefined();
  });
});
