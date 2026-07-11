import { describe, it, expect } from 'vitest';
import { fullConfig, loadConfig, validateConfig } from '../../src/core/config.js';
import { TS_FIXTURE } from '../integration/fixtures.js';

describe('config loading + validation', () => {
  it('loads a valid default config for a real project', () => {
    const cfg = loadConfig({ projectRoot: TS_FIXTURE });
    expect(cfg.server.name).toBe('folderforge');
    expect(cfg.rateLimit.enabled).toBe(true);
    expect(cfg.secretScan.entropyEnabled).toBe(true);
    expect(cfg.workspace.allowedDirectories.length).toBeGreaterThan(0);
  });

  it('generates an isolated Playwright adapter by default', () => {
    const cfg = fullConfig() as {
      adapters: { playwright: { enabled: boolean; args: string[] } };
    };
    expect(cfg.adapters.playwright.enabled).toBe(true);
    expect(cfg.adapters.playwright.args).toContain('--isolated');
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
});
