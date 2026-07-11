import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginManager, satisfiesFolderForgeRange } from '../../src/plugins/plugin-manager.js';

function writePlugin(source: string, version = '1.0.0', range = '^1.6.0'): void {
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'server.mjs'), 'process.stdin.resume();\n');
  writeFileSync(join(source, 'folderforge.plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'demo-plugin',
    name: 'Demo Plugin',
    version,
    compatibility: { folderforge: range },
    runtime: { command: 'node', args: ['{pluginDir}/server.mjs'], facade: true },
    permissions: { network: false, filesystem: 'workspace', env: ['PLUGIN_ALLOWED'] },
    risk: {
      default: { risk: 'MEDIUM', mutates: true },
      tools: { echo: { risk: 'LOW', mutates: false } }
    }
  }, null, 2));
}

describe('PluginManager', () => {
  let root: string;
  let source: string;
  let previousAllowed: string | undefined;
  let previousSecret: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'folderforge-plugin-'));
    source = join(root, 'source');
    writePlugin(source);
    previousAllowed = process.env.PLUGIN_ALLOWED;
    previousSecret = process.env.PLUGIN_SECRET;
    process.env.PLUGIN_ALLOWED = 'allowed-value';
    process.env.PLUGIN_SECRET = 'must-not-leak';
  });

  afterEach(() => {
    if (previousAllowed === undefined) delete process.env.PLUGIN_ALLOWED;
    else process.env.PLUGIN_ALLOWED = previousAllowed;
    if (previousSecret === undefined) delete process.env.PLUGIN_SECRET;
    else process.env.PLUGIN_SECRET = previousSecret;
    rmSync(root, { recursive: true, force: true });
  });

  it('supports exact, minimum, and caret compatibility ranges', () => {
    expect(satisfiesFolderForgeRange('1.6.0', '1.6.0')).toBe(true);
    expect(satisfiesFolderForgeRange('1.7.2', '>=1.6.0')).toBe(true);
    expect(satisfiesFolderForgeRange('1.9.0', '^1.6.0')).toBe(true);
    expect(satisfiesFolderForgeRange('2.0.0', '^1.6.0')).toBe(false);
  });

  it('installs, verifies integrity, updates, enables, and uninstalls a local package', async () => {
    const manager = new PluginManager(root, '1.6.0');
    const installed = manager.install(source, false);
    expect(installed).toMatchObject({
      id: 'demo-plugin', version: '1.0.0', enabled: false, facade: true,
      integrity: { algorithm: 'sha256', files: 2 },
    });
    expect(manager.inspect('demo-plugin').integrity.status).toBe('verified');
    expect(readFileSync(join(installed.installDir, 'folderforge.plugin.json'), 'utf8')).toContain('demo-plugin');

    const adapter = manager.adapter('demo-plugin');
    expect(adapter.def).toMatchObject({ command: 'node', cwd: installed.installDir, inheritEnv: false, facade: true });
    expect(adapter.def.env?.PLUGIN_ALLOWED).toBe('allowed-value');
    expect(adapter.def.env?.PLUGIN_SECRET).toBeUndefined();
    expect(adapter.riskMap.echo).toEqual({ risk: 'LOW', mutates: false });

    const updateSource = join(root, 'update');
    writePlugin(updateSource, '1.1.0');
    expect((await manager.update('demo-plugin', updateSource)).version).toBe('1.1.0');
    expect(manager.setEnabled('demo-plugin', true).enabled).toBe(true);
    expect(manager.uninstall('demo-plugin').id).toBe('demo-plugin');
    expect(manager.list()).toEqual([]);
  });

  it('rejects post-install package tampering', () => {
    const manager = new PluginManager(root, '1.6.0');
    const installed = manager.install(source, false);
    writeFileSync(join(installed.installDir, 'server.mjs'), 'tampered\n');
    expect(() => manager.inspect('demo-plugin')).toThrow(/integrity mismatch/i);
    expect(() => manager.adapter('demo-plugin')).toThrow(/integrity mismatch/i);
  });

  it('rolls back package and registry when post-replacement verification fails', async () => {
    const manager = new PluginManager(root, '1.6.0');
    manager.install(source, true);
    const updateSource = join(root, 'update-verify-failure');
    writePlugin(updateSource, '1.1.0');

    await expect(manager.update('demo-plugin', updateSource, async () => {
      throw new Error('activation failed');
    })).rejects.toThrow(/activation failed/);

    const restored = manager.inspect('demo-plugin');
    expect(restored.installed.version).toBe('1.0.0');
    expect(readFileSync(join(restored.installed.installDir, 'server.mjs'), 'utf8')).toContain('process.stdin.resume');
    expect(restored.integrity.status).toBe('verified');
  });

  it('rejects incompatible packages and symlinks', () => {
    const incompatible = join(root, 'incompatible');
    writePlugin(incompatible, '1.0.0', '^2.0.0');
    expect(() => new PluginManager(root, '1.6.0').install(incompatible)).toThrow(/requires FolderForge/);

    const linked = join(root, 'linked');
    writePlugin(linked);
    symlinkSync(join(linked, 'server.mjs'), join(linked, 'alias.mjs'));
    expect(() => new PluginManager(root, '1.6.0').install(linked)).toThrow(/symlinks/);
  });
});
