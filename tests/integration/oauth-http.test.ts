import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import type { ToolDefinition, ToolPrincipal, ToolResult } from '../../src/core/types.js';
import type { ToolRegistry } from '../../src/tools/registry.js';
import { createMcpServer } from '../../src/server/mcp-server.js';
import { startHttpTransport } from '../../src/server/transports/http.js';
import { createOAuthRuntime } from '../../src/server/auth/oauth.js';

interface TestKey {
  kid: string;
  privateKey: KeyLike;
  publicJwk: Record<string, unknown>;
}

interface AuthorizationFixture {
  issuer: string;
  server: HttpServer;
  setKey(key: TestKey): void;
  setPkceMethods(methods: string[]): void;
  setCimdSupported(supported: boolean): void;
  setJwksUri(uri: string): void;
}

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

async function createKey(kid: string): Promise<TestKey> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = (await exportJWK(publicKey)) as Record<string, unknown>;
  return { kid, privateKey, publicJwk: { ...publicJwk, kid, alg: 'RS256', use: 'sig' } };
}

async function startAuthorizationFixture(initialKey: TestKey): Promise<AuthorizationFixture> {
  let currentKey = initialKey;
  let pkceMethods = ['S256'];
  let cimdSupported = true;
  let jwksUri: string | undefined;
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const server = createHttpServer((req, res) => {
    const path = new URL(req.url ?? '/', issuer).pathname;
    if (path === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: jwksUri ?? `${issuer}/jwks`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code'],
          code_challenge_methods_supported: pkceMethods,
          client_id_metadata_document_supported: cimdSupported,
          token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
        })
      );
      return;
    }
    if (path === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ keys: [currentKey.publicJwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  servers.push(server);
  return {
    issuer,
    server,
    setKey(key) {
      currentKey = key;
    },
    setPkceMethods(methods) {
      pkceMethods = methods;
    },
    setCimdSupported(supported) {
      cimdSupported = supported;
    },
    setJwksUri(uri) {
      jwksUri = uri;
    },
  };
}

async function signToken(options: {
  key: TestKey;
  issuer: string;
  audience: string;
  scopes?: string[];
  subject?: string;
  clientId?: string;
  expiresInSeconds?: number;
  notBeforeSeconds?: number;
  tokenType?: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    scope: (options.scopes ?? ['folderforge:read']).join(' '),
    client_id: options.clientId ?? 'chatgpt-test-client',
  })
    .setProtectedHeader({
      alg: 'RS256',
      kid: options.key.kid,
      typ: options.tokenType ?? 'at+jwt',
    })
    .setIssuer(options.issuer)
    .setAudience(options.audience)
    .setSubject(options.subject ?? 'user-123')
    .setIssuedAt(now)
    .setNotBefore(now + (options.notBeforeSeconds ?? 0))
    .setExpirationTime(now + (options.expiresInSeconds ?? 300))
    .sign(options.key.privateKey);
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

async function rpc(
  url: string,
  token: string,
  method: string,
  params: Record<string, unknown> | undefined,
  id: number
): Promise<{ response: Response; message: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
  });
  const text = await response.text();
  return {
    response,
    message: parseRpcResponse(text, response.headers.get('content-type') ?? ''),
  };
}

function tool(name: string, mutates: boolean): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    group: 'test',
    audience: 'agent',
    mutates,
    risk: mutates ? 'HIGH' : 'LOW',
    annotations: {
      title: name,
      readOnlyHint: !mutates,
      destructiveHint: mutates,
      idempotentHint: !mutates,
      openWorldHint: false,
    },
    handler: async () => ({ ok: true }),
  };
}

function createRegistryFixture(): {
  registry: ToolRegistry;
  calls: Array<{ name: string; principal?: ToolPrincipal }>;
} {
  const tools = new Map([
    ['read_test', tool('read_test', false)],
    ['write_test', tool('write_test', true)],
  ]);
  const calls: Array<{ name: string; principal?: ToolPrincipal }> = [];
  const registry = {
    listAgentActive: () => [...tools.values()],
    get: (name: string) => tools.get(name),
    callAgent: async (
      name: string,
      _args: Record<string, unknown>,
      control?: { principal?: ToolPrincipal }
    ): Promise<ToolResult> => {
      calls.push({ name, ...(control?.principal ? { principal: control.principal } : {}) });
      return { ok: true, data: { called: name } };
    },
  } as unknown as ToolRegistry;
  return { registry, calls };
}

async function startOAuthMcp(options?: { key?: TestKey }): Promise<{
  key: TestKey;
  auth: AuthorizationFixture;
  resource: string;
  base: string;
  calls: Array<{ name: string; principal?: ToolPrincipal }>;
}> {
  const key = options?.key ?? (await createKey('key-1'));
  const auth = await startAuthorizationFixture(key);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const resource = `${base}/mcp`;
  const { registry, calls } = createRegistryFixture();
  const server = await startHttpTransport(
    (principal) =>
      createMcpServer(registry, {
        name: 'folderforge-oauth-test',
        version: '0.0.0',
        principal,
      }),
    {
      host: '127.0.0.1',
      port,
      authMode: 'oauth',
      oauth: {
        resource,
        issuer: auth.issuer,
        scopes: ['folderforge:read', 'folderforge:write'],
        readScope: 'folderforge:read',
        writeScope: 'folderforge:write',
        clientRegistration: 'cimd',
        algorithms: ['RS256'],
        clockToleranceSeconds: 0,
        requestTimeoutMs: 2_000,
        jwksCacheTtlMs: 60_000,
        jwksCooldownMs: 0,
        allowInsecureHttpForDevelopment: true,
      },
    }
  );
  servers.push(server);
  return { key, auth, resource, base, calls };
}

describe('OAuth HTTP MCP protocol', () => {
  it('publishes RFC 9728 metadata and a discovery challenge', async () => {
    const fixture = await startOAuthMcp();

    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      const response = await fetch(`${fixture.base}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(await response.json()).toMatchObject({
        resource: fixture.resource,
        authorization_servers: [fixture.auth.issuer],
        scopes_supported: ['folderforge:read', 'folderforge:write'],
        bearer_methods_supported: ['header'],
      });
    }

    const missing = await fetch(`${fixture.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toContain(
      `resource_metadata="${fixture.base}/.well-known/oauth-protected-resource/mcp"`
    );
    expect(missing.headers.get('www-authenticate')).toContain('scope="folderforge:read"');
  });

  it('advertises per-tool OAuth scopes and enforces write scope before execution', async () => {
    const fixture = await startOAuthMcp();
    const readToken = await signToken({
      key: fixture.key,
      issuer: fixture.auth.issuer,
      audience: fixture.resource,
      scopes: ['folderforge:read'],
    });

    const listed = await rpc(`${fixture.base}/mcp`, readToken, 'tools/list', undefined, 2);
    expect(listed.response.status).toBe(200);
    const tools = (listed.message.result as { tools: Array<Record<string, unknown>> }).tools;
    const read = tools.find((entry) => entry.name === 'read_test');
    const write = tools.find((entry) => entry.name === 'write_test');
    expect(read?.securitySchemes ?? (read?._meta as Record<string, unknown>)?.securitySchemes).toEqual([
      { type: 'oauth2', scopes: ['folderforge:read'] },
    ]);
    expect(write?.securitySchemes ?? (write?._meta as Record<string, unknown>)?.securitySchemes).toEqual([
      { type: 'oauth2', scopes: ['folderforge:read', 'folderforge:write'] },
    ]);

    const readCall = await rpc(
      `${fixture.base}/mcp`,
      readToken,
      'tools/call',
      { name: 'read_test', arguments: {} },
      3
    );
    expect((readCall.message.result as { isError?: boolean }).isError).not.toBe(true);
    expect(fixture.calls.map((call) => call.name)).toEqual(['read_test']);
    expect(fixture.calls[0]?.principal).toMatchObject({ role: 'agent', authMode: 'oauth' });

    const denied = await rpc(
      `${fixture.base}/mcp`,
      readToken,
      'tools/call',
      { name: 'write_test', arguments: {} },
      4
    );
    const deniedResult = denied.message.result as {
      isError?: boolean;
      _meta?: Record<string, unknown>;
    };
    expect(deniedResult.isError).toBe(true);
    expect(deniedResult._meta?.['mcp/www_authenticate']).toEqual([
      expect.stringContaining('error="insufficient_scope"'),
    ]);
    expect(fixture.calls.map((call) => call.name)).toEqual(['read_test']);

    const writeToken = await signToken({
      key: fixture.key,
      issuer: fixture.auth.issuer,
      audience: fixture.resource,
      scopes: ['folderforge:read', 'folderforge:write'],
    });
    const allowed = await rpc(
      `${fixture.base}/mcp`,
      writeToken,
      'tools/call',
      { name: 'write_test', arguments: {} },
      5
    );
    expect((allowed.message.result as { isError?: boolean }).isError).not.toBe(true);
    expect(fixture.calls.map((call) => call.name)).toEqual(['read_test', 'write_test']);
  });

  it('fails closed for malformed, expired, not-yet-valid, issuer, audience, and signature failures', async () => {
    const fixture = await startOAuthMcp();
    const otherKey = await createKey('attacker');
    const invalidTokens = [
      'not-a-jwt',
      await signToken({
        key: fixture.key,
        issuer: fixture.auth.issuer,
        audience: fixture.resource,
        expiresInSeconds: -10,
      }),
      await signToken({
        key: fixture.key,
        issuer: fixture.auth.issuer,
        audience: fixture.resource,
        notBeforeSeconds: 60,
      }),
      await signToken({
        key: fixture.key,
        issuer: `${fixture.auth.issuer}/wrong`,
        audience: fixture.resource,
      }),
      await signToken({
        key: fixture.key,
        issuer: fixture.auth.issuer,
        audience: `${fixture.base}/other-resource`,
      }),
      await signToken({
        key: otherKey,
        issuer: fixture.auth.issuer,
        audience: fixture.resource,
      }),
      await signToken({
        key: fixture.key,
        issuer: fixture.auth.issuer,
        audience: fixture.resource,
        tokenType: 'id_token+jwt',
      }),
    ];

    for (const token of invalidTokens) {
      const response = await fetch(`${fixture.base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
    }

    const apiKeyBypass = await fetch(`${fixture.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'legacy-secret' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(apiKeyBypass.status).toBe(401);
  });

  it('accepts a newly rotated JWKS key after an unknown kid refetch', async () => {
    const fixture = await startOAuthMcp();
    const first = await signToken({
      key: fixture.key,
      issuer: fixture.auth.issuer,
      audience: fixture.resource,
    });
    expect((await rpc(`${fixture.base}/mcp`, first, 'tools/list', undefined, 1)).response.status).toBe(200);

    const rotated = await createKey('key-2');
    fixture.auth.setKey(rotated);
    const second = await signToken({
      key: rotated,
      issuer: fixture.auth.issuer,
      audience: fixture.resource,
    });
    expect((await rpc(`${fixture.base}/mcp`, second, 'tools/list', undefined, 2)).response.status).toBe(200);
  });

  it('rejects authorization-server metadata without PKCE S256', async () => {
    const key = await createKey('key-1');
    const auth = await startAuthorizationFixture(key);
    auth.setPkceMethods(['plain']);
    await expect(
      createOAuthRuntime({
        resource: 'http://127.0.0.1:7444/mcp',
        issuer: auth.issuer,
        scopes: ['folderforge:read', 'folderforge:write'],
        readScope: 'folderforge:read',
        writeScope: 'folderforge:write',
        clientRegistration: 'cimd',
        algorithms: ['RS256'],
        allowInsecureHttpForDevelopment: true,
        requestTimeoutMs: 1_000,
      })
    ).rejects.toThrow(/PKCE S256/);
  });

  it('rejects missing CIMD support and a discovered JWKS host with a different port', async () => {
    const key = await createKey('key-1');
    const auth = await startAuthorizationFixture(key);
    const baseConfig = {
      resource: 'http://127.0.0.1:7444/mcp',
      issuer: auth.issuer,
      scopes: ['folderforge:read', 'folderforge:write'],
      readScope: 'folderforge:read',
      writeScope: 'folderforge:write',
      clientRegistration: 'cimd' as const,
      algorithms: ['RS256'],
      allowInsecureHttpForDevelopment: true,
      requestTimeoutMs: 1_000,
    };

    auth.setCimdSupported(false);
    await expect(createOAuthRuntime(baseConfig)).rejects.toThrow(/client_id_metadata_document_supported/);

    auth.setCimdSupported(true);
    auth.setJwksUri('http://127.0.0.1:1/jwks');
    await expect(createOAuthRuntime(baseConfig)).rejects.toThrow(/not trusted/);
  });

});
