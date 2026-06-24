import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { FolderForgeConfig } from './types.js';
import { logger } from './logger.js';

const DEFAULT_BLOCKED = [
  'rm -rf /',
  'sudo rm',
  'mkfs',
  'dd if=',
  'chmod -R 777 /',
  'chown -R',
  'curl * | bash',
  'wget * | sh',
  'git reset --hard',
  'git push --force',
  'docker system prune',
  'kubectl delete',
  'terraform apply',
];

const DEFAULT_DENIED_GLOBS = [
  '**/.env',
  '**/.env.*',
  '**/id_rsa',
  '**/id_ed25519',
  '**/*.pem',
  '**/*.key',
  '**/node_modules/**',
  '**/.git/objects/**',
];

export function defaultConfig(projectRoot: string): FolderForgeConfig {
  return {
    server: {
      name: 'folderforge',
      transport: 'stdio',
      http: { host: '127.0.0.1', port: 7331 },
      dashboard: { host: '127.0.0.1', port: 7332 },
    },
    workspace: {
      defaultProject: projectRoot,
      allowedDirectories: [projectRoot],
      deniedGlobs: [...DEFAULT_DENIED_GLOBS],
    },
    policy: {
      defaultMode: 'safe',
      requireApproval: [
        'git_push',
        'git_commit',
        'file_delete',
        'db_write',
        'shell_high_risk',
        'docker_prune',
      ],
      blockedCommands: [...DEFAULT_BLOCKED],
    },
    terminal: {
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
      defaultTimeoutMs: 120000,
      maxOutputBytes: 200000,
      envPolicy: 'redact',
    },
    git: {
      allowCommit: 'approval',
      allowPush: 'approval',
      allowResetHard: false,
    },
    adapters: {
      serena: { enabled: false, command: 'serena', args: [] },
      playwright: { enabled: false, command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    },
  };
}

function deepMerge<T>(base: T, override: Partial<T>): T {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || Array.isArray(override)) {
    return (override ?? base) as T;
  }
  if (typeof base === 'object' && typeof override === 'object') {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
      const bv = (base as Record<string, unknown>)[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && bv && typeof bv === 'object') {
        out[k] = deepMerge(bv, v as Record<string, unknown>);
      } else if (v !== undefined) {
        out[k] = v;
      }
    }
    return out as T;
  }
  return (override ?? base) as T;
}

export interface LoadConfigOptions {
  configPath?: string;
  projectRoot?: string;
}

export function loadConfig(opts: LoadConfigOptions = {}): FolderForgeConfig {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  let cfg = defaultConfig(projectRoot);

  const candidatePaths = [
    opts.configPath,
    process.env.FOLDERFORGE_CONFIG,
    resolve(projectRoot, 'folderforge.yaml'),
    resolve(projectRoot, '.folderforge.yaml'),
    resolve(projectRoot, '.vibemcp/config.yaml'),
  ].filter((p): p is string => Boolean(p));

  for (const p of candidatePaths) {
    const abs = isAbsolute(p) ? p : resolve(projectRoot, p);
    if (existsSync(abs)) {
      try {
        const raw = readFileSync(abs, 'utf8');
        const parsed = parseYaml(raw) as Partial<FolderForgeConfig>;
        cfg = deepMerge(cfg, parsed);
        logger.info({ configPath: abs }, 'Loaded config file');
      } catch (err) {
        logger.warn({ configPath: abs, err: String(err) }, 'Failed to parse config; using defaults');
      }
      break;
    }
  }

  // Normalize allowed dirs to absolute.
  cfg.workspace.allowedDirectories = cfg.workspace.allowedDirectories.map((d) =>
    isAbsolute(d) ? resolve(d) : resolve(projectRoot, d)
  );
  if (cfg.workspace.defaultProject) {
    cfg.workspace.defaultProject = resolve(cfg.workspace.defaultProject);
  }
  return cfg;
}
