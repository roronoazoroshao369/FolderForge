import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { loadConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { createMcpServer } from '../../src/server/mcp-server.js';
import { buildRegistry, resolveActiveTools } from '../../src/tools/index.js';
import { defineTool, ToolRegistry } from '../../src/tools/registry.js';
import { buildGatewayTools } from '../../src/tools/adaptive-surface.js';
import { workspaceTools } from '../../src/tools/workspace-tools.js';

// --- Minimal fake container (same shape as tests/unit/tool-control.test.ts) ---
function fakeContainer(denyTools: string[] = [], events: Array<Record<string, unknown>> = []) {
  return {
    config: {},
    projectRoot: () => '/tmp',
    audit: {
      record(event: Record<string, unknown>) {
        events.push(event);
      },
    },
    rateLimiter: { hit: () => ({ allowed: true }) },
    policy: {
      evaluate: (name: string) =>
        denyTools.includes(name)
          ? { kind: 'deny' as const, reason: 'no deletes' }
          : { kind: 'allow' as const },
      command: { classify: () => ({ risk: 'LOW' as const }) },
      secret: { redactValue: (value: unknown) => value },
    },
  };
}

function stubTool(
  name: string,
  group: string,
  options: { mutates?: boolean; risk?: 'LOW' | 'MEDIUM' | 'HIGH'; audience?: 'agent' | 'admin' } = {},
) {
  return defineTool({
    name,
    group,
    mutates: options.mutates ?? false,
    risk: options.risk ?? 'LOW',
    audience: options.audience ?? 'agent',
    description: `${name} stub`,
    inputSchema: { type: 'object' },
    handler: async () => ({ ok: true, data: { ran: name } }),
  });
}

describe('adaptive surface — preset resolution (unit)', () => {
  it('adaptive keeps only the typed core present in the registry plus the gateway pair', () => {
    const registry = new ToolRegistry(fakeContainer() as never);
    registry.register(stubTool('file_read', 'file'));
    registry.register(stubTool('git_status', 'git'));
    registry.register(stubTool('secret_scan', 'security'));
    registry.registerAll(buildGatewayTools(registry));

    const adaptive = resolveActiveTools(registry, { preset: 'adaptive' });
    expect(adaptive?.sort()).toEqual(['call_runtime_tool', 'file_read', 'git_status', 'tool_manifest']);

    // Group presets never leak the gateway pair (their group is in no list).
    const vibe = resolveActiveTools(registry, { preset: 'vibe' });
    expect(vibe).toContain('file_read');
    expect(vibe).not.toContain('call_runtime_tool');
    const full = resolveActiveTools(registry, { preset: 'full' });
    expect(full).not.toContain('call_runtime_tool');
    expect(full).not.toContain('tool_manifest');
  });
});

describe('adaptive surface — call_runtime_tool gateway (unit)', () => {
  it('dispatches to the target with its arguments and the same control context', async () => {
    const registry = new ToolRegistry(fakeContainer() as never);
    let seenArgs: Record<string, unknown> | undefined;
    let seenControl: unknown;
    registry.register(
      defineTool({
        name: 'spy_echo',
        description: 'records args and ctx',
        group: 'test',
        mutates: false,
        risk: 'LOW',
        inputSchema: { type: 'object' },
        handler: async (args, ctx) => {
          seenArgs = args;
          seenControl = ctx.control;
          return { ok: true, data: { echoed: args } };
        },
      }),
    );
    registry.registerAll(buildGatewayTools(registry));

    const control = { signal: new AbortController().signal };
    const result = await registry.call(
      'call_runtime_tool',
      { name: 'spy_echo', arguments: { hello: 'world' } },
      control,
    );
    expect(result.ok).toBe(true);
    expect((result.data as { echoed: unknown }).echoed).toEqual({ hello: 'world' });
    expect(seenArgs).toEqual({ hello: 'world' });
    expect(seenControl).toBe(control);
  });

  it('classifyCall re-keys governance to the target, including dynamic shell_exec risk', () => {
    const registry = new ToolRegistry(fakeContainer() as never);
    registry.register(stubTool('shell_exec', 'terminal', { mutates: true, risk: 'MEDIUM' }));
    registry.registerAll(buildGatewayTools(registry));

    const classification = registry.classifyCall('call_runtime_tool', {
      name: 'shell_exec',
      arguments: { command: 'ls' },
    });
    // shell_exec has a minimum HIGH classification even when the command
    // classifier says LOW — the gateway must not dilute it.
    expect(classification?.name).toBe('shell_exec');
    expect(classification?.risk).toBe('HIGH');
    expect(classification?.mutates).toBe(true);
  });

  it('a policy deny keyed on the target stops the gateway call before execution', async () => {
    const events: Array<Record<string, unknown>> = [];
    const registry = new ToolRegistry(fakeContainer(['file_delete'], events) as never);
    let handlerRan = false;
    registry.register(
      defineTool({
        name: 'file_delete',
        description: 'must never run in this test',
        group: 'file',
        mutates: true,
        risk: 'HIGH',
        inputSchema: { type: 'object' },
        handler: async () => {
          handlerRan = true;
          return { ok: true };
        },
      }),
    );
    registry.registerAll(buildGatewayTools(registry));

    const result = await registry.call('call_runtime_tool', {
      name: 'file_delete',
      arguments: { path: 'x' },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Denied: no deletes');
    expect(handlerRan).toBe(false);
    // The audit trail is keyed as the target tool, exactly like a direct call.
    expect(events.some((event) => event.type === 'tool_call' && event.tool === 'file_delete')).toBe(
      true,
    );
  });

  it('refuses recursion, unknown tools, and admin-only tools', async () => {
    const registry = new ToolRegistry(fakeContainer() as never);
    registry.register(stubTool('admin_thing', 'test', { audience: 'admin' }));
    registry.registerAll(buildGatewayTools(registry));

    const recursive = await registry.call('call_runtime_tool', {
      name: 'call_runtime_tool',
      arguments: {},
    });
    expect(recursive.ok).toBe(false);
    expect(recursive.error).toContain('gateway tool');

    const missing = await registry.call('call_runtime_tool', { name: 'no_such_tool' });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('unknown');

    const admin = await registry.call('call_runtime_tool', { name: 'admin_thing' });
    expect(admin.ok).toBe(false);
    expect(admin.error).toContain('admin-only');

    const unnamed = await registry.call('call_runtime_tool', {});
    expect(unnamed.ok).toBe(false);
  });
});

describe('adaptive surface — tool_manifest (unit)', () => {
  it('reports direct, gateway, and unavailable availability', async () => {
    const registry = new ToolRegistry(fakeContainer() as never);
    registry.register(stubTool('visible_tool', 'file'));
    registry.register(stubTool('hidden_tool', 'security'));
    registry.register(stubTool('admin_tool', 'test', { audience: 'admin' }));
    registry.registerAll(buildGatewayTools(registry));
    registry.setActive(['visible_tool', 'call_runtime_tool', 'tool_manifest']);

    const direct = await registry.call('tool_manifest', { name: 'visible_tool' });
    expect(direct.ok).toBe(true);
    expect(direct.data).toMatchObject({
      name: 'visible_tool',
      availability: 'direct',
      mutates: false,
      risk: 'LOW',
      hasOutputSchema: false,
    });

    const gated = await registry.call('tool_manifest', { name: 'hidden_tool' });
    expect(gated.data).toMatchObject({ availability: 'gateway', gatewayTool: 'call_runtime_tool' });

    const missing = await registry.call('tool_manifest', { name: 'nope' });
    expect(missing.data).toMatchObject({ availability: 'unavailable' });

    const admin = await registry.call('tool_manifest', { name: 'admin_tool' });
    expect(admin.data).toMatchObject({ availability: 'unavailable' });

    const unnamed = await registry.call('tool_manifest', { name: '' });
    expect(unnamed.ok).toBe(false);
  });

  it('describes several tools in one batch call via names[]', async () => {
    const registry = new ToolRegistry(fakeContainer() as never);
    registry.register(stubTool('visible_tool', 'file'));
    registry.register(stubTool('hidden_tool', 'security'));
    registry.registerAll(buildGatewayTools(registry));
    registry.setActive(['visible_tool', 'call_runtime_tool', 'tool_manifest']);

    const batch = await registry.call('tool_manifest', {
      names: ['visible_tool', 'hidden_tool', 'nope'],
    });
    expect(batch.ok).toBe(true);
    const manifests = (batch.data as { manifests: Array<Record<string, unknown>> }).manifests;
    expect(manifests).toHaveLength(3);
    expect(manifests[0]).toMatchObject({ name: 'visible_tool', availability: 'direct' });
    expect(manifests[1]).toMatchObject({
      name: 'hidden_tool',
      availability: 'gateway',
      gatewayTool: 'call_runtime_tool',
    });
    expect(manifests[2]).toMatchObject({ name: 'nope', availability: 'unavailable' });
  });
});

// --- Wire-level: real Container + real MCP server over in-memory transport ---

const roots: string[] = [];
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-adaptive-'));
  roots.push(root);
  writeFileSync(join(root, 'hello.txt'), 'adaptive\n');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('adaptive surface over MCP', () => {
  it('lists only the scoped core, hides scope-insufficient tools, and governs gateway calls', async () => {
    const root = project();
    const config = loadConfig({ projectRoot: root });
    config.policy.defaultMode = 'dev';
    config.adapters.serena.enabled = false;
    config.adapters.playwright.enabled = false;
    config.adapters.desktopCommander.enabled = false;
    const container = new Container(config);
    const registry = buildRegistry(container);

    // Token-overhead measurement: unrouted (full) surface vs adaptive listing.
    const fullPayload = JSON.stringify(
      registry
        .listAgentActive()
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        })),
    );
    const fullCount = registry.listAgentActive().length;

    registry.setActive(resolveActiveTools(registry, { preset: 'adaptive' }));

    const principal = {
      id: 'agent:adaptive-test',
      role: 'agent' as const,
      authMode: 'oauth' as const,
      scopes: ['folderforge:read'],
      readScope: 'folderforge:read',
      writeScope: 'folderforge:write',
    };
    const server = createMcpServer(registry, {
      name: 'folderforge-adaptive-test',
      version: '0.0.0-test',
      roots: [root],
      principal,
      hideScopeInsufficientTools: true,
      container,
    });
    const client = new Client({ name: 'adaptive-test-client', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain('file_read'); // read-only core: scope satisfied
      expect(names).toContain('call_runtime_tool');
      expect(names).toContain('tool_manifest');
      expect(names).not.toContain('secret_scan'); // long tail stays behind the gateway
      expect(names).not.toContain('file_write'); // mutating and the principal lacks the write scope

      const adaptivePayload = JSON.stringify(listed.tools);
      console.log(
        `[adaptive-surface] tools/list bytes: full=${fullPayload.length} (${fullCount} tools) ` +
          `adaptive=${adaptivePayload.length} (${names.length} tools) ` +
          `saved=${((1 - adaptivePayload.length / fullPayload.length) * 100).toFixed(1)}%`,
      );
      expect(names.length).toBeLessThanOrEqual(30);
      expect(adaptivePayload.length).toBeLessThan(fullPayload.length / 3);

      // Gateway dispatch over the wire: a read-only target passes the scope gate.
      const okCall = await client.callTool({
        name: 'call_runtime_tool',
        arguments: { name: 'workspace_status', arguments: {} },
      });
      expect(okCall.isError).not.toBe(true);

      // A mutating target through the gateway is still scope-gated.
      const denied = await client.callTool({
        name: 'call_runtime_tool',
        arguments: { name: 'file_write', arguments: { path: 'x.txt', content: 'x' } },
      });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied.content)).toContain('scope');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('runtime routing to adaptive enables scope-hiding even without the startup flag', async () => {
    const root = project();
    const config = loadConfig({ projectRoot: root });
    config.policy.defaultMode = 'dev';
    config.adapters.serena.enabled = false;
    config.adapters.playwright.enabled = false;
    config.adapters.desktopCommander.enabled = false;
    const container = new Container(config);
    const registry = buildRegistry(container);

    // Server starts on the vibe surface WITHOUT the scope-hiding flag.
    registry.setActive(resolveActiveTools(registry, { preset: 'vibe' }));
    const principal = {
      id: 'agent:adaptive-route-test',
      role: 'agent' as const,
      authMode: 'oauth' as const,
      scopes: ['folderforge:read'],
      readScope: 'folderforge:read',
      writeScope: 'folderforge:write',
    };
    const server = createMcpServer(registry, {
      name: 'folderforge-adaptive-route-test',
      version: '0.0.0-test',
      roots: [root],
      principal,
      container,
    });
    const client = new Client({ name: 'adaptive-route-client', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const before = (await client.listTools()).tools.map((tool) => tool.name);
      expect(before).toContain('file_write'); // vibe annotates scopes but does not hide
      expect(before).not.toContain('call_runtime_tool');

      // Route the session onto the adaptive surface at runtime.
      const routed = await client.callTool({
        name: 'workspace_route',
        arguments: { preset: 'adaptive' },
      });
      expect(routed.isError).not.toBe(true);

      const routedNames = (await client.listTools()).tools.map((tool) => tool.name);
      expect(routedNames).toContain('call_runtime_tool');
      expect(routedNames).toContain('file_read');
      // Scope-hiding followed the active surface: mutating tools hide for a
      // read-only principal, matching the startup-preset behavior.
      expect(routedNames).not.toContain('file_write');

      // Routing back restores the unfiltered listing.
      await client.callTool({ name: 'workspace_route', arguments: { reset: true } });
      const restored = (await client.listTools()).tools.map((tool) => tool.name);
      expect(restored).toContain('file_write');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('workspace_route — runtime routing to the adaptive surface', () => {
  it('switches to the adaptive tool set and back, keeping recovery tools visible', async () => {
    const container = fakeContainer() as unknown as { registry?: ToolRegistry } & Record<
      string,
      unknown
    >;
    const registry = new ToolRegistry(container as never);
    container.registry = registry;
    registry.register(stubTool('file_read', 'file'));
    registry.register(stubTool('secret_scan', 'security'));
    registry.registerAll(workspaceTools());
    registry.registerAll(buildGatewayTools(registry));

    const route = workspaceTools().find((tool) => tool.name === 'workspace_route');
    expect(route).toBeDefined();
    const ctx = { config: {}, projectRoot: '/tmp', container } as never;

    const routed = await route!.handler({ preset: 'adaptive' }, ctx);
    expect(routed.ok).toBe(true);
    const active = registry.listAgentActive().map((tool) => tool.name);
    expect(active).toContain('call_runtime_tool');
    expect(active).toContain('tool_manifest');
    expect(active).toContain('file_read'); // typed core stays direct
    expect(active).not.toContain('secret_scan'); // long tail moves behind the gateway
    expect(active).not.toContain('workspace_onboard'); // non-core workspace tools hide too
    // Recovery tools stay visible so the agent can route back without reconnecting.
    expect(active).toContain('workspace_route');
    expect(active).toContain('workspace_list');

    const restored = await route!.handler({ reset: true }, ctx);
    expect(restored.ok).toBe(true);
    expect(registry.listAgentActive().map((tool) => tool.name)).toContain('secret_scan');
  });
});
