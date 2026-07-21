import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { FolderForgeConfig } from '../core/types.js';
import { defaultConfig } from '../runtime/config.js';

export type OnboardingProfile =
  | 'observe'
  | 'develop'
  | 'trusted-automation';
export type StdioClient = 'generic' | 'cursor' | 'vscode' | 'claude';

export interface OnboardingCliResult {
  exitCode: number;
  output: string;
}

export function configForProfile(
  projectRoot: string,
  profile: OnboardingProfile,
): FolderForgeConfig {
  const root = resolve(projectRoot);
  const config = defaultConfig(root);
  config.server.transport = 'stdio';
  config.server.dashboard.enabled = false;
  config.workspace.defaultProject = root;
  config.workspace.allowedDirectories = [root];
  config.audit.durability = profile === 'observe' ? 'best-effort' : 'required';
  if (config.adapters.playwright) config.adapters.playwright.enabled = false;
  if (config.adapters.serena) config.adapters.serena.enabled = false;
  if (config.adapters.godot) config.adapters.godot.enabled = false;

  if (profile === 'observe') {
    config.policy.defaultMode = 'readonly';
    config.tools = { preset: 'readonly' };
  } else if (profile === 'develop') {
    config.policy.defaultMode = 'safe';
    config.tools = { preset: 'vibe-lite' };
  } else {
    config.policy.defaultMode = 'dev';
    config.tools = { preset: 'vibe' };
    config.audit.durability = 'required';
  }
  return config;
}

export function renderProfileConfig(
  projectRoot: string,
  profile: OnboardingProfile,
): string {
  const config = configForProfile(projectRoot, profile);
  const portable = {
    ...config,
    workspace: {
      ...config.workspace,
      defaultProject: '.',
      allowedDirectories: ['.'],
    },
  };
  return [
    '# FolderForge configuration.',
    `# Profile: ${profile}`,
    '# Created explicitly by `folderforge init`; ordinary startup never creates or overwrites this file.',
    '',
    stringifyYaml(portable).trimEnd(),
    '',
  ].join('\n');
}

export function executeInitCli(argv: string[]): OnboardingCliResult {
  try {
    return executeInitCliUnsafe(argv);
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : String(error),
      argv.includes('--json'),
    );
  }
}

function executeInitCliUnsafe(argv: string[]): OnboardingCliResult {
  let projectRoot = process.cwd();
  let profile: OnboardingProfile = 'develop';
  let force = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project' || arg === '-p') projectRoot = requireValue(argv, ++index, arg);
    else if (arg === '--profile') {
      const value = requireValue(argv, ++index, arg);
      if (!isProfile(value)) {
        return failure(`Unknown profile ${value}. Use observe, develop, or trusted-automation.`, json);
      }
      profile = value;
    } else if (arg === '--force') force = true;
    else if (arg === '--json') json = true;
    else return failure(`Unknown init argument: ${arg}`, json);
  }

  const root = resolve(projectRoot);
  const existing = discoverProjectConfig(root);
  const target = existing ?? resolve(root, '.folderforge', 'config.yaml');
  if (existing && !force) {
    return failure(
      `FolderForge is already configured at ${existing}. Re-run with --force to replace it after creating a backup.`,
      json,
      { configPath: existing },
    );
  }

  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  let backupPath: string | null = null;
  if (existsSync(target)) {
    backupPath = `${target}.backup-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
    renameSync(target, backupPath);
  }
  writeFileSync(target, renderProfileConfig(root, profile), {
    encoding: 'utf8',
    mode: 0o600,
  });

  const data = {
    ok: true,
    profile,
    projectRoot: root,
    configPath: target,
    backupPath,
    next: [
      'folderforge doctor',
      'folderforge connect cursor --write',
      'folderforge --stdio',
    ],
  };
  if (json) return { exitCode: 0, output: `${JSON.stringify(data, null, 2)}\n` };
  return {
    exitCode: 0,
    output: [
      `Initialized FolderForge profile "${profile}".`,
      `Config: ${target}`,
      ...(backupPath ? [`Backup: ${backupPath}`] : []),
      '',
      'Next:',
      '  1. folderforge doctor',
      '  2. folderforge connect cursor --write   # or vscode / claude / generic',
      '  3. Start your MCP client and inspect the effective tool/policy boundary.',
      '',
    ].join('\n'),
  };
}

export function executeConnectClientCli(argv: string[]): OnboardingCliResult {
  try {
    return executeConnectClientCliUnsafe(argv);
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : String(error),
      argv.includes('--json'),
    );
  }
}

function executeConnectClientCliUnsafe(argv: string[]): OnboardingCliResult {
  const client = argv[0] as StdioClient | undefined;
  if (!client || !isClient(client)) {
    return failure(
      `Unknown client ${client ?? '<missing>'}. Use cursor, vscode, claude, or generic.`,
      argv.includes('--json'),
    );
  }
  let projectRoot = process.cwd();
  let write = false;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project' || arg === '-p') projectRoot = requireValue(argv, ++index, arg);
    else if (arg === '--write') write = true;
    else if (arg === '--json') json = true;
    else return failure(`Unknown connect argument: ${arg}`, json);
  }
  const root = resolve(projectRoot);
  const command = process.platform === 'win32' ? 'folderforge.cmd' : 'folderforge';
  const server = {
    command,
    args: ['--stdio', '--project', root],
  };

  if (client === 'claude') {
    const shell = `claude mcp add --transport stdio --scope project folderforge -- ${quote(command)} --stdio --project ${quote(root)}`;
    if (write) {
      return failure(
        'Claude Code manages its own MCP configuration. Run the printed command instead of using --write.',
        json,
        { command: shell },
      );
    }
    return connectOutput(json, { client, projectRoot: root, command: shell });
  }

  if (client === 'generic') {
    if (write) return failure('The generic client format cannot be written automatically.', json);
    return connectOutput(json, {
      client,
      projectRoot: root,
      config: { mcpServers: { folderforge: server } },
    });
  }

  const target =
    client === 'cursor'
      ? resolve(root, '.cursor', 'mcp.json')
      : resolve(root, '.vscode', 'mcp.json');
  const key = client === 'cursor' ? 'mcpServers' : 'servers';
  const entry =
    client === 'cursor' ? server : { type: 'stdio' as const, ...server };
  const config = { [key]: { folderforge: entry } };
  if (!write) return connectOutput(json, { client, projectRoot: root, target, config });

  const current = readJsonObject(target);
  const section =
    current[key] === undefined ? {} : objectValue(current[key], key, target);
  current[key] = { ...section, folderforge: entry };
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, `${JSON.stringify(current, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return connectOutput(json, {
    client,
    projectRoot: root,
    target,
    written: true,
    config: current,
  });
}

function discoverProjectConfig(root: string): string | null {
  for (const path of [
    resolve(root, 'folderforge.yaml'),
    resolve(root, '.folderforge.yaml'),
    resolve(root, '.folderforge', 'config.yaml'),
  ]) {
    if (existsSync(path)) return path;
  }
  return null;
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `Refusing to modify invalid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return objectValue(parsed, 'root', path);
}

function objectValue(value: unknown, label: string, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object in ${path}.`);
  }
  return { ...(value as Record<string, unknown>) };
}

function connectOutput(json: boolean, data: Record<string, unknown>): OnboardingCliResult {
  if (json) return { exitCode: 0, output: `${JSON.stringify({ ok: true, ...data }, null, 2)}\n` };
  return {
    exitCode: 0,
    output: `${JSON.stringify(data, null, 2)}\n`,
  };
}

function failure(
  message: string,
  json: boolean,
  details: Record<string, unknown> = {},
): OnboardingCliResult {
  return {
    exitCode: 1,
    output: json
      ? `${JSON.stringify({ ok: false, error: message, ...details }, null, 2)}\n`
      : `Error: ${message}\n`,
  };
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function isProfile(value: string): value is OnboardingProfile {
  return ['observe', 'develop', 'trusted-automation'].includes(value);
}

function isClient(value: string): value is StdioClient {
  return ['generic', 'cursor', 'vscode', 'claude'].includes(value);
}

function quote(value: string): string {
  return JSON.stringify(value);
}
