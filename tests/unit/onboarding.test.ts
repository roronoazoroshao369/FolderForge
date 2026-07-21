import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configForProfile,
  executeConnectClientCli,
  executeInitCli,
} from '../../src/onboarding/cli.js';
import { loadConfig } from '../../src/runtime/config.js';

const roots: string[] = [];

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-onboarding-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('safe onboarding', () => {
  it.each([
    ['observe', 'readonly', 'readonly', 'best-effort'],
    ['develop', 'safe', 'vibe-lite', 'required'],
    ['trusted-automation', 'dev', 'vibe', 'required'],
  ] as const)(
    'maps %s to an explicit policy and tool profile',
    (profile, mode, preset, durability) => {
      const root = projectRoot();
      const config = configForProfile(root, profile);
      expect(config).toMatchObject({
        server: { transport: 'stdio' },
        workspace: {
          defaultProject: root,
          allowedDirectories: [root],
        },
        policy: { defaultMode: mode },
        audit: { durability },
        tools: { preset },
        adapters: {
          playwright: { enabled: false },
          serena: { enabled: false },
          godot: { enabled: false },
        },
      });
    },
  );

  it('creates a loadable config only through explicit init', () => {
    const root = projectRoot();
    expect(existsSync(join(root, '.folderforge', 'config.yaml'))).toBe(false);

    const result = executeInitCli([
      '--project',
      root,
      '--profile',
      'develop',
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.output);
    expect(output).toMatchObject({ ok: true, profile: 'develop' });
    expect(output.configPath).toBe(join(root, '.folderforge', 'config.yaml'));

    const raw = readFileSync(output.configPath, 'utf8');
    const parsed = parseYaml(raw);
    expect(parsed).toMatchObject({
      server: { transport: 'stdio' },
      policy: { defaultMode: 'safe' },
      audit: { durability: 'required' },
      tools: { preset: 'vibe-lite' },
      workspace: { defaultProject: '.', allowedDirectories: ['.'] },
    });
    const loaded = loadConfig({ projectRoot: root });
    expect(loaded).toMatchObject({
      policy: { defaultMode: 'safe' },
      audit: { durability: 'required' },
    });
  });

  it('refuses accidental overwrite and creates a backup on force', () => {
    const root = projectRoot();
    const target = join(root, 'folderforge.yaml');
    writeFileSync(target, 'server:\n  name: old\n');

    const refused = executeInitCli(['--project', root, '--json']);
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.output)).toMatchObject({
      ok: false,
      configPath: target,
    });
    expect(readFileSync(target, 'utf8')).toContain('name: old');

    const replaced = executeInitCli([
      '--project',
      root,
      '--profile',
      'observe',
      '--force',
      '--json',
    ]);
    expect(replaced.exitCode).toBe(0);
    const data = JSON.parse(replaced.output);
    expect(data.configPath).toBe(target);
    expect(data.backupPath).toMatch(/folderforge\.yaml\.backup-/);
    expect(readFileSync(data.backupPath, 'utf8')).toContain('name: old');
    expect(parseYaml(readFileSync(target, 'utf8'))).toMatchObject({
      policy: { defaultMode: 'readonly' },
    });
  });

  it('returns structured errors for missing flag values', () => {
    const root = projectRoot();
    const result = executeInitCli(['--project', root, '--profile', '--json']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: false,
      error: '--profile requires a value.',
    });

    const missingProject = executeConnectClientCli(['cursor', '--project', '--json']);
    expect(missingProject.exitCode).toBe(1);
    expect(JSON.parse(missingProject.output)).toMatchObject({ ok: false });
  });

  it('merges Cursor configuration without deleting existing servers', () => {
    const root = projectRoot();
    const target = join(root, '.cursor', 'mcp.json');
    mkdirSync(join(root, '.cursor'), { recursive: true });
    writeFileSync(
      target,
      `${JSON.stringify({ mcpServers: { existing: { command: 'old' } }, other: true }, null, 2)}\n`,
    );

    const result = executeConnectClientCli([
      'cursor',
      '--project',
      root,
      '--write',
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({
      mcpServers: {
        existing: { command: 'old' },
        folderforge: {
          command: process.platform === 'win32' ? 'folderforge.cmd' : 'folderforge',
          args: ['--stdio', '--project', root],
        },
      },
      other: true,
    });
  });

  it('writes the VS Code stdio schema and refuses malformed existing JSON', () => {
    const root = projectRoot();
    const written = executeConnectClientCli([
      'vscode',
      '--project',
      root,
      '--write',
      '--json',
    ]);
    expect(written.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(root, '.vscode', 'mcp.json'), 'utf8'))).toEqual({
      servers: {
        folderforge: {
          type: 'stdio',
          command: process.platform === 'win32' ? 'folderforge.cmd' : 'folderforge',
          args: ['--stdio', '--project', root],
        },
      },
    });

    const cursorPath = join(root, '.cursor', 'mcp.json');
    mkdirSync(join(root, '.cursor'), { recursive: true });
    writeFileSync(cursorPath, '{not-json}');
    const refused = executeConnectClientCli([
      'cursor',
      '--project',
      root,
      '--write',
      '--json',
    ]);
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.output).error).toMatch(/invalid JSON/i);
    expect(readFileSync(cursorPath, 'utf8')).toBe('{not-json}');
  });

  it('prints generic JSON and a Claude Code command without mutating the project', () => {
    const root = projectRoot();
    const generic = executeConnectClientCli([
      'generic',
      '--project',
      root,
      '--json',
    ]);
    expect(JSON.parse(generic.output)).toMatchObject({
      ok: true,
      config: {
        mcpServers: {
          folderforge: { args: ['--stdio', '--project', root] },
        },
      },
    });

    const claude = executeConnectClientCli([
      'claude',
      '--project',
      root,
      '--json',
    ]);
    expect(JSON.parse(claude.output).command).toContain(
      'claude mcp add --transport stdio --scope project folderforge',
    );
    expect(readdirSync(root)).toEqual([]);
  });
});
