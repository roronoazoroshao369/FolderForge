import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  executeTunnelCli,
  installTunnel,
  tunnelStatus,
  tunnelUnitName,
  uninstallTunnel,
} from '../../src/control/tunnel.js';
import type { ServiceDeps } from '../../src/control/service.js';

const FAKE_BIN = '/fake/cloudflared';

interface FakeHarness {
  deps: ServiceDeps;
  systemctl: string[][];
}

function makeDeps(xdg: string, overrides: Partial<ServiceDeps> = {}): FakeHarness {
  const systemctl: string[][] = [];
  const deps: ServiceDeps = {
    execPath: '/fake/node',
    homeDir: '/tmp/ff-tunnel-nohome',
    // Fake runtime paths count as existing; everything else hits the real fs.
    fileExists: (path) => path.startsWith('/fake/') || existsSync(path),
    execSystemctl: (args) => {
      systemctl.push(args);
      const verb = args[1];
      return {
        exitCode: 0,
        stdout: verb === 'is-enabled' ? 'enabled\n' : verb === 'is-active' ? 'active\n' : '',
        stderr: '',
      };
    },
    getEnv: (name) => (name === 'XDG_CONFIG_HOME' ? xdg : undefined),
    platform: 'linux',
    version: '9.9.9-test',
    ...overrides,
  };
  return { deps, systemctl };
}

const roots: string[] = [];

function makeFixture(): { root: string; configPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'ff-tunnel-test-'));
  roots.push(root);
  mkdirSync(join(root, 'cf'), { recursive: true });
  const configPath = join(root, 'cf', 'proof.yml');
  writeFileSync(
    configPath,
    'tunnel: 00000000-0000-0000-0000-000000000000\ncredentials-file: /fake/creds.json\n\ningress:\n  - service: http_status:404\n',
  );
  return { root, configPath };
}

function unitPath(xdg: string, name: string): string {
  return join(xdg, 'systemd', 'user', tunnelUnitName(name));
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('tunnel service', () => {
  it('install writes a supervised unit with no secrets and no EnvironmentFile', () => {
    const { root, configPath } = makeFixture();
    const xdg = join(root, 'xdg');
    const { deps } = makeDeps(xdg);
    const result = installTunnel(
      { name: 'folder-forge', configPath, bin: FAKE_BIN, enable: false, replace: false },
      deps,
    );
    expect(result.exitCode).toBe(0);
    const path = unitPath(xdg, 'folder-forge');
    const unit = readFileSync(path, 'utf8');
    expect(unit).toContain(
      `ExecStart=/fake/cloudflared tunnel --config ${configPath} run folder-forge`,
    );
    expect(unit).not.toContain('EnvironmentFile=');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('OOMScoreAdjust=-500');
    expect(unit).toContain('WantedBy=default.target');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(result.output).toContain('Tunnel service installed:');
    expect(result.output).toContain(
      `systemctl --user enable --now ${tunnelUnitName('folder-forge')}`,
    );
  });

  it('quotes ExecStart when the config path contains a space', () => {
    const { root } = makeFixture();
    const xdg = join(root, 'xdg');
    const dir = join(root, 'cf dir');
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, 'my tunnel.yml');
    writeFileSync(configPath, 'ingress:\n  - service: http_status:404\n');
    const { deps } = makeDeps(xdg);
    const result = installTunnel(
      { name: 'proof', configPath, bin: FAKE_BIN, enable: false, replace: false },
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(readFileSync(unitPath(xdg, 'proof'), 'utf8')).toContain(`--config "${configPath}"`);
  });

  it('validates name, config absoluteness, and runtime files before writing', () => {
    const { root, configPath } = makeFixture();
    const { deps } = makeDeps(join(root, 'xdg'));
    const badName = installTunnel(
      { name: 'Bad Name!', configPath, bin: FAKE_BIN, enable: false, replace: false },
      deps,
    );
    expect(badName.exitCode).toBe(1);
    expect(badName.output).toContain('Invalid tunnel name');
    const relative = installTunnel(
      { name: 'proof', configPath: 'relative/t.yml', bin: FAKE_BIN, enable: false, replace: false },
      deps,
    );
    expect(relative.exitCode).toBe(1);
    expect(relative.output).toContain('absolute path');
    const missingBin = installTunnel(
      { name: 'proof', configPath, bin: join(root, 'nope'), enable: false, replace: false },
      deps,
    );
    expect(missingBin.exitCode).toBe(1);
    expect(missingBin.output).toContain('Runtime files are missing');
    const missingConfig = installTunnel(
      { name: 'proof', configPath: join(root, 'nope.yml'), bin: FAKE_BIN, enable: false, replace: false },
      deps,
    );
    expect(missingConfig.exitCode).toBe(1);
    expect(missingConfig.output).toContain('Runtime files are missing');
    // Underscore names are valid: Cloudflare allows them in tunnel names and
    // systemd accepts them in unit names (proposal 022; loop #51 evidence:
    // the operator's repo_vibecode tunnel serves production traffic).
    const underscored = installTunnel(
      { name: 'repo_vibecode', configPath, bin: FAKE_BIN, enable: false, replace: false },
      deps,
    );
    expect(underscored.exitCode).toBe(0);
    const unit = readFileSync(unitPath(join(root, 'xdg'), 'repo_vibecode'), 'utf8');
    expect(unit).toContain('run repo_vibecode');
    const leadingUnderscore = installTunnel(
      { name: '_lead', configPath, bin: FAKE_BIN, enable: false, replace: false },
      deps,
    );
    expect(leadingUnderscore.exitCode).toBe(1);
    expect(leadingUnderscore.output).toContain('Invalid tunnel name');
    const overlong = installTunnel(
      { name: 'a'.repeat(33), configPath, bin: FAKE_BIN, enable: false, replace: false },
      deps,
    );
    expect(overlong.exitCode).toBe(1);
    expect(overlong.output).toContain('Invalid tunnel name');
  });

  it('reinstalls the same tunnel name by overwriting (the config update path)', () => {
    const { root, configPath } = makeFixture();
    const xdg = join(root, 'xdg');
    const { deps } = makeDeps(xdg);
    const first = installTunnel(
      { name: 'folder-forge', configPath, bin: FAKE_BIN, enable: false, replace: false },
      deps,
    );
    expect(first.exitCode).toBe(0);
    const dir2 = join(root, 'cf2');
    mkdirSync(dir2, { recursive: true });
    const configPath2 = join(dir2, 'v2.yml');
    writeFileSync(configPath2, 'ingress:\n  - service: http_status:404\n');
    const second = installTunnel(
      { name: 'folder-forge', configPath: configPath2, bin: FAKE_BIN, enable: false, replace: false },
      deps,
    );
    expect(second.exitCode).toBe(0);
    expect(readFileSync(unitPath(xdg, 'folder-forge'), 'utf8')).toContain(configPath2);
  });

  it('enables via fixed-argv systemctl when --enable is passed', () => {
    const { root, configPath } = makeFixture();
    const { deps, systemctl } = makeDeps(join(root, 'xdg'));
    const result = installTunnel(
      { name: 'proof', configPath, bin: FAKE_BIN, enable: true, replace: false },
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(systemctl).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'enable', '--now', tunnelUnitName('proof')],
    ]);
  });

  it('uninstall is idempotent and notes that config/credentials are kept', () => {
    const { root, configPath } = makeFixture();
    const xdg = join(root, 'xdg');
    const { deps } = makeDeps(xdg);
    const notInstalled = uninstallTunnel(deps, 'proof');
    expect(notInstalled.exitCode).toBe(0);
    expect(notInstalled.output).toContain('nothing to do');
    installTunnel(
      { name: 'proof', configPath, bin: FAKE_BIN, enable: false, replace: false },
      deps,
    );
    const removed = uninstallTunnel(deps, 'proof');
    expect(removed.exitCode).toBe(0);
    expect(removed.output).toContain('Tunnel service uninstalled:');
    expect(removed.output).toContain('credentials are kept');
    expect(existsSync(unitPath(xdg, 'proof'))).toBe(false);
    expect(existsSync(configPath)).toBe(true);
  });

  it('status reports not-installed, then enabled/active once a unit exists (text and --json)', () => {
    const { root, configPath } = makeFixture();
    const xdg = join(root, 'xdg');
    const { deps } = makeDeps(xdg);
    const missing = tunnelStatus(deps, 'proof');
    expect(missing.exitCode).toBe(0);
    expect(missing.output).toContain('Tunnel service is not installed');
    installTunnel(
      { name: 'proof', configPath, bin: FAKE_BIN, enable: false, replace: false },
      deps,
    );
    const text = tunnelStatus(deps, 'proof');
    expect(text.output).toContain('Tunnel service installed:');
    expect(text.output).toContain(`Tunnel: proof (config ${configPath})`);
    expect(text.output).toContain('enabled=enabled active=active');
    const json = executeTunnelCli(['status', '--name', 'proof', '--json'], deps);
    const parsed = JSON.parse(json.output) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      installed: true,
      name: 'proof',
      configPath,
      enabled: 'enabled',
      active: 'active',
    });
  });

  it('is Linux-only with a clear message elsewhere', () => {
    const { root, configPath } = makeFixture();
    const { deps } = makeDeps(join(root, 'xdg'), { platform: 'darwin' });
    const result = installTunnel(
      { name: 'proof', configPath, bin: FAKE_BIN, enable: false, replace: false },
      deps,
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('only supported on Linux');
    expect(tunnelStatus(deps, 'proof').exitCode).toBe(1);
  });

  it('executeTunnelCli parses install flags end to end and rejects unknown flags', () => {
    const { root, configPath } = makeFixture();
    const xdg = join(root, 'xdg');
    const { deps } = makeDeps(xdg);
    const result = executeTunnelCli(
      ['install', '--name', 'folder-forge', '--config', configPath, '--bin', FAKE_BIN],
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(readFileSync(unitPath(xdg, 'folder-forge'), 'utf8')).toContain('run folder-forge');
    expect(executeTunnelCli([], deps).exitCode).toBe(0);
    expect(executeTunnelCli(['frobnicate'], deps).exitCode).toBe(1);
    const unknown = executeTunnelCli(
      ['install', '--name', 'x', '--config', configPath, '--wat'],
      deps,
    );
    expect(unknown.exitCode).toBe(1);
    expect(unknown.output).toContain('Unknown argument: --wat');
    const noName = executeTunnelCli(['status'], deps);
    expect(noName.exitCode).toBe(1);
    expect(noName.output).toContain('requires --name');
    const noConfig = executeTunnelCli(['install', '--name', 'x'], deps);
    expect(noConfig.exitCode).toBe(1);
    expect(noConfig.output).toContain('requires --config');
  });
});
