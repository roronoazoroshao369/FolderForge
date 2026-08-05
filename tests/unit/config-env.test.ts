import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyHttpAuthDefaults, loadConfig } from '../../src/runtime/config.js';
import type { FolderForgeConfig } from '../../src/core/types.js';
import { TS_FIXTURE } from '../integration/fixtures.js';

/**
 * Environment-variable overlay for the runtime config. These branches decide
 * how a deployment is authenticated, so each one is pinned explicitly. Every
 * case restores the previous environment, including on failure.
 */

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Every override-related variable, cleared so one test cannot leak into another. */
const CLEARED: Record<string, string | undefined> = {
  FOLDERFORGE_CONFIG: undefined,
  FOLDERFORGE_HTTP_AUTH: undefined,
  FOLDERFORGE_HTTP_API_KEYS: undefined,
  FOLDERFORGE_AUDIT_DURABILITY: undefined,
  FOLDERFORGE_AUDIT_REQUIRE_HIGH_RISK: undefined,
  FOLDERFORGE_AUDIT_REQUIRE_AUTHENTICATED_HTTP: undefined,
  FOLDERFORGE_OAUTH_RESOURCE: undefined,
  FOLDERFORGE_OAUTH_METADATA_URL: undefined,
  FOLDERFORGE_OAUTH_ISSUER: undefined,
  FOLDERFORGE_OAUTH_SCOPES: undefined,
  FOLDERFORGE_OAUTH_READ_SCOPE: undefined,
  FOLDERFORGE_OAUTH_WRITE_SCOPE: undefined,
  FOLDERFORGE_OAUTH_CLIENT_REGISTRATION: undefined,
  FOLDERFORGE_OAUTH_JWKS_URI: undefined,
  FOLDERFORGE_OAUTH_TRUSTED_JWKS_HOSTS: undefined,
  FOLDERFORGE_OAUTH_ALGORITHMS: undefined,
  FOLDERFORGE_OAUTH_ALLOW_INSECURE_HTTP: undefined,
};

function load(vars: Record<string, string | undefined>, configPath?: string): FolderForgeConfig {
  return withEnv({ ...CLEARED, ...vars }, () =>
    loadConfig(configPath === undefined ? { projectRoot: TS_FIXTURE } : { projectRoot: TS_FIXTURE, configPath })
  );
}

/** Write a throwaway YAML config and return its absolute path. */
function yamlConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'folderforge-cfg-'));
  const path = join(dir, 'folderforge.yaml');
  writeFileSync(path, body, 'utf8');
  return path;
}

/** A loopback HTTP deployment already running OAuth, used as the overlay base. */
const OAUTH_BASE = [
  'server:',
  '  transport: http',
  '  http:',
  '    host: 127.0.0.1',
  '    port: 7331',
  '    auth:',
  '      mode: oauth',
  '      oauth:',
  '        resource: http://127.0.0.1:7331/mcp',
  '        issuer: http://127.0.0.1:9000',
  '        allowInsecureHttpForDevelopment: true',
  '',
].join('\n');

/** The same loopback deployment with no auth block, so the overlay must create one. */
const HTTP_ONLY = [
  'server:',
  '  transport: http',
  '  http:',
  '    host: 127.0.0.1',
  '    port: 7331',
  '',
].join('\n');

describe('audit environment overrides', () => {
  it('overrides the audit durability mode', () => {
    expect(load({ FOLDERFORGE_AUDIT_DURABILITY: 'required' }).audit.durability).toBe('required');
  });

  it('rejects an audit durability mode that is not a known level', () => {
    expect(() => load({ FOLDERFORGE_AUDIT_DURABILITY: 'eventual' })).toThrow(/audit.durability/);
  });

  it.each([
    ['1', true],
    ['true', true],
    ['YES', true],
    ['on', true],
    ['0', false],
    ['false', false],
    ['No', false],
    ['off', false],
  ])('parses %j as %s for the high-risk audit switch', (value, expected) => {
    expect(load({ FOLDERFORGE_AUDIT_REQUIRE_HIGH_RISK: value }).audit.requireForHighRisk).toBe(expected);
  });

  it('overrides the authenticated-HTTP audit requirement', () => {
    const cfg = load({ FOLDERFORGE_AUDIT_REQUIRE_AUTHENTICATED_HTTP: 'off' });
    expect(cfg.audit.requireForAuthenticatedHttp).toBe(false);
  });

  it('refuses an ambiguous boolean instead of guessing', () => {
    expect(() => load({ FOLDERFORGE_AUDIT_REQUIRE_HIGH_RISK: 'maybe' })).toThrow(
      /Invalid boolean environment value: maybe/
    );
  });

  it('leaves audit defaults untouched when nothing is set', () => {
    expect(load({}).audit).toMatchObject({
      durability: 'best-effort',
      requireForHighRisk: true,
      requireForAuthenticatedHttp: true,
    });
  });
});

describe('HTTP credential environment overrides', () => {
  it('trims and compacts the API key list', () => {
    const cfg = load({ FOLDERFORGE_HTTP_API_KEYS: ' key-a , key-b ,, key-c ' });
    expect(cfg.server.http.apiKeys).toEqual(['key-a', 'key-b', 'key-c']);
  });

  it('ignores an API key list that is only separators', () => {
    const cfg = load({ FOLDERFORGE_HTTP_API_KEYS: ' , , ' });
    expect(cfg.server.http.apiKeys ?? []).toEqual([]);
  });

  it('sets a non-OAuth auth mode without inventing an OAuth block', () => {
    const cfg = load({ FOLDERFORGE_HTTP_AUTH: 'token' });
    expect(cfg.server.http.auth?.mode).toBe('token');
    expect(cfg.server.http.auth?.oauth).toBeUndefined();
  });
});

describe('OAuth environment overlay', () => {
  it('merges every OAuth variable onto the deployed configuration', () => {
    const cfg = load(
      {
        FOLDERFORGE_OAUTH_SCOPES: 'folderforge:read, folderforge:write',
        FOLDERFORGE_OAUTH_READ_SCOPE: 'folderforge:read',
        FOLDERFORGE_OAUTH_WRITE_SCOPE: 'folderforge:write',
        FOLDERFORGE_OAUTH_CLIENT_REGISTRATION: 'cimd',
        FOLDERFORGE_OAUTH_JWKS_URI: 'http://127.0.0.1:9000/.well-known/jwks.json',
        FOLDERFORGE_OAUTH_ALGORITHMS: 'RS256, ES256',
        FOLDERFORGE_OAUTH_ALLOW_INSECURE_HTTP: 'true',
      },
      yamlConfig(OAUTH_BASE)
    );
    expect(cfg.server.http.auth?.mode).toBe('oauth');
    expect(cfg.server.http.auth?.oauth).toMatchObject({
      resource: 'http://127.0.0.1:7331/mcp',
      scopes: ['folderforge:read', 'folderforge:write'],
      readScope: 'folderforge:read',
      writeScope: 'folderforge:write',
      clientRegistration: 'cimd',
      jwksUri: 'http://127.0.0.1:9000/.well-known/jwks.json',
      algorithms: ['RS256', 'ES256'],
      allowInsecureHttpForDevelopment: true,
    });
  });

  it('turns on OAuth for an HTTP server that had no auth block', () => {
    const cfg = load(
      {
        FOLDERFORGE_OAUTH_RESOURCE: 'http://127.0.0.1:7331/mcp',
        FOLDERFORGE_OAUTH_ISSUER: 'http://127.0.0.1:9000',
        FOLDERFORGE_OAUTH_ALLOW_INSECURE_HTTP: '1',
      },
      yamlConfig(HTTP_ONLY)
    );
    expect(cfg.server.http.auth?.mode).toBe('oauth');
    expect(cfg.server.http.auth?.oauth).toMatchObject({
      resource: 'http://127.0.0.1:7331/mcp',
      issuer: 'http://127.0.0.1:9000',
      scopes: ['folderforge:read', 'folderforge:write'],
    });
  });

  it('overrides only the issuer and keeps the configured audience', () => {
    const cfg = load(
      { FOLDERFORGE_OAUTH_ISSUER: 'http://127.0.0.1:9100' },
      yamlConfig(OAUTH_BASE)
    );
    expect(cfg.server.http.auth?.oauth).toMatchObject({
      issuer: 'http://127.0.0.1:9100',
      resource: 'http://127.0.0.1:7331/mcp',
      allowInsecureHttpForDevelopment: true,
    });
  });

  it('treats a scope list alone as an OAuth request', () => {
    const cfg = load(
      { FOLDERFORGE_OAUTH_SCOPES: 'folderforge:read , folderforge:write' },
      yamlConfig(OAUTH_BASE)
    );
    expect(cfg.server.http.auth?.oauth?.scopes).toEqual(['folderforge:read', 'folderforge:write']);
  });

  it('records trusted JWKS hosts as a trimmed list', () => {
    // FOLDERFORGE_HTTP_AUTH replaces the whole auth block, so the environment
    // has to restate the audience and issuer it wants to keep.
    const cfg = load(
      {
        FOLDERFORGE_HTTP_AUTH: 'oauth',
        FOLDERFORGE_OAUTH_TRUSTED_JWKS_HOSTS: '127.0.0.1 , localhost',
        FOLDERFORGE_OAUTH_RESOURCE: 'http://127.0.0.1:7331/mcp',
        FOLDERFORGE_OAUTH_ISSUER: 'http://127.0.0.1:9000',
        FOLDERFORGE_OAUTH_ALLOW_INSECURE_HTTP: '1',
      },
      yamlConfig(OAUTH_BASE)
    );
    expect(cfg.server.http.auth?.oauth?.trustedJwksHosts).toEqual(['127.0.0.1', 'localhost']);
  });

  it('rejects a trusted JWKS entry that is a URL rather than a host', () => {
    expect(() =>
      load(
        {
          FOLDERFORGE_HTTP_AUTH: 'oauth',
          FOLDERFORGE_OAUTH_TRUSTED_JWKS_HOSTS: 'https://idp.example.com/keys',
          FOLDERFORGE_OAUTH_RESOURCE: 'http://127.0.0.1:7331/mcp',
          FOLDERFORGE_OAUTH_ISSUER: 'http://127.0.0.1:9000',
          FOLDERFORGE_OAUTH_ALLOW_INSECURE_HTTP: '1',
        },
        yamlConfig(OAUTH_BASE)
      )
    ).toThrow(/trustedJwksHosts entries must be exact host/);
  });

  it('ignores auxiliary OAuth variables unless the overlay is triggered', () => {
    // The overlay only runs when a resource, metadata URL, issuer, scope list,
    // or FOLDERFORGE_HTTP_AUTH=oauth is present. Secondary variables on their
    // own must not silently rewrite a deployed configuration.
    const cfg = load(
      { FOLDERFORGE_OAUTH_TRUSTED_JWKS_HOSTS: '127.0.0.1' },
      yamlConfig(OAUTH_BASE)
    );
    expect(cfg.server.http.auth?.oauth?.trustedJwksHosts).toBeUndefined();
    expect(cfg.server.http.auth?.oauth?.resource).toBe('http://127.0.0.1:7331/mcp');
  });

  it('leaves HTTP auth unset when no variable asks for it', () => {
    expect(load({}).server.http.auth?.oauth).toBeUndefined();
  });
});

describe('applyHttpAuthDefaults', () => {
  it('is a no-op for a non-OAuth configuration', () => {
    const cfg = loadConfig({ projectRoot: TS_FIXTURE });
    cfg.server.http.auth = { mode: 'token' };
    applyHttpAuthDefaults(cfg);
    expect(cfg.server.http.auth).toEqual({ mode: 'token' });
  });

  it('is a no-op when no auth block exists at all', () => {
    const cfg = loadConfig({ projectRoot: TS_FIXTURE });
    delete cfg.server.http.auth;
    applyHttpAuthDefaults(cfg);
    expect(cfg.server.http.auth).toBeUndefined();
  });

  it('fills every timing default for a bare OAuth block', () => {
    const cfg = loadConfig({ projectRoot: TS_FIXTURE });
    cfg.server.http.auth = { mode: 'oauth' };
    applyHttpAuthDefaults(cfg);
    expect(cfg.server.http.auth.oauth).toMatchObject({
      resource: '',
      issuer: '',
      scopes: ['folderforge:read', 'folderforge:write'],
      clientRegistration: 'cimd',
      clockToleranceSeconds: 5,
      requestTimeoutMs: 5_000,
      jwksCacheTtlMs: 600_000,
      jwksCooldownMs: 30_000,
    });
    expect(cfg.server.http.auth.oauth?.metadataUrl).toBeUndefined();
  });

  it('preserves explicitly configured scopes, algorithms, and timings', () => {
    const cfg = loadConfig({ projectRoot: TS_FIXTURE });
    cfg.server.http.auth = {
      mode: 'oauth',
      oauth: {
        resource: 'https://api.example.com/mcp',
        metadataUrl: 'https://api.example.com/.well-known/oauth-protected-resource/mcp',
        issuer: 'https://tenant.example.auth0.com',
        scopes: ['custom:read'],
        readScope: 'custom:read',
        writeScope: 'custom:write',
        clientRegistration: 'dcr',
        algorithms: ['ES256'],
        clockToleranceSeconds: 30,
        requestTimeoutMs: 1_000,
        jwksCacheTtlMs: 1,
        jwksCooldownMs: 2,
      },
    };
    applyHttpAuthDefaults(cfg);
    expect(cfg.server.http.auth.oauth).toMatchObject({
      metadataUrl: 'https://api.example.com/.well-known/oauth-protected-resource/mcp',
      scopes: ['custom:read'],
      readScope: 'custom:read',
      writeScope: 'custom:write',
      clientRegistration: 'dcr',
      algorithms: ['ES256'],
      clockToleranceSeconds: 30,
      requestTimeoutMs: 1_000,
      jwksCacheTtlMs: 1,
      jwksCooldownMs: 2,
    });
  });

  it('falls back to default scopes when empty strings are supplied', () => {
    const cfg = loadConfig({ projectRoot: TS_FIXTURE });
    cfg.server.http.auth = {
      mode: 'oauth',
      oauth: { resource: '', issuer: '', scopes: [], readScope: '', writeScope: '', clientRegistration: 'cimd' },
    };
    applyHttpAuthDefaults(cfg);
    expect(cfg.server.http.auth.oauth).toMatchObject({
      readScope: 'folderforge:read',
      writeScope: 'folderforge:write',
      scopes: ['folderforge:read', 'folderforge:write'],
      algorithms: ['RS256', 'PS256', 'ES256', 'EdDSA'],
    });
  });
});
