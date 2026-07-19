import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../src/core/types.js';
import { marketplaceTools } from '../../src/tools/marketplace-tools.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function context(marketplace: Record<string, unknown>): ToolContext {
  return {
    projectRoot: '/tmp/project',
    config: {} as ToolContext['config'],
    container: { marketplace },
  } as ToolContext;
}

function tool(name: string) {
  const found = marketplaceTools().find((item) => item.name === name);
  if (!found) throw new Error(`Missing marketplace tool ${name}`);
  return found;
}

describe('marketplace tool governance surface', () => {
  it('routes search, trust, sync, quarantine, install, publisher, and moderation operations', async () => {
    const marketplace = {
      list: vi.fn(() => [{ id: 'demo' }]),
      inspect: vi.fn(() => ({ id: 'demo', version: '1.0.0' })),
      scanDirectory: vi.fn(() => ({ passed: true })),
      syncIndex: vi.fn(async () => ({ imported: 1 })),
      quarantine: vi.fn(async () => ({ scan: { passed: true } })),
      install: vi.fn(() => ({ id: 'demo', enabled: false })),
      exportIndex: vi.fn(() => ({ schemaVersion: 1, entries: [{ id: 'demo' }] })),
      createPackage: vi.fn(async () => ({ entry: { id: 'demo' } })),
      addPublisher: vi.fn(() => ({ id: 'author' })),
      revokePublisher: vi.fn(() => ({ state: 'revoked' })),
      listPublishers: vi.fn(() => [{ id: 'author' }]),
      moderate: vi.fn(() => ({ moderation: { state: 'security-hold' } })),
    };
    const ctx = context(marketplace);
    const root = mkdtempSync(join(tmpdir(), 'folderforge-marketplace-tools-'));
    roots.push(root);
    const output = join(root, 'index.json');
    const privateKeyPath = join(root, 'private.pem');
    await import('node:fs').then(({ writeFileSync }) => writeFileSync(privateKeyPath, 'private-key', { mode: 0o600 }));

    expect(await tool('marketplace_list').handler({ query: 'demo' }, ctx)).toMatchObject({ ok: true, data: { entries: expect.any(Array) } });
    expect(await tool('marketplace_inspect').handler({ id: 'demo', version: '1.0.0' }, ctx)).toMatchObject({ ok: true });
    expect(await tool('marketplace_scan').handler({ source: root }, ctx)).toMatchObject({ ok: true });
    expect(await tool('marketplace_sync').handler({ source: output, expectedSha256: 'a'.repeat(64) }, ctx)).toMatchObject({ ok: true });
    expect(marketplace.syncIndex).toHaveBeenCalledWith(output, 'a'.repeat(64));
    expect(await tool('marketplace_quarantine').handler({ id: 'demo', version: '1.0.0' }, ctx)).toMatchObject({ ok: true });
    expect(await tool('marketplace_install').handler({ id: 'demo', version: '1.0.0' }, ctx)).toMatchObject({ ok: true, data: { enabled: false } });
    expect(await tool('marketplace_export').handler({ output }, ctx)).toMatchObject({ ok: true, data: { entries: 1 } });
    expect(JSON.parse(readFileSync(output, 'utf8')).entries).toHaveLength(1);
    expect(await tool('marketplace_package').handler({
      source: root,
      output: join(root, 'demo.tgz'),
      packageUrl: 'file:///demo.tgz',
      publisherId: 'author',
      privateKeyPath,
      provenance: { repository: 'repo' },
    }, ctx)).toMatchObject({ ok: true });
    expect(marketplace.createPackage).toHaveBeenCalledWith(expect.objectContaining({
      sourceDir: root,
      publisherId: 'author',
      privateKeyPem: 'private-key',
      packageUrl: 'file:///demo.tgz',
    }));
    expect(await tool('marketplace_publisher_add').handler({ id: 'author', name: 'Author', publicKeyPem: 'pem' }, ctx)).toMatchObject({ ok: true });
    expect(await tool('marketplace_publisher_revoke').handler({ id: 'author', reason: 'incident' }, ctx)).toMatchObject({ ok: true });
    expect(await tool('marketplace_publisher_list').handler({}, ctx)).toMatchObject({ ok: true, data: { publishers: expect.any(Array) } });
    expect(await tool('marketplace_moderate').handler({ id: 'demo', version: '1.0.0', state: 'security-hold', reason: 'review' }, ctx)).toMatchObject({ ok: true });
  });

  it('maps rejected marketplace operations to tool errors', async () => {
    const marketplace = Object.fromEntries([
      'inspect', 'scanDirectory', 'syncIndex', 'quarantine', 'install', 'exportIndex',
      'createPackage', 'addPublisher', 'revokePublisher', 'moderate',
    ].map((name) => [name, vi.fn(() => { throw new Error(`failed:${name}`); })]));
    const ctx = context(marketplace);
    const cases: Array<[string, Record<string, unknown>]> = [
      ['marketplace_inspect', { id: 'x', version: '1.0.0' }],
      ['marketplace_scan', { source: '/tmp/x' }],
      ['marketplace_sync', { source: '/tmp/x' }],
      ['marketplace_quarantine', { id: 'x', version: '1.0.0' }],
      ['marketplace_install', { id: 'x', version: '1.0.0' }],
      ['marketplace_export', { output: '/tmp/x' }],
      ['marketplace_package', { source: '/tmp/x', output: '/tmp/y', publisherId: 'x', privateKeyPath: '/missing', provenance: {} }],
      ['marketplace_publisher_add', { id: 'x', name: 'x', publicKeyPem: 'x' }],
      ['marketplace_publisher_revoke', { id: 'x' }],
      ['marketplace_moderate', { id: 'x', version: '1.0.0', state: 'yanked' }],
    ];
    for (const [name, args] of cases) {
      const result = await tool(name).handler(args, ctx);
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    }
  });
});
