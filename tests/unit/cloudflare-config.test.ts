import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearCloudflareConfig,
  cloudflareConfigPath,
  loadCloudflareConfig,
  maskedCloudflareConfig,
  saveCloudflareConfig,
} from '../../src/cloudflare/config-store.js';

describe('cloudflare config store', () => {
  const roots: string[] = [];
  const makeRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-cf-config-'));
    roots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const sample = {
    accountId: 'acc1',
    zoneId: 'zone-1',
    domain: 'example.com',
    apiToken: 'tok_super_secret_1234abcd',
    linkedAt: '2026-08-26T00:00:00.000Z',
  };

  it('round-trips save/load and writes the file 0600', () => {
    const root = makeRoot();
    saveCloudflareConfig(root, sample);
    expect(loadCloudflareConfig(root)).toEqual(sample);
    const mode = statSync(cloudflareConfigPath(root)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('masked view never exposes the full token', () => {
    const root = makeRoot();
    saveCloudflareConfig(root, sample);
    const masked = maskedCloudflareConfig(root);
    expect(masked.configured).toBe(true);
    expect(masked.domain).toBe('example.com');
    expect(masked.tokenPreview).toBe('\u2026abcd');
    expect(JSON.stringify(masked)).not.toContain(sample.apiToken);
  });

  it('load returns null when missing or malformed', () => {
    const root = makeRoot();
    expect(loadCloudflareConfig(root)).toBeNull();
    mkdirSync(join(root, '.folderforge'), { recursive: true });
    writeFileSync(cloudflareConfigPath(root), 'not json', 'utf8');
    expect(loadCloudflareConfig(root)).toBeNull();
  });

  it('clear removes the link', () => {
    const root = makeRoot();
    saveCloudflareConfig(root, sample);
    clearCloudflareConfig(root);
    expect(loadCloudflareConfig(root)).toBeNull();
    expect(maskedCloudflareConfig(root)).toEqual({ configured: false });
  });
});
