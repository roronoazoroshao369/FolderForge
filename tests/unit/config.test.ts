import { describe, it, expect } from 'vitest';
import {
  applyHttpAuthDefaults,
  defaultConfig,
  loadConfig,
  validateConfig,
} from '../../src/runtime/config.js';
import { TS_FIXTURE } from '../integration/fixtures.js';

describe('config loading + validation', () => {
  it('loads a valid default config for a real project', () => {
    const cfg = loadConfig({ projectRoot: TS_FIXTURE });
    expect(cfg.server.name).toBe('folderforge');
    expect(cfg.rateLimit.enabled).toBe(true);
    expect(cfg.secretScan.entropyEnabled).toBe(true);
    expect(cfg.audit).toEqual({
      durability: 'best-effort',
      requireForHighRisk: true,
      requireForAuthenticatedHttp: true,
    });
    expect(cfg.workspace.allowedDirectories.length).toBeGreaterThan(0);
  });

  it('keeps the Playwright adapter isolated but disabled by default', () => {
    const cfg = defaultConfig(TS_FIXTURE);
    expect(cfg.adapters.playwright?.enabled).toBe(false);
    expect(cfg.adapters.playwright?.args).toContain('--isolated');
  });

  it('rejects an invalid policy mode', () => {
    const cfg = loadConfig({ projectRoot: TS_FIXTURE });
    // @ts-expect-error deliberately invalid for the test
    cfg.policy.defaultMode = 'wide-open';
    expect(() => validateConfig(cfg)).toThrow(/policy.defaultMode/);
  });

  it('rejects out-of-range ports', () => {
    const cfg = loadConfig({ projectRoot: TS_FIXTURE });
    cfg.server.http.port = 0;
    expect(() => validateConfig(cfg)).toThrow(/http.port/);
  });

  it('rejects an invalid audit durability mode', () => {
    const cfg = loadConfig({ projectRoot: TS_FIXTURE });
    // @ts-expect-error deliberately invalid for the test
    cfg.audit.durability = 'eventually';
    expect(() => validateConfig(cfg)).toThrow(/audit.durability/);
  });

  it('rejects an empty allowlist', () => {
    const cfg = loadConfig({ projectRoot: TS_FIXTURE });
    cfg.workspace.allowedDirectories = [];
    expect(() => validateConfig(cfg)).toThrow(/allowedDirectories/);
  });

  it('rejects a non-positive rate-limit window', () => {
    const cfg = loadConfig({ projectRoot: TS_FIXTURE });
    cfg.rateLimit.default.windowMs = 0;
    expect(() => validateConfig(cfg)).toThrow(/windowMs/);
  });

  it('collects multiple errors into one message', () => {
    const cfg = loadConfig({ projectRoot: TS_FIXTURE });
    cfg.server.http.port = -1;
    cfg.terminal.maxOutputBytes = 0;
    let message = '';
    try {
      validateConfig(cfg);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/http.port/);
    expect(message).toMatch(/maxOutputBytes/);
  });

  it('applies secure OAuth defaults and accepts explicit loopback development HTTP', () => {
    const cfg = loadConfig({ projectRoot: TS_FIXTURE });
    cfg.server.transport = 'http';
    cfg.server.http.auth = {
      mode: 'oauth',
      oauth: {
        resource: 'http://127.0.0.1:7331/mcp',
        issuer: 'http://127.0.0.1:9000',
        scopes: [],
        readScope: '',
        writeScope: '',
        clientRegistration: 'cimd',
        allowInsecureHttpForDevelopment: true,
      },
    };
    applyHttpAuthDefaults(cfg);
    expect(cfg.server.http.auth.oauth).toMatchObject({
      scopes: ['folderforge:read', 'folderforge:write'],
      readScope: 'folderforge:read',
      writeScope: 'folderforge:write',
      clientRegistration: 'cimd',
      algorithms: ['RS256', 'PS256', 'ES256', 'EdDSA'],
    });
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('rejects OAuth mixed with legacy credentials', () => {
    const cfg = loadConfig({ projectRoot: TS_FIXTURE });
    cfg.server.transport = 'http';
    cfg.server.http.token = 'legacy-secret';
    cfg.server.http.auth = {
      mode: 'oauth',
      oauth: {
        resource: 'https://mcp.example.com/mcp',
        issuer: 'https://auth.example.com',
        scopes: ['folderforge:read', 'folderforge:write'],
        readScope: 'folderforge:read',
        writeScope: 'folderforge:write',
        clientRegistration: 'cimd',
        algorithms: ['RS256'],
      },
    };
    expect(() => validateConfig(cfg)).toThrow(/cannot be combined/);
  });

  it('rejects insecure production OAuth URLs and non-loopback no-auth mode', () => {
    const cfg = loadConfig({ projectRoot: TS_FIXTURE });
    cfg.server.transport = 'http';
    cfg.server.http.host = '0.0.0.0';
    cfg.server.http.auth = { mode: 'none' };
    expect(() => validateConfig(cfg)).toThrow(/only allowed on a loopback/);

    cfg.server.http.host = '127.0.0.1';
    cfg.server.http.auth = {
      mode: 'oauth',
      oauth: {
        resource: 'http://mcp.example.com/mcp',
        issuer: 'http://auth.example.com',
        scopes: ['folderforge:read', 'folderforge:write'],
        readScope: 'folderforge:read',
        writeScope: 'folderforge:write',
        clientRegistration: 'cimd',
        algorithms: ['RS256'],
        allowInsecureHttpForDevelopment: true,
      },
    };
    expect(() => validateConfig(cfg)).toThrow(/HTTPS|loopback/);
  });

  it('rejects weak JWT algorithms and missing scope bindings', () => {
    const cfg = loadConfig({ projectRoot: TS_FIXTURE });
    cfg.server.transport = 'http';
    cfg.server.http.auth = {
      mode: 'oauth',
      oauth: {
        resource: 'https://mcp.example.com/mcp',
        issuer: 'https://auth.example.com',
        scopes: ['folderforge:read'],
        readScope: 'folderforge:read',
        writeScope: 'folderforge:write',
        clientRegistration: 'cimd',
        algorithms: ['none', 'HS256'],
      },
    };
    expect(() => validateConfig(cfg)).toThrow(/writeScope|algorithm/);
  });


  it('rejects ambiguous legacy flags, query-bearing identifiers, and malformed JWKS trust entries', () => {
    const cfg = loadConfig({ projectRoot: TS_FIXTURE });
    cfg.server.transport = 'http';
    cfg.server.http.requireAuth = true;
    cfg.server.http.auth = {
      mode: 'oauth',
      oauth: {
        resource: 'https://mcp.example.com/mcp?tenant=unsafe',
        issuer: 'https://auth.example.com?issuer=unsafe',
        scopes: ['folderforge:read', 'folderforge:write'],
        readScope: 'folderforge:read',
        writeScope: 'folderforge:write',
        clientRegistration: 'cimd',
        algorithms: ['RS256'],
        trustedJwksHosts: ['https://keys.example.com/jwks'],
      },
    };
    expect(() => validateConfig(cfg)).toThrow(/requireAuth|query string|host\[:port\]/);
  });

});
