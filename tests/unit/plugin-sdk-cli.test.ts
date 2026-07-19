import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyMarketplaceEntry, type MarketplaceEntry } from '../../src/marketplace/marketplace-manager.js';
import { executePluginSdkCli } from '../../src/plugins/sdk-cli.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'folderforge-plugin-sdk-'));
  roots.push(value);
  return value;
}

function parsed(output: string): Record<string, any> {
  return JSON.parse(output) as Record<string, any>;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('Plugin SDK CLI', () => {
  it('initializes, validates, starts, lists, and explicitly calls a generated plugin', async () => {
    const workspace = root();
    const plugin = join(workspace, 'demo plugin ü');

    const initialized = await executePluginSdkCli([
      'init',
      plugin,
      '--id',
      'sdk-demo',
      '--name',
      'SDK Demo',
      '--json',
    ]);
    expect(initialized.exitCode).toBe(0);
    expect(parsed(initialized.output)).toMatchObject({ ok: true, id: 'sdk-demo' });
    expect(existsSync(join(plugin, 'folderforge.plugin.json'))).toBe(true);
    expect(existsSync(join(plugin, 'server.mjs'))).toBe(true);

    const validated = await executePluginSdkCli(['validate', plugin, '--json']);
    expect(validated.exitCode).toBe(0);
    expect(parsed(validated.output)).toMatchObject({
      ok: true,
      manifest: { id: 'sdk-demo', version: '1.0.0' },
      integrity: { algorithm: 'sha256', files: 4 },
      warnings: [],
    });

    const tested = await executePluginSdkCli(['test', plugin, '--json']);
    expect(tested.exitCode).toBe(0);
    expect(parsed(tested.output)).toMatchObject({
      ok: true,
      protocolVersion: '2025-11-25',
      tools: ['health', 'echo'],
      sandbox: { mode: 'process', enforced: false },
    });

    const called = await executePluginSdkCli([
      'test',
      plugin,
      '--call',
      'echo',
      '--args-json',
      '{"text":"hello sdk"}',
      '--json',
    ]);
    expect(called.exitCode).toBe(0);
    expect(JSON.stringify(parsed(called.output).callResult)).toContain('hello sdk');
  });

  it('creates deterministic prepared-package tarballs and refuses unsafe output placement', async () => {
    const workspace = root();
    const plugin = join(workspace, 'plugin');
    expect((await executePluginSdkCli(['init', plugin, '--id', 'pack-demo', '--json'])).exitCode).toBe(0);

    const first = join(workspace, 'first.tgz');
    const second = join(workspace, 'second.tgz');
    const packedA = parsed((await executePluginSdkCli(['pack', plugin, '--out', first, '--json'])).output);
    const packedB = parsed((await executePluginSdkCli(['pack', plugin, '--out', second, '--json'])).output);
    expect(packedA.sha256).toBe(packedB.sha256);
    expect(readFileSync(first)).toEqual(readFileSync(second));

    const unsafe = await executePluginSdkCli([
      'pack',
      plugin,
      '--out',
      join(plugin, 'self.tgz'),
      '--json',
    ]);
    expect(unsafe.exitCode).toBe(1);
    expect(parsed(unsafe.output).error).toMatch(/outside the plugin source/i);
  });

  it('generates protected Ed25519 keys and deterministic signed packages with verifiable entries', async () => {
    const workspace = root();
    const plugin = join(workspace, 'plugin');
    const keys = join(workspace, 'keys');
    expect((await executePluginSdkCli(['init', plugin, '--id', 'signed-sdk', '--json'])).exitCode).toBe(0);
    const generated = parsed((await executePluginSdkCli(['keygen', keys, '--json'])).output);
    expect(generated.ok).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(generated.privateKey).mode & 0o777).toBe(0o600);
    }

    const common = [
      'sign',
      plugin,
      '--publisher-id',
      'sdk-publisher',
      '--private-key',
      generated.privateKey,
      '--repository',
      'https://example.invalid/signed-sdk',
      '--commit',
      'a'.repeat(40),
      '--workflow',
      '.github/workflows/plugin.yml',
      '--json',
    ];
    const firstPackage = join(workspace, 'signed-a.tgz');
    const firstEntry = join(workspace, 'signed-a.entry.json');
    const secondPackage = join(workspace, 'signed-b.tgz');
    const secondEntry = join(workspace, 'signed-b.entry.json');
    const first = parsed(
      (await executePluginSdkCli([...common, '--out', firstPackage, '--entry-out', firstEntry])).output,
    );
    const second = parsed(
      (await executePluginSdkCli([...common, '--out', secondPackage, '--entry-out', secondEntry])).output,
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.packageSha256).toBe(second.packageSha256);
    expect(readFileSync(firstPackage)).toEqual(readFileSync(secondPackage));

    const entry = JSON.parse(readFileSync(firstEntry, 'utf8')) as MarketplaceEntry;
    const publicKey = readFileSync(generated.publicKey, 'utf8');
    expect(verifyMarketplaceEntry(entry, publicKey)).toBe(true);
    expect(entry.provenance.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(firstEntry, 'utf8')).not.toContain('PRIVATE KEY');

    if (process.platform !== 'win32') chmodSync(firstEntry, 0o600);
  });

  it('requires digest pinning for generated container templates and distinct key paths', async () => {
    const workspace = root();
    const container = await executePluginSdkCli([
      'init',
      join(workspace, 'container'),
      '--id',
      'container-demo',
      '--sandbox',
      'docker',
      '--image',
      'example/plugin:latest',
      '--json',
    ]);
    expect(container.exitCode).toBe(1);
    expect(parsed(container.output).error).toMatch(/sha256/);

    const same = join(workspace, 'same.pem');
    const keys = await executePluginSdkCli([
      'keygen',
      workspace,
      '--private-key',
      same,
      '--public-key',
      same,
      '--json',
    ]);
    expect(keys.exitCode).toBe(1);
    expect(parsed(keys.output).error).toMatch(/must be different/);
  });
});
