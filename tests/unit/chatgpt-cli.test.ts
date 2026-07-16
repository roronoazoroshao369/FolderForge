import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import YAML from 'yaml';
import {
  executeChatGptCli,
  normalizeMcpUrl,
  parseChatGptArgs,
  readConnectionReceipt,
  writeConnectionReceipt,
  type ChatGptConnectionReceipt,
} from '../../src/chatgpt/cli.js';

const originalFetch = globalThis.fetch;
const originalPath = process.env.PATH;
const originalState = process.env.FAKE_AUTH0_STATE;
let discoveryOverrides: Record<string, unknown> = {};

function receipt(projectRoot: string): ChatGptConnectionReceipt {
  return {
    version: 1,
    status: 'configured',
    provider: 'auth0',
    mode: 'quick',
    registration: 'dcr',
    tenant: 'tenant.example.auth0.com',
    issuer: 'https://tenant.example.auth0.com/',
    resource: 'https://mcp.example.com/mcp',
    mcpUrl: 'https://mcp.example.com/mcp',
    metadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
    scopes: ['folderforge:read', 'folderforge:write'],
    projectRoot,
    configPath: join(projectRoot, '.folderforge', 'chatgpt-config.yaml'),
    auth0: { apiId: 'api_1', apiName: 'FolderForge MCP', createdByFolderForge: true },
    connectivity: {
      kind: 'stable-url',
      publicUrl: 'https://mcp.example.com',
      localUrl: 'http://127.0.0.1:7331/mcp',
    },
    processes: { serverLog: join(projectRoot, '.folderforge', 'chatgpt-server.log') },
    checks: {
      dependencies: 'pass',
      tenant: 'pass',
      issuerDiscovery: 'pass',
      auth0Api: 'pass',
      resourceMetadata: 'not_run',
      unauthorizedChallenge: 'not_run',
      jwks: 'pass',
      tokenValidation: 'pending_user_login',
      mcpInitialize: 'pending_user_login',
    },
    warnings: [],
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
  };
}

function installFakeAuth0(root: string): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = join(bin, 'fake-auth0.mjs');
  writeFileSync(
    script,
    `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const statePath = process.env.FAKE_AUTH0_STATE;
const read = () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { apis: [], creates: 0, updates: 0 };
const write = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (args[0] === '--version') { console.log('auth0 version 1.32.0 fake'); process.exit(0); }
if (args[0] === 'tenants' && args[1] === 'list') { console.log(JSON.stringify([{ active: true, name: 'tenant.example.auth0.com' }])); process.exit(0); }
if (args[0] === 'tenant-settings' && args[1] === 'show') {
  const state = read();
  console.log(JSON.stringify({ flags: { enable_dynamic_client_registration: state.dcrEnabled ?? true } }));
  process.exit(0);
}
if (args[0] === 'tenant-settings' && args[1] === 'update' && args[2] === 'set') {
  const state = read(); state.dcrEnabled = true; state.dcrUpdates = (state.dcrUpdates || 0) + 1; write(state);
  console.log(JSON.stringify({ flags: { enable_dynamic_client_registration: true } })); process.exit(0);
}
if (args[0] === 'apis' && args[1] === 'list') { console.log(JSON.stringify(read().apis)); process.exit(0); }
if (args[0] === 'apis' && args[1] === 'show') {
  const state = read();
  const api = state.apis.find((item) => item.id === args[2] || item.identifier === args[2]);
  if (!api) process.exit(1);
  console.log(JSON.stringify(api)); process.exit(0);
}
if (args[0] === 'apis' && args[1] === 'create') {
  const state = read();
  const scopes = (flag('--scopes') || '').split(',').filter(Boolean).map((value) => ({ value }));
  const api = {
    id: 'api_1', name: flag('--name'), identifier: flag('--identifier'), scopes,
    signing_alg: 'RS256', token_dialect: 'rfc9068_profile', token_lifetime: 3600,
    allow_offline_access: args.includes('--offline-access=true'),
    subject_type_authorization: JSON.parse(flag('--subject-type-authorization') || '{}')
  };
  state.apis.push(api); state.creates += 1; write(state); console.log(JSON.stringify(api)); process.exit(0);
}
if (args[0] === 'api' && args[1] === 'patch' && args[2]?.startsWith('resource-servers/')) {
  const state = read();
  const id = decodeURIComponent(args[2].slice('resource-servers/'.length));
  const api = state.apis.find((item) => item.id === id);
  if (!api) process.exit(1);
  Object.assign(api, JSON.parse(flag('--data') || '{}'));
  state.updates += 1; write(state); console.log(JSON.stringify(api)); process.exit(0);
}
console.error('unsupported fake auth0 invocation', args.join(' ')); process.exit(2);
`
  );
  chmodSync(script, 0o755);
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'auth0.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    writeFileSync(join(bin, 'auth0'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(join(bin, 'auth0'), 0o755);
  }
  return bin;
}

beforeEach(() => {
  discoveryOverrides = {};
  const tenant = 'https://tenant.example.auth0.com/';
  globalThis.fetch = vi.fn(async (input) => {
    const url = String(input);
    if (url === `${tenant}.well-known/openid-configuration`) {
      return new Response(
        JSON.stringify({
          issuer: tenant,
          authorization_endpoint: `${tenant}authorize`,
          token_endpoint: `${tenant}oauth/token`,
          jwks_uri: `${tenant}.well-known/jwks.json`,
          registration_endpoint: `${tenant}oidc/register`,
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
          ...discoveryOverrides,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url === `${tenant}.well-known/jwks.json`) {
      return new Response(JSON.stringify({ keys: [{ kty: 'RSA', kid: 'test' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') {
      return new Response(
        JSON.stringify({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://tenant.example.auth0.com'],
          scopes_supported: ['folderforge:read', 'folderforge:write'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url === 'https://mcp.example.com/mcp') {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'www-authenticate':
            'Bearer scope="folderforge:read", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.PATH = originalPath;
  if (originalState === undefined) delete process.env.FAKE_AUTH0_STATE;
  else process.env.FAKE_AUTH0_STATE = originalState;
  vi.restoreAllMocks();
});

describe('ChatGPT connect CLI', () => {
  it('parses quick and secure modes without accepting conflicting flags', () => {
    expect(parseChatGptArgs(['connect', '--quick']).mode).toBe('quick');
    expect(parseChatGptArgs(['connect', '--secure', '--public-url', 'https://mcp.example.com']).mode).toBe('secure');
    expect(() => parseChatGptArgs(['connect', '--quick', '--secure'])).toThrow(/only one/);
  });

  it('normalizes only canonical HTTPS MCP URLs', () => {
    expect(normalizeMcpUrl('https://mcp.example.com')).toBe('https://mcp.example.com/mcp');
    expect(normalizeMcpUrl('https://mcp.example.com/mcp/')).toBe('https://mcp.example.com/mcp');
    expect(() => normalizeMcpUrl('http://mcp.example.com/mcp')).toThrow(/HTTPS/);
    expect(() => normalizeMcpUrl('https://user:pass@mcp.example.com/mcp')).toThrow(/userinfo/);
    expect(() => normalizeMcpUrl('https://mcp.example.com/not-mcp')).toThrow(/end in \/mcp/);
  });

  it('provisions the Auth0 API idempotently and writes a secret-free config and receipt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'Folder Forge ü-'));
    const project = join(root, 'Project With Space Ω');
    mkdirSync(project, { recursive: true });
    const statePath = join(root, 'auth0-state.json');
    writeFileSync(statePath, JSON.stringify({ apis: [], creates: 0, updates: 0 }));
    const bin = installFakeAuth0(root);
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
    process.env.FAKE_AUTH0_STATE = statePath;

    const args = [
      'connect',
      '--quick',
      '--public-url',
      'https://mcp.example.com/mcp',
      '--project',
      project,
      '--no-start',
    ];
    const first = await executeChatGptCli(args);
    const second = await executeChatGptCli(args);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);

    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { creates: number; updates: number };
    expect(state.creates).toBe(1);
    expect(state.updates).toBe(0);

    const receiptPath = join(project, '.folderforge', 'chatgpt-connection.json');
    const saved = readConnectionReceipt(receiptPath);
    expect(saved.resource).toBe('https://mcp.example.com/mcp');
    expect(saved.registration).toBe('dcr');
    expect(saved.checks.tokenValidation).toBe('pending_user_login');
    const serialized = readFileSync(receiptPath, 'utf8');
    expect(serialized).not.toMatch(/access_token|refresh_token|client_secret|pkce_verifier/i);

    const config = YAML.parse(readFileSync(saved.configPath, 'utf8')) as {
      server: { http: { auth: { mode: string; oauth: { resource: string; clientRegistration: string } } } };
    };
    expect(config.server.http.auth.mode).toBe('oauth');
    expect(config.server.http.auth.oauth.resource).toBe(saved.resource);
    expect(config.server.http.auth.oauth.clientRegistration).toBe('dcr');
    if (process.platform !== 'win32') expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
  });

  it('preserves existing scope descriptions while repairing Auth0 API settings idempotently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-auth0-repair-'));
    const statePath = join(root, 'auth0-state.json');
    writeFileSync(
      statePath,
      JSON.stringify({
        apis: [
          {
            id: 'api_1',
            name: 'Existing FolderForge API',
            identifier: 'https://mcp.example.com/mcp',
            scopes: [{ value: 'legacy:read', description: 'Keep this description' }],
            signing_alg: 'HS256',
            token_dialect: 'access_token',
            token_lifetime: 7200,
            allow_offline_access: true,
          },
        ],
        creates: 0,
        updates: 0,
      })
    );
    const bin = installFakeAuth0(root);
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
    process.env.FAKE_AUTH0_STATE = statePath;
    const args = [
      'connect',
      '--quick',
      '--public-url',
      'https://mcp.example.com/mcp',
      '--project',
      root,
      '--no-start',
    ];

    expect((await executeChatGptCli(args)).exitCode).toBe(0);
    expect((await executeChatGptCli(args)).exitCode).toBe(0);
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      creates: number;
      updates: number;
      apis: Array<{
        scopes: Array<{ value: string; description?: string }>;
        signing_alg: string;
        token_dialect: string;
        token_lifetime: number;
        allow_offline_access: boolean;
      }>;
    };
    expect(state.creates).toBe(0);
    expect(state.updates).toBe(1);
    expect(state.apis[0]?.scopes).toEqual([
      { value: 'legacy:read', description: 'Keep this description' },
      { value: 'folderforge:read', description: 'Read FolderForge MCP tools' },
      { value: 'folderforge:write', description: 'Use mutating FolderForge MCP tools' },
    ]);
    expect(state.apis[0]).toMatchObject({
      signing_alg: 'RS256',
      token_dialect: 'rfc9068_profile',
      token_lifetime: 3600,
      allow_offline_access: true,
      subject_type_authorization: {
        user: { policy: 'allow_all' },
        client: { policy: 'allow_all' },
      },
    });
  });

  it('does not write local files or mutate Auth0 in dry-run mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-chatgpt-dry-'));
    const statePath = join(root, 'auth0-state.json');
    writeFileSync(statePath, JSON.stringify({ apis: [], creates: 0, updates: 0 }));
    const bin = installFakeAuth0(root);
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
    process.env.FAKE_AUTH0_STATE = statePath;

    const result = await executeChatGptCli([
      'connect',
      '--quick',
      '--public-url',
      'https://dry.example.com/mcp',
      '--project',
      root,
      '--dry-run',
    ]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(statePath, 'utf8')).toContain('"creates":0');
    expect(existsSync(join(root, '.folderforge'))).toBe(false);
  });

  it('persists full-access CLI overrides and force-rebuilds generated YAML', async () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-chatgpt-full-'));
    const statePath = join(root, 'auth0-state.json');
    writeFileSync(statePath, JSON.stringify({ apis: [], creates: 0, updates: 0, dcrEnabled: false }));
    const bin = installFakeAuth0(root);
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
    process.env.FAKE_AUTH0_STATE = statePath;

    const result = await executeChatGptCli([
      'connect',
      '--quick',
      '--public-url',
      'https://mcp.example.com/mcp',
      '--project',
      root,
      '--port',
      '7443',
      '--full-access',
      '--adapters',
      'playwright,serena',
      '--dashboard',
      '--dashboard-port',
      '7555',
      '--force-config',
      '--no-start',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.receipt?.runtime).toMatchObject({
      profile: 'full',
      policyMode: 'danger',
      toolsPreset: 'full',
      adapters: ['playwright', 'serena'],
      dashboard: true,
      dashboardPort: 7555,
      offlineAccess: true,
      dcrClientPolicy: 'allow-all',
      autoEnableDcr: true,
    });
    const config = YAML.parse(readFileSync(join(root, '.folderforge', 'chatgpt-config.yaml'), 'utf8')) as any;
    expect(config.server.http.port).toBe(7443);
    expect(config.server.dashboard).toMatchObject({ enabled: true, port: 7555 });
    expect(config.policy.defaultMode).toBe('danger');
    expect(config.tools.preset).toBe('full');
    expect(config.adapters.playwright.enabled).toBe(true);
    expect(config.adapters.serena.enabled).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as any;
    expect(state.dcrEnabled).toBe(true);
    expect(state.dcrUpdates).toBe(1);
    expect(state.apis[0]).toMatchObject({
      allow_offline_access: true,
      subject_type_authorization: {
        user: { policy: 'allow_all' },
        client: { policy: 'allow_all' },
      },
    });
  });

  it('rejects receipts containing secret fields or JWT-shaped values', () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-receipt-'));
    const unsafe = receipt(root) as ChatGptConnectionReceipt & {
      nested?: { accessToken?: string };
    };
    unsafe.nested = { accessToken: 'secret' };
    expect(() => writeConnectionReceipt(join(root, 'unsafe.json'), unsafe)).toThrow(/forbidden secret field/);

    const jwtUnsafe = receipt(root);
    jwtUnsafe.warnings = ['eyJabcdefghijklmnopqrstuvwxyz.abcdefghijklmnop.abcdefghijklmnop'];
    expect(() => writeConnectionReceipt(join(root, 'jwt.json'), jwtUnsafe)).toThrow(/JWT/);
  });

  it('fails closed when secure mode has no stable public URL', async () => {
    const result = await executeChatGptCli(['connect', '--secure']);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/requires --public-url/);
  });

  it('rejects tenant overrides not present in the authenticated Auth0 CLI tenant list', async () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-tenant-'));
    const statePath = join(root, 'auth0-state.json');
    writeFileSync(statePath, JSON.stringify({ apis: [], creates: 0, updates: 0 }));
    const bin = installFakeAuth0(root);
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
    process.env.FAKE_AUTH0_STATE = statePath;

    const result = await executeChatGptCli([
      'connect',
      '--quick',
      '--tenant',
      'metadata.internal.example',
      '--public-url',
      'https://mcp.example.com/mcp',
      '--project',
      root,
      '--dry-run',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/not present in the authenticated Auth0 CLI tenant list/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects cross-origin authorization, token, registration, and JWKS metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-discovery-origin-'));
    const statePath = join(root, 'auth0-state.json');
    writeFileSync(statePath, JSON.stringify({ apis: [], creates: 0, updates: 0 }));
    const bin = installFakeAuth0(root);
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
    process.env.FAKE_AUTH0_STATE = statePath;
    discoveryOverrides = { jwks_uri: 'https://169.254.169.254/latest/meta-data' };

    const result = await executeChatGptCli([
      'connect',
      '--quick',
      '--public-url',
      'https://mcp.example.com/mcp',
      '--project',
      root,
      '--dry-run',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/jwks_uri must be an HTTPS URL on https:\/\/tenant\.example\.auth0\.com/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a concurrent operation lock owned by a live process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-lock-'));
    const stateDir = join(root, '.folderforge');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'chatgpt-connect.lock'), String(process.pid));
    const result = await executeChatGptCli([
      'connect',
      '--quick',
      '--public-url',
      'https://locked.example.com/mcp',
      '--project',
      root,
      '--no-start',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/already running/);
  });

  it('reports endpoint status and disconnects without deleting remote Auth0 resources', async () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-lifecycle-'));
    const stateDir = join(root, '.folderforge');
    mkdirSync(stateDir, { recursive: true });
    const saved = receipt(root);
    writeConnectionReceipt(join(stateDir, 'chatgpt-connection.json'), saved);

    const statusResult = await executeChatGptCli(['status', '--project', root]);
    expect(statusResult.exitCode).toBe(0);
    expect(statusResult.receipt?.checks.resourceMetadata).toBe('pass');
    expect(statusResult.receipt?.checks.unauthorizedChallenge).toBe('pass');
    expect(statusResult.receipt?.status).toBe('stopped');

    const disconnectResult = await executeChatGptCli(['disconnect', '--project', root]);
    expect(disconnectResult.exitCode).toBe(0);
    expect(disconnectResult.receipt?.status).toBe('disconnected');
    expect(disconnectResult.output).toMatch(/Auth0 resources were preserved/);
    expect(readConnectionReceipt(join(stateDir, 'chatgpt-connection.json')).auth0.apiId).toBe('api_1');
  });

  it('requires purge confirmation before changing connection state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-purge-'));
    const stateDir = join(root, '.folderforge');
    mkdirSync(stateDir, { recursive: true });
    writeConnectionReceipt(join(stateDir, 'chatgpt-connection.json'), receipt(root));

    const result = await executeChatGptCli([
      'disconnect',
      '--project',
      root,
      '--purge-local',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/requires --yes/);
    expect(readConnectionReceipt(join(stateDir, 'chatgpt-connection.json')).status).toBe('configured');
  });
});
