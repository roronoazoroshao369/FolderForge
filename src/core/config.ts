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
    rateLimit: {
      enabled: true,
      // Generous default: 60 calls / 10s window keeps interactive agents fast
      // while stopping runaway loops. No daily quota by default.
      default: { maxCalls: 60, windowMs: 10_000 },
      overrides: {
        // Mutating/expensive actions get tighter limits.
        shell_exec: { maxCalls: 20, windowMs: 10_000, dailyQuota: 1000 },
        git_commit: { maxCalls: 10, windowMs: 60_000, dailyQuota: 200 },
        git_push: { maxCalls: 5, windowMs: 60_000, dailyQuota: 50 },
        file_delete: { maxCalls: 20, windowMs: 60_000, dailyQuota: 500 },
        db_write: { maxCalls: 20, windowMs: 60_000, dailyQuota: 500 },
      },
    },
    secretScan: {
      entropyEnabled: true,
      minEntropy: 4.0,
      minLength: 20,
    },
    adapters: {
      serena: { enabled: false, command: 'serena', args: [] },
      playwright: { enabled: false, command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
      desktopCommander: { enabled: false, command: 'npx', args: ['-y', '@wonderwhy-er/desktop-commander@latest'] },
    },
    lsp: {
      enabled: true,
      requestTimeoutMs: 15000,
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
    resolve(projectRoot, '.folderforge/config.yaml'),
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
  validateConfig(cfg);
  return cfg;
}

/**
 * Validate a loaded config and throw a single, human-readable error listing
 * every problem found. Catches the common foot-guns (bad enums, negative
 * limits, empty allowlists) early instead of failing deep inside a handler.
 */
export function validateConfig(cfg: FolderForgeConfig): void {
  const errors: string[] = [];
  const modes = ['readonly', 'safe', 'dev', 'danger'];
  if (!modes.includes(cfg.policy.defaultMode)) {
    errors.push(`policy.defaultMode must be one of ${modes.join(', ')} (got "${cfg.policy.defaultMode}")`);
  }
  if (!['stdio', 'http'].includes(cfg.server.transport)) {
    errors.push(`server.transport must be "stdio" or "http" (got "${cfg.server.transport}")`);
  }
  if (cfg.server.http.port <= 0 || cfg.server.http.port > 65535) {
    errors.push(`server.http.port must be 1-65535 (got ${cfg.server.http.port})`);
  }
  if (cfg.server.dashboard.port <= 0 || cfg.server.dashboard.port > 65535) {
    errors.push(`server.dashboard.port must be 1-65535 (got ${cfg.server.dashboard.port})`);
  }
  if (!cfg.workspace.allowedDirectories.length) {
    errors.push('workspace.allowedDirectories must list at least one directory');
  }
  if (cfg.terminal.maxOutputBytes <= 0) {
    errors.push(`terminal.maxOutputBytes must be > 0 (got ${cfg.terminal.maxOutputBytes})`);
  }
  if (cfg.terminal.defaultTimeoutMs <= 0) {
    errors.push(`terminal.defaultTimeoutMs must be > 0 (got ${cfg.terminal.defaultTimeoutMs})`);
  }
  if (!['redact', 'passthrough'].includes(cfg.terminal.envPolicy)) {
    errors.push(`terminal.envPolicy must be "redact" or "passthrough" (got "${cfg.terminal.envPolicy}")`);
  }
  if (cfg.rateLimit.enabled) {
    const rules: Array<[string, { maxCalls: number; windowMs: number; dailyQuota?: number }]> = [
      ['rateLimit.default', cfg.rateLimit.default],
      ...Object.entries(cfg.rateLimit.overrides).map(
        ([k, v]) => [`rateLimit.overrides.${k}`, v] as [string, typeof v]
      ),
    ];
    for (const [label, rule] of rules) {
      if (rule.maxCalls <= 0) errors.push(`${label}.maxCalls must be > 0 (got ${rule.maxCalls})`);
      if (rule.windowMs <= 0) errors.push(`${label}.windowMs must be > 0 (got ${rule.windowMs})`);
      if (rule.dailyQuota !== undefined && rule.dailyQuota <= 0) {
        errors.push(`${label}.dailyQuota must be > 0 when set (got ${rule.dailyQuota})`);
      }
    }
  }
  if (cfg.secretScan.entropyEnabled) {
    if (cfg.secretScan.minEntropy <= 0) {
      errors.push(`secretScan.minEntropy must be > 0 (got ${cfg.secretScan.minEntropy})`);
    }
    if (cfg.secretScan.minLength <= 0) {
      errors.push(`secretScan.minLength must be > 0 (got ${cfg.secretScan.minLength})`);
    }
  }
  if (cfg.lsp && cfg.lsp.enabled && cfg.lsp.requestTimeoutMs <= 0) {
    errors.push(`lsp.requestTimeoutMs must be > 0 (got ${cfg.lsp.requestTimeoutMs})`);
  }
  if (errors.length) {
    throw new Error(`Invalid FolderForge config:\n  - ${errors.join('\n  - ')}`);
  }
}
