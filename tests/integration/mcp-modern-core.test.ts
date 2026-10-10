import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowManager } from '../../src/workflows/workflow-manager.js';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Container } from '../../src/runtime/container.js';
import { createModernMcpServer } from '../../src/server/protocol/modern-adapter.js';
import type { ToolRegistry } from '../../src/tools/registry.js';

const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'scope-fixture', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
async function call(method: string, principal: any, container?: Container, params: Record<string, unknown> = {}) {
  const registry = {
    listAgentActive: () => [{ name: 'read', audience: 'agent', mutates: false, description: 'read', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }],
    get: () => undefined,
  } as unknown as ToolRegistry;
  const handler = createMcpHandler(
    () => createModernMcpServer(registry, { name: 'test', version: '1', principal, ...(container ? { container } : {}) }),
    { legacy: 'reject' }
  );
  const body = { jsonrpc: '2.0', id: 3, method, params: { ...params, _meta: meta } };
  const response = await handler.fetch(new Request('https://host.invalid/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(method === 'resources/read' ? { 'mcp-name': String(params.uri) } : {}),
    },
    body: JSON.stringify(body),
  }));
  return { status: response.status, data: await response.json() as any };
}
describe('G59 modern principal-scoped core catalog', () => {
  it('does not reveal tools or resources to an OAuth principal missing read scope', async () => {
    const principal = {
      id: 'userA', role: 'agent', authMode: 'oauth',
      scopes: [], readScope: 'folderforge:read', writeScope: 'folderforge:write',
    };
    const container = { mcpTasks: {}, workspace: {}, config: {}, policy: {} } as unknown as Container;
    const tools = await call('tools/list', principal);
    const resources = await call('resources/list', principal, container);
    expect(tools.status).toBe(200);
    expect(tools.data.result.tools).toEqual([]);
    expect(resources.status).toBe(200);
    expect(resources.data.result.resources).toEqual([]);
  });
  it('does not advertise modern tasks/MRTR/list subscription extensions', async () => {
    const res = await call('server/discover', { id: 'userB', role: 'agent', authMode: 'stdio' });
    expect(res.status).toBe(200);
    expect(res.data.result.capabilities.tasks).toBeUndefined();
    expect(res.data.result.capabilities.tools.listChanged).not.toBe(true);
    expect(res.data.result.cacheScope).not.toBe('public');
  });
});


it('G59-SEC-01: modern route cannot mutate the global registry or other principal catalog', async () => {
  let active = ['workspace_route', 'file_read'];
  let writes = 0;
  const definitions = [
    { name: 'workspace_route', audience: 'agent', mutates: false, description: 'route', inputSchema: { type: 'object', properties: {} } },
    { name: 'file_read', audience: 'agent', mutates: false, description: 'read', inputSchema: { type: 'object', properties: {} } },
  ];
  const registry = {
    listAgentActive: () => definitions.filter(t => active.includes(t.name)),
    get: (name: string) => definitions.find(t => t.name === name),
    classifyCall: (name: string) => ({ name, mutates: false, risk: 'LOW' }),
    callAgent: async (name: string) => {
      if (name === 'workspace_route') { active = ['workspace_route']; writes += 1; }
      return { ok: true, data: {} };
    },
  } as unknown as ToolRegistry;
  const principal = { id: 'principal-A', role: 'agent' as const, authMode: 'stdio' as const };
  const handler = createMcpHandler(() => createModernMcpServer(registry, {name: 'test', version: '1', principal}), { legacy: 'reject' });
  const invoke = async (method: string, params: Record<string, unknown> = {}) => {
    const body = { jsonrpc: '2.0', id: 51, method, params: { ...params, _meta: meta }};
    const res = await handler.fetch(new Request('http://local.invalid/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(method === 'tools/call' ? {'mcp-name': 'workspace_route'} : {}) },
      body: JSON.stringify(body),
    }));
    return await res.json() as any;
  };
  const before = await invoke('tools/list');
  expect(before.result.tools.some((t: any) => t.name === 'workspace_route')).toBe(false);
  const callResult = await invoke('tools/call', { name: 'workspace_route', arguments: { preset: 'all' } });
  expect(callResult.result?.isError ?? callResult.error).toBeTruthy();
  expect(writes).toBe(0);
  expect(active).toEqual(['workspace_route', 'file_read']);
});


it('G59-SEC-04: two authorized OAuth principals cannot discover or read unowned shared resource metadata', async () => {
  let processReads = 0;
  const container = {
    mcpTasks: { snapshot: (p: { id: string }) => [{ owner: p.id }] },
    processes: { list: () => { processReads++; return [{ owner: 'principal-A', secret: 'A-PROCESS' }]; } },
    artifacts: { list: () => [{ owner: 'principal-A', id: 'A-ARTIFACT' }], stats: () => ({ count: 1 }) },
    workspace: { getActive: () => ({ projectRoot: '/secret/a' }), list: () => [{ projectRoot: '/secret/a' }] },
    config: { workspace: { allowedDirectories: ['/secret/a'] } },
    policy: { getMode: () => 'readonly', secret: { redactValue: (value: unknown) => value } },
  } as unknown as Container;
  const principal = (id: string) => ({
    id, role: 'agent', authMode: 'oauth', scopes: ['folderforge:read'],
    readScope: 'folderforge:read', writeScope: 'folderforge:write',
  });
  for (const user of ['principal-A', 'principal-B']) {
    const listing = await call('resources/list', principal(user), container);
    expect(listing.status).toBe(200);
    const uris = listing.data.result.resources.map((r: { uri: string }) => r.uri);
    for (const uri of ['folderforge://processes', 'folderforge://artifacts', 'folderforge://workspace/status', 'folderforge://git/status']) {
      expect(uris).not.toContain(uri);
      const denied = await call('resources/read', principal(user), container, { uri });
      expect(denied.data.error).toBeTruthy();
    }
    expect(uris).toContain('folderforge://tasks');
    expect(uris).toContain('folderforge://workflows');
  }
  expect(processReads).toBe(0);
});

it('G59-SEC-01: modern catalog stays fixed when another principal changes legacy global routing', async () => {
  const defs = ['read_a', 'read_b', 'workspace_route'].map(name => ({
    name, audience: 'agent', mutates: false, inputSchema: { type: 'object', properties: {} }, description: name,
  }));
  let legacyActive = new Set(['read_a', 'workspace_route']);
  const registry = {
    listAgentActive: () => defs.filter(t => legacyActive.has(t.name)),
    listAll: () => defs,
    get: (name: string) => defs.find(t => t.name === name),
  } as unknown as ToolRegistry;
  const snapshot = new Set(registry.listAgentActive().map(t => t.name));
  const query = async (id: string) => {
    const handler = createMcpHandler(() => createModernMcpServer(registry, {
      name: 'fixed', version: '1', principal: { id, role: 'agent' },
      allowedToolNames: snapshot,
    }), { legacy: 'reject' });
    const res = await handler.fetch(new Request('https://service.invalid/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: { _meta: meta } }),
    }));
    const json = await res.json() as any;
    return json.result.tools.map((t: any) => t.name).sort();
  };
  expect(await query('principal-A')).toEqual(['read_a']);
  legacyActive = new Set(['read_b', 'workspace_route']);
  expect(await query('principal-B')).toEqual(['read_a']);
});


it('G59-SEC-04: real OAuth workflow resources isolate owners, projects and OAuth clients', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g59-mcp-workflow-owners-'));
  try {
    const workflows = new WorkflowManager(root);
    const owner = (id: string, oauthClientId: string) => ({
      id, role: 'agent' as const, authMode: 'oauth' as const, oauthClientId,
      projectId: 'project:fixture',
      scopes: ['folderforge:read'], readScope: 'folderforge:read', writeScope: 'folderforge:write',
    });
    const alice = owner('oauth:alice', 'client:one');
    const bob = owner('oauth:bob', 'client:one');
    const otherClient = owner('oauth:alice', 'client:other');
    const definition = (name: string) => ({
      name,
      roles: { reader: { allowedTools: ['file_read'] } },
      steps: [{ id: 'step1', role: 'reader', tool: 'file_read', args: { path: 'README.md' } }],
    });
    const aliceRun = workflows.create(definition('ALICE-PRIVATE-MARKER'), alice);
    const bobRun = workflows.create(definition('BOB-PRIVATE-MARKER'), bob);
    const container = {
      workflows, mcpTasks: { snapshot: (p: {id:string}) => [{ owner: p.id }] },
      policy: { secret: { redactValue: (value: unknown) => value } },
    } as unknown as Container;
    const read = async (principal: ReturnType<typeof owner>) => {
      const response = await call('resources/read', principal, container, { uri: 'folderforge://workflows' });
      expect(response.status).toBe(200);
      expect(response.data.error).toBeUndefined();
      return JSON.parse(response.data.result.contents[0].text) as Array<{id: string; name: string}>;
    };
    expect((await read(alice)).map(run => run.id)).toEqual([aliceRun.id]);
    expect((await read(bob)).map(run => run.id)).toEqual([bobRun.id]);
    expect(await read(otherClient)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
