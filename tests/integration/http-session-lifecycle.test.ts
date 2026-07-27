import { createServer as createNetServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolDefinition, ToolPrincipal, ToolResult } from '../../src/core/types.js';
import { createMcpServer } from '../../src/server/mcp-server.js';
import { startHttpTransport } from '../../src/server/transports/http.js';
import type { ToolRegistry } from '../../src/tools/registry.js';
import type { Server as HttpServer } from 'node:http';

const servers: HttpServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        })
    )
  );
});

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate test port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

function parseRpcResponse(text: string, contentType: string): Record<string, unknown> {
  if (contentType.includes('text/event-stream')) {
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    if (!data.length) throw new Error(`Empty MCP event stream: ${text}`);
    return JSON.parse(data.at(-1)!) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function postRpc(options: {
  base: string;
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  token?: string;
}): Promise<{ response: Response; message?: Record<string, unknown>; text: string }> {
  const response = await fetch(`${options.base}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      connection: 'close',
      ...(options.sessionId ? { 'mcp-session-id': options.sessionId } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      ...(options.id !== undefined ? { id: options.id } : {}),
      method: options.method,
      ...(options.params ? { params: options.params } : {}),
    }),
  });
  const text = await response.text();
  return {
    response,
    text,
    ...(text ? { message: parseRpcResponse(text, response.headers.get('content-type') ?? '') } : {}),
  };
}

async function initialize(base: string, token?: string): Promise<{
  sessionId: string;
  instanceId: string;
}> {
  const initialized = await postRpc({
    base,
    token,
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'folderforge-session-test', version: '1.0.0' },
    },
  });
  expect(initialized.response.status).toBe(200);
  const sessionId = initialized.response.headers.get('mcp-session-id');
  const instanceId = initialized.response.headers.get('x-folderforge-instance-id');
  expect(sessionId).toBeTruthy();
  expect(instanceId).toBeTruthy();
  await postRpc({
    base,
    token,
    sessionId: sessionId!,
    method: 'notifications/initialized',
  });
  return { sessionId: sessionId!, instanceId: instanceId! };
}

function tool(name: string, mutates: boolean): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'number' },
        delayMs: { type: 'number' },
      },
      additionalProperties: false,
    },
    group: 'test',
    audience: 'agent',
    mutates,
    risk: mutates ? 'MEDIUM' : 'LOW',
    annotations: {
      title: name,
      readOnlyHint: !mutates,
      destructiveHint: false,
      idempotentHint: !mutates,
      openWorldHint: false,
    },
    handler: async () => ({ ok: true }),
  };
}

function registryFixture(): {
  registry: ToolRegistry;
  calls: Array<{ name: string; args: Record<string, unknown>; operationId?: string }>;
} {
  const tools = new Map([
    ['read_test', tool('read_test', false)],
    ['write_test', tool('write_test', true)],
  ]);
  const calls: Array<{ name: string; args: Record<string, unknown>; operationId?: string }> = [];
  const registry = {
    listAgentActive: () => [...tools.values()],
    get: (name: string) => tools.get(name),
    classifyCall: (name: string, args: Record<string, unknown>) => {
      const selected = tools.get(name);
      if (!selected) return undefined;
      return {
        name,
        risk: selected.risk,
        mutates: selected.mutates,
        governanceArgs: args,
      };
    },
    callAgent: async (
      name: string,
      args: Record<string, unknown>,
      control?: { principal?: ToolPrincipal; operationId?: string }
    ): Promise<ToolResult> => {
      calls.push({
        name,
        args,
        ...(control?.operationId ? { operationId: control.operationId } : {}),
      });
      const delayMs = typeof args.delayMs === 'number' ? args.delayMs : 5;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (args.value === -1) {
        return {
          ok: false,
          error: 'synthetic policy refusal',
          ...(control?.operationId
            ? { operationId: control.operationId, execution: 'not_started' as const }
            : {}),
        };
      }
      return {
        ok: true,
        data: { callCount: calls.length, value: args.value },
        ...(control?.operationId
          ? { operationId: control.operationId, execution: 'executed' as const }
          : {}),
      };
    },
  } as unknown as ToolRegistry;
  return { registry, calls };
}

async function startFixture(options?: {
  sessionTtlMs?: number;
  token?: string;
  apiKeys?: string[];
  port?: number;
}): Promise<{
  base: string;
  calls: Array<{ name: string; args: Record<string, unknown>; operationId?: string }>;
  server: HttpServer;
}> {
  const port = options?.port ?? (await freePort());
  const { registry, calls } = registryFixture();
  const server = await startHttpTransport(
    (principal) =>
      createMcpServer(registry, {
        name: 'folderforge-http-session-test',
        version: '0.0.0',
        principal,
      }),
    {
      host: '127.0.0.1',
      port,
      ...(options?.token ? { token: options.token, authMode: 'token' as const } : {}),
      ...(options?.apiKeys ? { apiKeys: options.apiKeys } : {}),
      ...(options?.sessionTtlMs !== undefined
        ? { sessionTtlMs: options.sessionTtlMs }
        : {}),
    }
  );
  servers.push(server);
  return { base: `http://127.0.0.1:${port}`, calls, server };
}

function toolPayload(message: Record<string, unknown> | undefined): Record<string, unknown> {
  const result = message?.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
  for (const entry of [...(result?.content ?? [])].reverse()) {
    if (entry.type !== 'text' || !entry.text) continue;
    try {
      const parsed = JSON.parse(entry.text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Human-readable error or diff blocks may precede the structured payload.
    }
  }
  throw new Error(`Missing structured tool payload: ${JSON.stringify(message)}`);
}

describe('HTTP MCP session lifecycle', () => {
  it('keeps one initialized session alive while preserving legacy stateless calls', async () => {
    const fixture = await startFixture();
    const { sessionId, instanceId } = await initialize(fixture.base);

    for (let id = 2; id <= 5; id += 1) {
      const listed = await postRpc({
        base: fixture.base,
        sessionId,
        id,
        method: 'tools/list',
      });
      expect(listed.response.status).toBe(200);
      expect(listed.response.headers.get('x-folderforge-instance-id')).toBe(instanceId);
    }

    const health = await fetch(`${fixture.base}/healthz`);
    expect(await health.json()).toMatchObject({
      ok: true,
      instanceId,
      activeSessions: 1,
    });

    const stateless = await postRpc({
      base: fixture.base,
      id: 99,
      method: 'tools/list',
    });
    expect(stateless.response.status).toBe(200);
    expect(stateless.response.headers.get('mcp-session-id')).toBeNull();
  });

  it('expires idle sessions and rejects their later requests without dropping the server', async () => {
    const fixture = await startFixture({ sessionTtlMs: 40 });
    const { sessionId, instanceId } = await initialize(fixture.base);
    await new Promise((resolve) => setTimeout(resolve, 120));

    const expired = await postRpc({
      base: fixture.base,
      sessionId,
      id: 2,
      method: 'tools/list',
    });
    expect(expired.response.status).toBe(404);

    const health = await fetch(`${fixture.base}/healthz`);
    expect(await health.json()).toMatchObject({
      ok: true,
      instanceId,
      activeSessions: 0,
    });
  });

  it('does not expire a session while a request is still active', async () => {
    const fixture = await startFixture({ sessionTtlMs: 40 });
    const { sessionId } = await initialize(fixture.base);
    const pending = postRpc({
      base: fixture.base,
      sessionId,
      id: 2,
      method: 'tools/call',
      params: { name: 'write_test', arguments: { value: 3, delayMs: 120 } },
    });
    await new Promise((resolve) => setTimeout(resolve, 70));

    const health = await fetch(`${fixture.base}/healthz`);
    expect(await health.json()).toMatchObject({ ok: true, activeSessions: 1 });
    expect((await pending).response.status).toBe(200);
  });

  it('binds a session to the authenticated principal', async () => {
    const fixture = await startFixture({ token: 'client-a', apiKeys: ['client-b'] });
    const { sessionId } = await initialize(fixture.base, 'client-a');

    const denied = await postRpc({
      base: fixture.base,
      token: 'client-b',
      sessionId,
      id: 2,
      method: 'tools/list',
    });
    expect(denied.response.status).toBe(404);

    const allowed = await postRpc({
      base: fixture.base,
      token: 'client-a',
      sessionId,
      id: 3,
      method: 'tools/list',
    });
    expect(allowed.response.status).toBe(200);
  });

  it('replays duplicate mutating request ids without executing twice', async () => {
    const fixture = await startFixture();
    const { sessionId } = await initialize(fixture.base);
    const request = {
      base: fixture.base,
      sessionId,
      id: 20,
      method: 'tools/call',
      params: { name: 'write_test', arguments: { value: 7 } },
    };

    const first = await postRpc(request);
    const second = await postRpc(request);
    const firstPayload = toolPayload(first.message);
    const secondPayload = toolPayload(second.message);

    expect(fixture.calls).toHaveLength(1);
    expect(firstPayload).toMatchObject({ execution: 'executed' });
    expect(secondPayload).toMatchObject({ execution: 'replayed' });
    expect(secondPayload.operationId).toBe(firstPayload.operationId);
  });

  it('preserves a cached not-started outcome on retry', async () => {
    const fixture = await startFixture();
    const { sessionId } = await initialize(fixture.base);
    const request = {
      base: fixture.base,
      sessionId,
      id: 25,
      method: 'tools/call',
      params: { name: 'write_test', arguments: { value: -1 } },
    };

    const first = toolPayload((await postRpc(request)).message);
    const second = toolPayload((await postRpc(request)).message);
    expect(fixture.calls).toHaveLength(1);
    expect(first).toMatchObject({ execution: 'not_started' });
    expect(second).toMatchObject({ execution: 'not_started' });
    expect(second.operationId).toBe(first.operationId);
  });

  it('treats numeric and string JSON-RPC ids as distinct operations', async () => {
    const fixture = await startFixture();
    const { sessionId } = await initialize(fixture.base);
    await postRpc({
      base: fixture.base,
      sessionId,
      id: 26,
      method: 'tools/call',
      params: { name: 'write_test', arguments: { value: 1 } },
    });
    await postRpc({
      base: fixture.base,
      sessionId,
      id: '26',
      method: 'tools/call',
      params: { name: 'write_test', arguments: { value: 2 } },
    });
    expect(fixture.calls).toHaveLength(2);
  });

  it('rejects request-id reuse with different mutation arguments', async () => {
    const fixture = await startFixture();
    const { sessionId } = await initialize(fixture.base);

    const first = await postRpc({
      base: fixture.base,
      sessionId,
      id: 30,
      method: 'tools/call',
      params: { name: 'write_test', arguments: { value: 1 } },
    });
    expect(first.response.status).toBe(200);

    const conflict = await postRpc({
      base: fixture.base,
      sessionId,
      id: 30,
      method: 'tools/call',
      params: { name: 'write_test', arguments: { value: 2 } },
    });
    expect(conflict.response.status).toBe(200);
    expect(conflict.text).toContain('MCP_REQUEST_ID_CONFLICT');
    expect(fixture.calls).toHaveLength(1);
  });

  it('requires reinitialization after a server restart and does not replay old writes', async () => {
    const port = await freePort();
    const first = await startFixture({ port });
    const oldSession = await initialize(first.base);
    await postRpc({
      base: first.base,
      sessionId: oldSession.sessionId,
      id: 40,
      method: 'tools/call',
      params: { name: 'write_test', arguments: { value: 1 } },
    });
    expect(first.calls).toHaveLength(1);

    await new Promise<void>((resolve) => first.server.close(() => resolve()));
    servers.splice(servers.indexOf(first.server), 1);

    const second = await startFixture({ port });
    const stale = await postRpc({
      base: second.base,
      sessionId: oldSession.sessionId,
      id: 40,
      method: 'tools/call',
      params: { name: 'write_test', arguments: { value: 1 } },
    });
    expect(stale.response.status).toBe(404);
    expect(second.calls).toHaveLength(0);

    const fresh = await initialize(second.base);
    expect(fresh.instanceId).not.toBe(oldSession.instanceId);
    const written = await postRpc({
      base: second.base,
      sessionId: fresh.sessionId,
      id: 41,
      method: 'tools/call',
      params: { name: 'write_test', arguments: { value: 2 } },
    });
    expect(written.response.status).toBe(200);
    expect(second.calls).toHaveLength(1);
  });
});
