import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
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
export function defaultConfig(projectRoot) {
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
function deepMerge(base, override) {
    if (override === undefined || override === null)
        return base;
    if (Array.isArray(base) || Array.isArray(override)) {
        return (override ?? base);
    }
    if (typeof base === 'object' && typeof override === 'object') {
        const out = { ...base };
        for (const [k, v] of Object.entries(override)) {
            const bv = base[k];
            if (v && typeof v === 'object' && !Array.isArray(v) && bv && typeof bv === 'object') {
                out[k] = deepMerge(bv, v);
            }
            else if (v !== undefined) {
                out[k] = v;
            }
        }
        return out;
    }
    return (override ?? base);
}
/**
 * Build a fully-populated, "batteries-included" config intended to be written
 * to disk on first run. Unlike defaultConfig (conservative, safe mode, adapters
 * off), this turns on the things most users want for AI vibe-coding + UI tests:
 *   - policy mode `dev`
 *   - tools preset `vibe-lite` (folder-scoped coding set + browser group)
 *   - Playwright adapter enabled (so browser_* tools actually run)
 * The projectRoot is written as "." so the file stays portable/relocatable.
 */
export function fullConfig() {
    const base = defaultConfig('.');
    return {
        ...base,
        server: {
            name: 'folderforge',
            transport: 'http',
            http: { host: '127.0.0.1', port: 7331, sessionTtlMs: 1_800_000 },
            dashboard: { host: '127.0.0.1', port: 7332 },
        },
        workspace: {
            defaultProject: '.',
            allowedDirectories: ['.'],
            deniedGlobs: [...DEFAULT_DENIED_GLOBS],
        },
        policy: {
            ...base.policy,
            defaultMode: 'dev',
        },
        tools: { preset: 'vibe-lite' },
        adapters: {
            serena: { enabled: false, command: 'serena', args: [] },
            playwright: { enabled: true, command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
            desktopCommander: {
                enabled: false,
                command: 'npx',
                args: ['-y', '@wonderwhy-er/desktop-commander@latest'],
            },
        },
    };
}
/**
 * Write a full, batteries-included config to `folderforge.yaml` in projectRoot
 * if (and only if) no config file already exists in any of the discovery
 * locations. Returns the absolute path written, or null when a config was
 * already present (nothing is overwritten). Failures are logged, never thrown -
 * a missing-config write must never block startup.
 */
export function ensureConfigFile(projectRoot) {
    const root = resolve(projectRoot);
    const discovery = [
        process.env.FOLDERFORGE_CONFIG,
        resolve(root, 'folderforge.yaml'),
        resolve(root, '.folderforge.yaml'),
        resolve(root, '.folderforge/config.yaml'),
    ].filter((p) => Boolean(p));
    for (const p of discovery) {
        const abs = isAbsolute(p) ? p : resolve(root, p);
        if (existsSync(abs))
            return null; // already configured; never overwrite
    }
    const target = resolve(root, 'folderforge.yaml');
    try {
        const header = '# FolderForge - auto-generated full config (first run).\n' +
            '# Edit freely; this file is only created when no config exists.\n' +
            '# Playwright is enabled so browser_* tools work for FE/UI testing.\n\n';
        writeFileSync(target, header + stringifyYaml(fullConfig()), 'utf8');
        logger.info({ configPath: target }, 'No config found; wrote a full default config');
        return target;
    }
    catch (err) {
        logger.warn({ configPath: target, err: String(err) }, 'Could not write default config; using built-in defaults');
        return null;
    }
}
export function loadConfig(opts = {}) {
    const projectRoot = resolve(opts.projectRoot ?? process.cwd());
    let cfg = defaultConfig(projectRoot);
    const candidatePaths = [
        opts.configPath,
        process.env.FOLDERFORGE_CONFIG,
        resolve(projectRoot, 'folderforge.yaml'),
        resolve(projectRoot, '.folderforge.yaml'),
        resolve(projectRoot, '.folderforge/config.yaml'),
    ].filter((p) => Boolean(p));
    for (const p of candidatePaths) {
        const abs = isAbsolute(p) ? p : resolve(projectRoot, p);
        if (existsSync(abs)) {
            try {
                const raw = readFileSync(abs, 'utf8');
                const parsed = parseYaml(raw);
                cfg = deepMerge(cfg, parsed);
                logger.info({ configPath: abs }, 'Loaded config file');
            }
            catch (err) {
                logger.warn({ configPath: abs, err: String(err) }, 'Failed to parse config; using defaults');
            }
            break;
        }
    }
    // Normalize allowed dirs to absolute.
    cfg.workspace.allowedDirectories = cfg.workspace.allowedDirectories.map((d) => isAbsolute(d) ? resolve(d) : resolve(projectRoot, d));
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
export function validateConfig(cfg) {
    const errors = [];
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
        const rules = [
            ['rateLimit.default', cfg.rateLimit.default],
            ...Object.entries(cfg.rateLimit.overrides).map(([k, v]) => [`rateLimit.overrides.${k}`, v]),
        ];
        for (const [label, rule] of rules) {
            if (rule.maxCalls <= 0)
                errors.push(`${label}.maxCalls must be > 0 (got ${rule.maxCalls})`);
            if (rule.windowMs <= 0)
                errors.push(`${label}.windowMs must be > 0 (got ${rule.windowMs})`);
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
