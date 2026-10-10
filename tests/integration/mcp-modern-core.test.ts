import { describe, it, expect } from 'vitest';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Container } from '../../src/runtime/container.js';
import { createModernMcpServer } from '../../src/server/protocol/modern-adapter.js';
import type { ToolRegistry } from '../../src/tools/registry.js';

const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'scope-fixture', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
async function call(method: string, principal: any, container?: Container) {
  const registry = {
    listAgentActive: () => [{ name: 'read', audience: 'agent', mutates: false, description: 'read', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }],
    get: () => undefined,
  } as unknown as ToolRegistry;
  const handler = createMcpHandler(
    () => createModernMcpServer(registry, { name: 'test', version: '1', principal, ...(container ? { container } : {}) }),
    { legacy: 'reject' }
  );
  const body = { jsonrpc: '2.0', id: 3, method, params: { _meta: meta } };
  const response = await handler.fetch(new Request('https://host.invalid/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
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
