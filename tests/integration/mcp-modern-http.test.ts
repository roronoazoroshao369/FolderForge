import { afterEach, describe, expect, it } from 'vitest';
import type { Server as NodeServer } from 'node:http';
import { createMcpServer } from '../../src/server/mcp-server.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHttpTransport } from '../../src/server/transports/http.js';
import { createModernMcpServer } from '../../src/server/protocol/modern-adapter.js';
import type { ToolRegistry } from '../../src/tools/registry.js';

const servers: NodeServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
  }
});

const metadata = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'G59-test-client', version: '1.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

const testTool = (name: string, mutates: boolean) => ({
  name, description: name,
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
  group: 'file', audience: 'agent', mutates, risk: mutates ? 'MEDIUM' : 'LOW',
});

async function fixture() {
  let reads = 0;
  let writes = 0;
  const defs = [testTool('file_read', false), testTool('file_write', true)];
  const registry = {
    listAgentActive: () => defs,
    get: (name: string) => defs.find(d => d.name === name),
    classifyCall: (name: string, args: Record<string, unknown>) => ({ mutates: name === 'file_write' || args.path === '/danger' }),
    callAgent: async (name: string) => {
      if (name === 'file_write') writes++;
      else reads++;
      return { ok: true, data: { text: 'hello' } };
    },
    onListChanged: () => () => undefined,
  } as unknown as ToolRegistry;
  const server = await startHttpTransport(
    principal => createMcpServer(registry, { name: 'test', version: '1.0', principal }),
    {
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      protocolMode: 'dual',
      modernServerFactory: principal => createModernMcpServer(registry, {
        name: 'test', version: '1.0', principal,
      }),
    }
  );
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('not bound');
  const base = `http://127.0.0.1:${address.port}/mcp`;
  async function call(method: string, params: Record<string, unknown> = {}, extra: Record<string, string> = {}) {
    const data = { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: metadata } };
    const response = await fetch(base, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        ...(['tools/call', 'prompts/get', 'resources/read'].includes(method)
          ? { 'mcp-name': String(params.name ?? params.uri) } : {}),
        ...extra,
      },
      body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() as any };
  }
  return { call, base, reads: () => reads, writes: () => writes };
}

describe('G59 opt-in modern HTTP', () => {
  it('interoperates with the pinned official v2 modern HTTP client', async () => {
    const x = await fixture();
    const client = new Client(
      { name: 'folderforge-g59-conformance', version: '1.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(x.base), {
      requestInit: { headers: { authorization: 'Bearer test-token' } },
    });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.some(t => t.name === 'file_read')).toBe(true);
      const called = await client.callTool({ name: 'file_read', arguments: { path: '/tmp/file' } });
      expect(called.isError).not.toBe(true);
      expect(x.reads()).toBe(1);
    } finally {
      await client.close();
    }
  });
  it('handles server/discover and tools/list on the official stateless binding', async () => {
    const x = await fixture();
    const discovered = await x.call('server/discover');
    expect(discovered.status).toBe(200);
    expect(discovered.body.result.supportedVersions).toContain('2026-07-28');
    const listed = await x.call('tools/list');
    expect(listed.status).toBe(200);
    expect(listed.body.result.tools.some((t: any) => t.name === 'file_read')).toBe(true);
  });
  it('routes read-only calls via registry and denies mutation with zero side effects', async () => {
    const x = await fixture();
    const read = await x.call('tools/call', { name: 'file_read', arguments: { path: '/tmp/a' } });
    expect(read.status).toBe(200);
    expect(read.body.result.resultType).toBe('complete');
    expect(x.reads()).toBe(1);
    const denied = await x.call('tools/call', { name: 'file_write', arguments: { path: '/tmp/a' } });
    expect(denied.body.result?.isError ?? denied.body.error).toBeTruthy();
    expect(x.writes()).toBe(0);
  });
  it('denies dynamically mutating calls across multiple HTTP exchanges', async () => {
    const x = await fixture();
    const first = await x.call('tools/call', { name: 'file_read', arguments: { path: '/danger' } });
    const second = await x.call('tools/call', { name: 'file_read', arguments: { path: '/danger' } });
    expect(first.body.result?.isError ?? first.body.error).toBeTruthy();
    expect(second.body.result?.isError ?? second.body.error).toBeTruthy();
    expect(x.reads()).toBe(0);
    expect(x.writes()).toBe(0);
  });
  it('rejects unauthenticated and spoofed mirrored name/version', async () => {
    const x = await fixture();
    const bad = await x.call('tools/call', { name: 'file_read', arguments: {} }, { 'mcp-name': 'file_write' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe(-32020);
    const unauth = await fetch(x.base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauth.status).toBe(401);
    expect(x.reads()).toBe(0);
  });
  it('rejects DNS rebinding via a forged Host and same-host Origin', async () => {
    const x = await fixture();
    const bad = await x.call('tools/list', {}, { origin: 'https://evil.example', host: 'evil.example' });
    expect(bad.status).toBe(403);
    expect(x.reads()).toBe(0);
  });
  it('preserves legacy HTTP initialize when version header names a legacy revision', async () => {
    const x = await fixture();
    const response = await fetch(x.base, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'mcp-protocol-version': '2025-11-25',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } },
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeTruthy();
  });
  it('rejects a modern-body request carrying a live legacy session before any write dispatch', async () => {
    const x = await fixture();
    const init = await fetch(x.base, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } },
      }),
    });
    expect(init.status).toBe(200);
    const id = init.headers.get('mcp-session-id');
    expect(id).toBeTruthy();

    // Conflicting modern _meta with a legacy version header and live legacy
    // session must NOT reach the old SDK's mutating tools/call handler.
    const attempted = await x.call('tools/call',
      { name: 'file_write', arguments: { path: '/danger' } },
      { 'mcp-session-id': id!, 'mcp-protocol-version': '2025-11-25' },
    );
    expect(attempted.status).toBe(400);
    expect(x.writes()).toBe(0);
  });
  it('denies cross-origin requests before dispatch', async () => {
    const x = await fixture();
    const bad = await x.call('tools/list', {}, { origin: 'https://evil.example' });
    expect(bad.status).toBe(403);
    expect(x.reads()).toBe(0);
  });
});
