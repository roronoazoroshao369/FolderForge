import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  executeOriginCli,
  installOrigin,
  ORIGIN_UNIT_NAME,
  originEnvPath,
  uninstallOrigin,
} from '../../src/control/origin.js';
import { renderUnit, type ServiceDeps } from '../../src/control/service.js';

const MAIN_JS = '/fake/dist/main.js';

interface FakeHarness {
  deps: ServiceDeps;
  systemctl: string[][];
}

function makeDeps(xdg: string, overrides: Partial<ServiceDeps> = {}): FakeHarness {
  const systemctl: string[][] = [];
  const deps: ServiceDeps = {
    execPath: '/fake/node',
    homeDir: '/tmp/ff-origin-nohome',
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
    getEnv: (name) =>
      name === 'XDG_CONFIG_HOME'
        ? xdg
        : name === 'ORIGIN_TEST_TOKEN'
          ? 'env-token-123'
          : undefined,
    platform: 'linux',
    version: '9.9.9-test',
    ...overrides,
  };
  return { deps, systemctl };
}

const roots: string[] = [];

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'ff-origin-test-'));
  roots.push(root);
  return root;
}

function unitText(project: string): string {
  return readFileSync(join(project, 'xdg', 'systemd', 'user', ORIGIN_UNIT_NAME), 'utf8');
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('origin service', () => {
  it('install writes a unit with a required EnvironmentFile and keeps the token out of it', () => {
    const project = makeProject();
    const xdg = join(project, 'xdg');
    const { deps } = makeDeps(xdg);
    const result = installOrigin(
      {
        project,
        port: 3112,
        authMode: 'token',
        token: 'tok-secret-1',
        enable: false,
        replace: false,
        mainJs: MAIN_JS,
      },
      deps,
    );
    expect(result.exitCode).toBe(0);
    const unitPath = join(xdg, 'systemd', 'user', ORIGIN_UNIT_NAME);
    const unit = readFileSync(unitPath, 'utf8');
    expect(unit).not.toContain('tok-secret-1');
    expect(unit).toContain(`EnvironmentFile=${originEnvPath(project)}`);
    expect(unit).toContain(
      `ExecStart=/fake/node /fake/dist/main.js --project ${project} --http --host 127.0.0.1 --port 3112 --no-dashboard --auth token`,
    );
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('OOMScoreAdjust=-500');
    // The origin unit does NOT get the plane's optional operator env file.
    expect(unit).not.toContain('EnvironmentFile=-');
    expect(unit).toContain('WantedBy=default.target');
    expect(statSync(unitPath).mode & 0o777).toBe(0o600);
    const envFile = originEnvPath(project);
    expect(readFileSync(envFile, 'utf8')).toBe('FOLDERFORGE_HTTP_TOKEN=tok-secret-1\n');
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(result.output).toContain('Origin service installed:');
    expect(result.output).toContain(`systemctl --user enable --now ${ORIGIN_UNIT_NAME}`);
  });

  it('install without secrets renders no EnvironmentFile and writes no env file', () => {
    const project = makeProject();
    const { deps } = makeDeps(join(project, 'xdg'));
    const result = installOrigin(
      { project, port: 7399, authMode: 'none', enable: false, replace: false, mainJs: MAIN_JS },
      deps,
    );
    expect(result.exitCode).toBe(0);
    const unit = unitText(project);
    expect(unit).not.toContain('EnvironmentFile=');
    expect(existsSync(originEnvPath(project))).toBe(false);
  });

  it('reads the token from --token-env and fails when that variable is unset', () => {
    const project = makeProject();
    const { deps } = makeDeps(join(project, 'xdg'));
    const ok = installOrigin(
      {
        project,
        port: 3112,
        authMode: 'token',
        tokenEnv: 'ORIGIN_TEST_TOKEN',
        enable: false,
        replace: false,
        mainJs: MAIN_JS,
      },
      deps,
    );
    expect(ok.exitCode).toBe(0);
    expect(readFileSync(originEnvPath(project), 'utf8')).toBe(
      'FOLDERFORGE_HTTP_TOKEN=env-token-123\n',
    );
    const missing = installOrigin(
      {
        project,
        port: 3112,
        authMode: 'token',
        tokenEnv: 'DEFINITELY_MISSING',
        enable: false,
        replace: false,
        mainJs: MAIN_JS,
      },
      deps,
    );
    expect(missing.exitCode).toBe(1);
    expect(missing.output).toContain('Environment variable DEFINITELY_MISSING is not set');
  });

  it('validates auth/port/flag combinations before writing anything', () => {
    const project = makeProject();
    const { deps } = makeDeps(join(project, 'xdg'));
    const noToken = installOrigin(
      { project, port: 3112, authMode: 'token', enable: false, replace: false, mainJs: MAIN_JS },
      deps,
    );
    expect(noToken.exitCode).toBe(1);
    expect(noToken.output).toContain('--auth token requires');
    const badCombo = installOrigin(
      {
        project,
        port: 3112,
        authMode: 'none',
        allowCritical: true,
        enable: false,
        replace: false,
        mainJs: MAIN_JS,
      },
      deps,
    );
    expect(badCombo.exitCode).toBe(1);
    expect(badCombo.output).toContain('requires --policy danger');
    const badPort = installOrigin(
      { project, port: 80, authMode: 'none', enable: false, replace: false, mainJs: MAIN_JS },
      deps,
    );
    expect(badPort.exitCode).toBe(1);
    expect(badPort.output).toContain('Invalid port');
    const missingProject = installOrigin(
      {
        project: join(project, 'nope'),
        port: 3112,
        authMode: 'none',
        enable: false,
        replace: false,
        mainJs: MAIN_JS,
      },
      deps,
    );
    expect(missingProject.exitCode).toBe(1);
    expect(missingProject.output).toContain('Project directory does not exist');
  });

  it('refuses to overwrite a unit owned by another project unless --replace', () => {
    const projectA = makeProject();
    const projectB = makeProject();
    const xdg = join(projectA, 'xdg');
    const { deps } = makeDeps(xdg);
    const first = installOrigin(
      { project: projectA, port: 3112, authMode: 'none', enable: false, replace: false, mainJs: MAIN_JS },
      deps,
    );
    expect(first.exitCode).toBe(0);
    const conflict = installOrigin(
      { project: projectB, port: 3113, authMode: 'none', enable: false, replace: false, mainJs: MAIN_JS },
      deps,
    );
    expect(conflict.exitCode).toBe(1);
    expect(conflict.output).toContain('already exists for project');
    const replaced = installOrigin(
      { project: projectB, port: 3113, authMode: 'none', enable: false, replace: true, mainJs: MAIN_JS },
      deps,
    );
    expect(replaced.exitCode).toBe(0);
    expect(readFileSync(join(xdg, 'systemd', 'user', ORIGIN_UNIT_NAME), 'utf8')).toContain(
      projectB,
    );
  });

  it('enables via fixed-argv systemctl when --enable is passed', () => {
    const project = makeProject();
    const { deps, systemctl } = makeDeps(join(project, 'xdg'));
    const result = installOrigin(
      { project, port: 3112, authMode: 'none', enable: true, replace: false, mainJs: MAIN_JS },
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(systemctl).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'enable', '--now', ORIGIN_UNIT_NAME],
    ]);
    expect(result.output).toContain('Verify: folderforge origin status');
  });

  it('uninstall is idempotent and names the kept secrets file', () => {
    const project = makeProject();
    const xdg = join(project, 'xdg');
    const { deps, systemctl } = makeDeps(xdg);
    const notInstalled = uninstallOrigin(deps);
    expect(notInstalled.exitCode).toBe(0);
    expect(notInstalled.output).toContain('nothing to do');
    installOrigin(
      { project, port: 3112, authMode: 'token', token: 'tok-1', enable: false, replace: false, mainJs: MAIN_JS },
      deps,
    );
    const removed = uninstallOrigin(deps);
    expect(removed.exitCode).toBe(0);
    expect(removed.output).toContain('Origin service uninstalled:');
    expect(removed.output).toContain('Secrets file kept at');
    expect(
      systemctl.some((args) => args[1] === 'disable' && args.includes(ORIGIN_UNIT_NAME)),
    ).toBe(true);
    expect(existsSync(join(xdg, 'systemd', 'user', ORIGIN_UNIT_NAME))).toBe(false);
  });

  it('status reports not-installed, then enabled/active once a unit exists (text and --json)', () => {
    const project = makeProject();
    const xdg = join(project, 'xdg');
    const { deps } = makeDeps(xdg);
    const cliDeps = { ...deps, mainJs: MAIN_JS };
    const missing = executeOriginCli(['status'], cliDeps);
    expect(missing.exitCode).toBe(0);
    expect(missing.output).toContain('Origin service is not installed');
    installOrigin(
      { project, port: 3112, authMode: 'none', enable: false, replace: false, mainJs: MAIN_JS },
      deps,
    );
    const text = executeOriginCli(['status'], cliDeps);
    expect(text.output).toContain('Origin service installed:');
    expect(text.output).toContain('enabled=enabled active=active');
    const json = executeOriginCli(['status', '--json'], cliDeps);
    const parsed = JSON.parse(json.output) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      installed: true,
      projectRoot: project,
      port: 3112,
      enabled: 'enabled',
      active: 'active',
    });
  });

  it('is Linux-only with a clear message elsewhere', () => {
    const project = makeProject();
    const { deps } = makeDeps(join(project, 'xdg'), { platform: 'darwin' });
    const result = installOrigin(
      { project, port: 3112, authMode: 'none', enable: false, replace: false, mainJs: MAIN_JS },
      deps,
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('only supported on Linux');
  });

  it('keeps the plane unit rendering byte-identical after the service.ts generalization', () => {
    const expected = [
      '# Generated by `folderforge control service install` — edit via the CLI, not by hand.',
      '[Unit]',
      'Description=FolderForge Mission Control plane',
      'After=default.target',
      'StartLimitIntervalSec=60',
      'StartLimitBurst=5',
      '',
      '[Service]',
      'ExecStart=/fake/node /fake/dist/main.js control serve --project /fake/proj --port 7332',
      'Restart=on-failure',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=default.target',
      '# folderforge-version=9.9.9-test',
      '',
    ].join('\n');
    expect(
      renderUnit(
        [
          '/fake/node',
          '/fake/dist/main.js',
          'control',
          'serve',
          '--project',
          '/fake/proj',
          '--port',
          '7332',
        ],
        '9.9.9-test',
      ),
    ).toBe(expected);
  });

  it('executeOriginCli parses install flags end to end (preset/policy/allow-critical/token-env)', () => {
    const project = makeProject();
    const { deps } = makeDeps(join(project, 'xdg'));
    const result = executeOriginCli(
      [
        'install',
        '--project',
        project,
        '--port',
        '3112',
        '--tools-preset',
        'full',
        '--policy',
        'danger',
        '--dangerously-allow-critical',
        '--auth',
        'token',
        '--token-env',
        'ORIGIN_TEST_TOKEN',
      ],
      { ...deps, mainJs: MAIN_JS },
    );
    expect(result.exitCode).toBe(0);
    const unit = unitText(project);
    expect(unit).toContain('--tools-preset full --policy danger --dangerously-allow-critical --auth token');
    expect(unit).not.toContain('env-token-123');
  });

  it('executeOriginCli prints help for a missing/unknown subcommand and rejects unknown flags', () => {
    const project = makeProject();
    const { deps } = makeDeps(join(project, 'xdg'));
    const cliDeps = { ...deps, mainJs: MAIN_JS };
    expect(executeOriginCli([], cliDeps).exitCode).toBe(0);
    expect(executeOriginCli(['frobnicate'], cliDeps).exitCode).toBe(1);
    const unknown = executeOriginCli(
      ['install', '--project', project, '--port', '3112', '--wat'],
      cliDeps,
    );
    expect(unknown.exitCode).toBe(1);
    expect(unknown.output).toContain('Unknown argument: --wat');
  });

  it('captures the installer PATH into the unit as Environment= (alongside secrets)', () => {
    const project = makeProject();
    const xdg = join(project, 'xdg');
    const { deps } = makeDeps(xdg, {
      getEnv: (name) =>
        name === 'XDG_CONFIG_HOME'
          ? xdg
          : name === 'PATH'
            ? '/nvm/bin:/usr/bin'
            : undefined,
    });
    const result = installOrigin(
      {
        project,
        port: 3112,
        authMode: 'token',
        token: 'tok-secret-1',
        enable: false,
        replace: false,
        mainJs: MAIN_JS,
      },
      deps,
    );
    expect(result.exitCode).toBe(0);
    const unit = unitText(project);
    expect(unit).toContain('Environment=PATH=/nvm/bin:/usr/bin');
    expect(unit).toContain(`EnvironmentFile=${originEnvPath(project)}`);
    // PATH is environment config, not a secret: it must stay out of origin.env.
    expect(readFileSync(originEnvPath(project), 'utf8')).toBe(
      'FOLDERFORGE_HTTP_TOKEN=tok-secret-1\n',
    );
  });

  it('captures PATH for auth=none installs too (no env file involved)', () => {
    const project = makeProject();
    const xdg = join(project, 'xdg');
    const { deps } = makeDeps(xdg, {
      getEnv: (name) =>
        name === 'XDG_CONFIG_HOME' ? xdg : name === 'PATH' ? '/nvm/bin:/usr/bin' : undefined,
    });
    const result = installOrigin(
      { project, port: 7399, authMode: 'none', enable: false, replace: false, mainJs: MAIN_JS },
      deps,
    );
    expect(result.exitCode).toBe(0);
    const unit = unitText(project);
    expect(unit).toContain('Environment=PATH=/nvm/bin:/usr/bin');
    expect(unit).not.toContain('EnvironmentFile=');
    expect(existsSync(originEnvPath(project))).toBe(false);
  });

  it('quotes the Environment line when the captured PATH contains a space', () => {
    const project = makeProject();
    const xdg = join(project, 'xdg');
    const { deps } = makeDeps(xdg, {
      getEnv: (name) =>
        name === 'XDG_CONFIG_HOME'
          ? xdg
          : name === 'PATH'
            ? '/opt/my dir/bin:/usr/bin'
            : undefined,
    });
    const result = installOrigin(
      { project, port: 3113, authMode: 'none', enable: false, replace: false, mainJs: MAIN_JS },
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(unitText(project)).toContain('Environment="PATH=/opt/my dir/bin:/usr/bin"');
  });

  it('renders no Environment line when the installer PATH is undefined', () => {
    const project = makeProject();
    const { deps } = makeDeps(join(project, 'xdg'));
    const result = installOrigin(
      { project, port: 3114, authMode: 'none', enable: false, replace: false, mainJs: MAIN_JS },
      deps,
    );
    expect(result.exitCode).toBe(0);
    // Environment= never appears (EnvironmentFile= shares no such substring).
    expect(unitText(project)).not.toContain('Environment=');
  });
});
