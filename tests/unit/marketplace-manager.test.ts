import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarketplaceManager } from '../../src/marketplace/marketplace-manager.js';
import { PluginManager } from '../../src/plugins/plugin-manager.js';

function keys(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function pluginSource(root: string, options: { lifecycle?: boolean; secret?: boolean; archive?: boolean } = {}): {
  dir: string;
  provenance: { repository: string; commit: string; workflow: string; sourceDigest: string; builder: string };
} {
  const dir = join(root, `source-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'folderforge.plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'signed-demo',
    name: 'Signed Demo',
    version: '1.0.0',
    compatibility: { folderforge: '>=2.0.0', mcpProtocol: '2025-03-26' },
    runtime: {
      command: 'node',
      args: ['server.mjs'],
      facade: true,
      sandbox: {
        mode: 'docker',
        image: `example/plugin@sha256:${'a'.repeat(64)}`,
        memoryMb: 256,
        cpus: 0.5,
        pidsLimit: 64,
        tmpfsMb: 32,
      },
    },
    permissions: { network: false, filesystem: 'none', env: [] },
    risk: { default: { risk: 'LOW', mutates: false } },
  }, null, 2));
  writeFileSync(join(dir, 'server.mjs'), options.secret
    ? 'const token = "TEST_SECRET_VALUE_123456789";\n'
    : 'process.stdin.resume();\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'signed-demo',
    version: '1.0.0',
    ...(options.lifecycle ? { scripts: { postinstall: 'node install.js' } } : {}),
  }, null, 2));
  writeFileSync(join(dir, 'sbom.cdx.json'), JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', components: [] }));
  const provenance = {
    repository: 'https://example.invalid/signed-demo',
    commit: 'b'.repeat(40),
    workflow: '.github/workflows/publish-plugin.yml',
    sourceDigest: 'c'.repeat(64),
    builder: 'github-actions',
  };
  writeFileSync(join(dir, 'provenance.json'), JSON.stringify(provenance, null, 2));
  if (options.archive) writeFileSync(join(dir, 'payload.zip'), 'not really a zip');
  return { dir, provenance };
}

describe('marketplace trust, quarantine, and install', () => {
  let root: string;
  let plugins: PluginManager;
  let marketplace: MarketplaceManager;
  let publisherKeys: ReturnType<typeof keys>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'folderforge-marketplace-'));
    plugins = new PluginManager(root, '2.5.0');
    marketplace = new MarketplaceManager(root, '2.5.0', plugins, {
      now: () => 1_800_000_000_000,
      secretScan: (text) => text.includes('TEST_SECRET_VALUE') ? [{}] : [],
    });
    publisherKeys = keys();
    marketplace.addPublisher({ id: 'verified-author', name: 'Verified Author', publicKeyPem: publisherKeys.publicKeyPem });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('creates a signed immutable package, quarantines it, and installs disabled', async () => {
    const source = pluginSource(root);
    const output = join(root, 'signed-demo-1.0.0.tgz');
    const created = await marketplace.createPackage({
      sourceDir: source.dir,
      outputFile: output,
      packageUrl: pathToFileURL(output).toString(),
      publisherId: 'verified-author',
      privateKeyPem: publisherKeys.privateKeyPem,
      provenance: source.provenance,
    });
    expect(created.scan.passed).toBe(true);
    expect(created.entry).toMatchObject({
      id: 'signed-demo',
      version: '1.0.0',
      publisherId: 'verified-author',
      packageDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      signature: expect.any(String),
    });
    expect(marketplace.inspect('signed-demo', '1.0.0')).toMatchObject({
      signatureValid: true,
      trusted: true,
      moderation: { state: 'listed' },
    });

    const quarantined = await marketplace.quarantine('signed-demo', '1.0.0');
    expect(quarantined.scan).toMatchObject({ passed: true, manifest: { id: 'signed-demo', version: '1.0.0' } });
    const installed = marketplace.install('signed-demo', '1.0.0');
    expect(installed).toMatchObject({ id: 'signed-demo', version: '1.0.0', enabled: false });
  });

  it('rejects tampering after quarantine before installation', async () => {
    const source = pluginSource(root);
    const output = join(root, 'signed-demo-tamper.tgz');
    await marketplace.createPackage({
      sourceDir: source.dir,
      outputFile: output,
      publisherId: 'verified-author',
      privateKeyPem: publisherKeys.privateKeyPem,
      provenance: source.provenance,
    });
    const quarantined = await marketplace.quarantine('signed-demo', '1.0.0');
    writeFileSync(join(quarantined.extractedDir, 'server.mjs'), 'tampered after quarantine\n');
    expect(() => marketplace.install('signed-demo', '1.0.0')).toThrow(/changed after scanning/);
  });

  it('rejects lifecycle scripts, nested archives, and detected secrets', () => {
    for (const options of [{ lifecycle: true }, { archive: true }, { secret: true }]) {
      const source = pluginSource(root, options);
      const scan = marketplace.scanDirectory(source.dir);
      expect(scan.passed).toBe(false);
      expect(scan.findings.some((finding) => finding.severity === 'error')).toBe(true);
    }
  });

  it('enforces immutable signed versions and publisher revocation', async () => {
    const source = pluginSource(root);
    const output = join(root, 'signed-demo.tgz');
    const { entry } = await marketplace.createPackage({
      sourceDir: source.dir,
      outputFile: output,
      publisherId: 'verified-author',
      privateKeyPem: publisherKeys.privateKeyPem,
      provenance: source.provenance,
    });
    const exported = marketplace.exportIndex();
    const indexPath = join(root, 'index.json');
    writeFileSync(indexPath, JSON.stringify(exported));
    expect(await marketplace.syncIndex(indexPath)).toMatchObject({ imported: 0, unchanged: 1 });

    const conflicting = {
      ...entry,
      packageDigest: 'd'.repeat(64),
    };
    const conflictPath = join(root, 'conflict.json');
    writeFileSync(conflictPath, JSON.stringify({ schemaVersion: 1, entries: [conflicting] }));
    await expect(marketplace.syncIndex(conflictPath)).rejects.toThrow(/signature|conflict/);

    marketplace.revokePublisher('verified-author', 'security incident');
    expect(marketplace.inspect('signed-demo', '1.0.0')).toMatchObject({ trusted: false, publisher: { state: 'revoked' } });
    await expect(marketplace.quarantine('signed-demo', '1.0.0')).rejects.toThrow(/revoked/);
  });

  it('honors local moderation holds before quarantine/install', async () => {
    const source = pluginSource(root);
    const output = join(root, 'signed-demo.tgz');
    await marketplace.createPackage({
      sourceDir: source.dir,
      outputFile: output,
      publisherId: 'verified-author',
      privateKeyPem: publisherKeys.privateKeyPem,
      provenance: source.provenance,
    });
    expect(marketplace.moderate('signed-demo', '1.0.0', 'security-hold', 'under review')).toMatchObject({
      trusted: false,
      moderation: { state: 'security-hold', reason: 'under review' },
    });
    await expect(marketplace.quarantine('signed-demo', '1.0.0')).rejects.toThrow(/security-hold/);
  });
});
