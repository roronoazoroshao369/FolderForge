import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, isAbsolute, dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { logger } from './logger.js';
import { defaultShell } from './shell.js';
import { packageLocalPlaywrightDef } from '../adapters/child-mcp/resolve.js';
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
export const DEFAULT_OAUTH_READ_SCOPE = 'folderforge:read';
export const DEFAULT_OAUTH_WRITE_SCOPE = 'folderforge:write';
export const DEFAULT_OAUTH_ALGORITHMS = ['RS256', 'PS256', 'ES256', 'EdDSA'];
function csv(value) {
    if (value === undefined)
        return undefined;
    return value.split(',').map((item) => item.trim()).filter(Boolean);
}
function envBoolean(value) {
    if (value === undefined)
        return undefined;
    if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase()))
        return true;
    if (['0', 'false', 'no', 'off'].includes(value.toLowerCase()))
        return false;
    throw new Error(`Invalid boolean environment value: ${value}`);
}
function applyEnvironmentOverrides(cfg) {
    const mode = process.env.FOLDERFORGE_HTTP_AUTH;
    const resource = process.env.FOLDERFORGE_OAUTH_RESOURCE;
    const issuer = process.env.FOLDERFORGE_OAUTH_ISSUER;
    const scopes = csv(process.env.FOLDERFORGE_OAUTH_SCOPES);
    const oauthRequested = Boolean(resource || issuer || scopes || mode === 'oauth');
    if (mode) {
        cfg.server.http.auth = { mode: mode };
    }
    if (process.env.FOLDERFORGE_HTTP_TOKEN !== undefined) {
        cfg.server.http.token = process.env.FOLDERFORGE_HTTP_TOKEN;
    }
    const apiKeys = csv(process.env.FOLDERFORGE_HTTP_API_KEYS);
    if (apiKeys)
        cfg.server.http.apiKeys = apiKeys;
    if (oauthRequested) {
        const existing = cfg.server.http.auth?.oauth;
        cfg.server.http.auth = {
            mode: cfg.server.http.auth?.mode ?? 'oauth',
            oauth: {
                ...(existing ?? {}),
                ...(resource !== undefined ? { resource } : {}),
                ...(issuer !== undefined ? { issuer } : {}),
                ...(scopes !== undefined ? { scopes } : {}),
                ...(process.env.FOLDERFORGE_OAUTH_READ_SCOPE !== undefined
                    ? { readScope: process.env.FOLDERFORGE_OAUTH_READ_SCOPE }
                    : {}),
                ...(process.env.FOLDERFORGE_OAUTH_WRITE_SCOPE !== undefined
                    ? { writeScope: process.env.FOLDERFORGE_OAUTH_WRITE_SCOPE }
                    : {}),
                ...(process.env.FOLDERFORGE_OAUTH_CLIENT_REGISTRATION !== undefined
                    ? { clientRegistration: process.env.FOLDERFORGE_OAUTH_CLIENT_REGISTRATION }
                    : {}),
                ...(process.env.FOLDERFORGE_OAUTH_JWKS_URI !== undefined
                    ? { jwksUri: process.env.FOLDERFORGE_OAUTH_JWKS_URI }
                    : {}),
                ...(csv(process.env.FOLDERFORGE_OAUTH_TRUSTED_JWKS_HOSTS) !== undefined
                    ? { trustedJwksHosts: csv(process.env.FOLDERFORGE_OAUTH_TRUSTED_JWKS_HOSTS) }
                    : {}),
                ...(csv(process.env.FOLDERFORGE_OAUTH_ALGORITHMS) !== undefined
                    ? { algorithms: csv(process.env.FOLDERFORGE_OAUTH_ALGORITHMS) }
                    : {}),
                ...(envBoolean(process.env.FOLDERFORGE_OAUTH_ALLOW_INSECURE_HTTP) !== undefined
                    ? { allowInsecureHttpForDevelopment: envBoolean(process.env.FOLDERFORGE_OAUTH_ALLOW_INSECURE_HTTP) }
                    : {}),
            },
        };
    }
}
export function applyHttpAuthDefaults(cfg) {
    const auth = cfg.server.http.auth;
    if (!auth || auth.mode !== 'oauth')
        return;
    const oauth = (auth.oauth ?? {});
    const readScope = oauth.readScope || DEFAULT_OAUTH_READ_SCOPE;
    const writeScope = oauth.writeScope || DEFAULT_OAUTH_WRITE_SCOPE;
    auth.oauth = {
        resource: oauth.resource ?? '',
        issuer: oauth.issuer ?? '',
        scopes: oauth.scopes?.length ? [...oauth.scopes] : [readScope, writeScope],
        readScope,
        writeScope,
        clientRegistration: oauth.clientRegistration ?? 'cimd',
        algorithms: oauth.algorithms?.length ? [...oauth.algorithms] : [...DEFAULT_OAUTH_ALGORITHMS],
        clockToleranceSeconds: oauth.clockToleranceSeconds ?? 5,
        requestTimeoutMs: oauth.requestTimeoutMs ?? 5_000,
        jwksCacheTtlMs: oauth.jwksCacheTtlMs ?? 10 * 60_000,
        jwksCooldownMs: oauth.jwksCooldownMs ?? 30_000,
        ...(oauth.jwksUri ? { jwksUri: oauth.jwksUri } : {}),
        ...(oauth.trustedJwksHosts ? { trustedJwksHosts: [...oauth.trustedJwksHosts] } : {}),
        ...(oauth.allowInsecureHttpForDevelopment !== undefined
            ? { allowInsecureHttpForDevelopment: oauth.allowInsecureHttpForDevelopment }
            : {}),
        ...(oauth.resourceDocumentation ? { resourceDocumentation: oauth.resourceDocumentation } : {}),
    };
}
function isLoopbackUrl(url) {
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]';
}
function validateOAuthUrl(label, raw, allowInsecure, errors, options = {}) {
    try {
        const url = new URL(raw);
        if (url.username || url.password)
            errors.push(`${label} must not contain userinfo`);
        if (url.hash)
            errors.push(`${label} must not contain a fragment`);
        if (options.disallowQuery && url.search)
            errors.push(`${label} must not contain a query string`);
        if (url.protocol !== 'https:') {
            if (!(allowInsecure && url.protocol === 'http:' && isLoopbackUrl(url))) {
                errors.push(`${label} must use HTTPS (loopback HTTP requires allowInsecureHttpForDevelopment=true)`);
            }
        }
        return url;
    }
    catch {
        errors.push(`${label} must be an absolute URL (got "${raw}")`);
        return undefined;
    }
}
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
            approvalTtlMs: 15 * 60 * 1000,
            allowCriticalInDanger: false,
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
            shell: defaultShell(),
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
            playwright: packageLocalPlaywrightDef(false),
            desktopCommander: { enabled: false, command: 'npx', args: ['-y', '@wonderwhy-er/desktop-commander@latest'] },
            godot: { enabled: false, godotPath: 'godot', editorPort: 6550, runtimePort: 9090 },
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
            playwright: packageLocalPlaywrightDef(true),
            desktopCommander: {
                enabled: false,
                command: 'npx',
                args: ['-y', '@wonderwhy-er/desktop-commander@latest'],
            },
            godot: { enabled: false, godotPath: 'godot', editorPort: 6550, runtimePort: 9090 },
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
    const target = resolve(root, '.folderforge/config.yaml');
    try {
        mkdirSync(dirname(target), { recursive: true });
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
    applyEnvironmentOverrides(cfg);
    applyHttpAuthDefaults(cfg);
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
    if (cfg.policy.approvalTtlMs <= 0) {
        errors.push(`policy.approvalTtlMs must be > 0 (got ${cfg.policy.approvalTtlMs})`);
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
    const httpAuth = cfg.server.http.auth;
    if (httpAuth) {
        if (!['none', 'token', 'oauth'].includes(httpAuth.mode)) {
            errors.push(`server.http.auth.mode must be "none", "token", or "oauth" (got "${httpAuth.mode}")`);
        }
        const hasStaticCredential = Boolean(cfg.server.http.token) || (cfg.server.http.apiKeys?.length ?? 0) > 0;
        if (httpAuth.mode === 'none') {
            if (hasStaticCredential)
                errors.push('server.http.auth.mode=none conflicts with server.http.token/apiKeys');
            if (cfg.server.http.requireAuth)
                errors.push('server.http.auth.mode=none conflicts with server.http.requireAuth');
            if (httpAuth.oauth)
                errors.push('server.http.auth.mode=none conflicts with server.http.auth.oauth');
            if (!['127.0.0.1', '::1', 'localhost'].includes(cfg.server.http.host)) {
                errors.push('server.http.auth.mode=none is only allowed on a loopback host');
            }
        }
        if (httpAuth.mode === 'token' && httpAuth.oauth) {
            errors.push('server.http.auth.mode=token conflicts with server.http.auth.oauth');
        }
        if (httpAuth.mode === 'oauth') {
            if (cfg.server.transport !== 'http')
                errors.push('server.http.auth.mode=oauth requires server.transport=http');
            if (hasStaticCredential)
                errors.push('OAuth mode cannot be combined with server.http.token/apiKeys');
            if (cfg.server.http.requireAuth)
                errors.push('OAuth mode cannot be combined with server.http.requireAuth');
            const oauth = httpAuth.oauth;
            if (!oauth) {
                errors.push('server.http.auth.oauth is required when mode=oauth');
            }
            else {
                const allowInsecure = Boolean(oauth.allowInsecureHttpForDevelopment);
                const resource = validateOAuthUrl('server.http.auth.oauth.resource', oauth.resource, allowInsecure, errors, { disallowQuery: true });
                const issuer = validateOAuthUrl('server.http.auth.oauth.issuer', oauth.issuer, allowInsecure, errors, { disallowQuery: true });
                if (allowInsecure && resource && issuer && (!isLoopbackUrl(resource) || !isLoopbackUrl(issuer))) {
                    errors.push('allowInsecureHttpForDevelopment only permits loopback issuer and resource URLs');
                }
                if (oauth.jwksUri)
                    validateOAuthUrl('server.http.auth.oauth.jwksUri', oauth.jwksUri, allowInsecure, errors);
                for (const trustedHost of oauth.trustedJwksHosts ?? []) {
                    if (!trustedHost ||
                        trustedHost.includes('://') ||
                        trustedHost.includes('/') ||
                        trustedHost.includes('@') ||
                        /\s/.test(trustedHost)) {
                        errors.push(`server.http.auth.oauth.trustedJwksHosts entries must be exact host[:port] values (got "${trustedHost}")`);
                    }
                }
                if (oauth.resourceDocumentation) {
                    validateOAuthUrl('server.http.auth.oauth.resourceDocumentation', oauth.resourceDocumentation, allowInsecure, errors);
                }
                if (!['cimd', 'dcr', 'predefined'].includes(oauth.clientRegistration)) {
                    errors.push('server.http.auth.oauth.clientRegistration must be cimd, dcr, or predefined');
                }
                if (!oauth.scopes.length)
                    errors.push('server.http.auth.oauth.scopes must not be empty');
                const scopeToken = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
                for (const scope of oauth.scopes) {
                    if (!scopeToken.test(scope))
                        errors.push(`Invalid OAuth scope token: "${scope}"`);
                }
                if (!oauth.scopes.includes(oauth.readScope))
                    errors.push('OAuth scopes must include readScope');
                if (!oauth.scopes.includes(oauth.writeScope))
                    errors.push('OAuth scopes must include writeScope');
                const algorithms = oauth.algorithms ?? [];
                if (!algorithms.length)
                    errors.push('server.http.auth.oauth.algorithms must not be empty');
                for (const alg of algorithms) {
                    if (alg === 'none' || alg.startsWith('HS'))
                        errors.push(`OAuth JWT algorithm is not allowed: ${alg}`);
                }
                for (const [label, value] of [
                    ['clockToleranceSeconds', oauth.clockToleranceSeconds],
                    ['requestTimeoutMs', oauth.requestTimeoutMs],
                    ['jwksCacheTtlMs', oauth.jwksCacheTtlMs],
                    ['jwksCooldownMs', oauth.jwksCooldownMs],
                ]) {
                    if (value !== undefined && value < 0)
                        errors.push(`server.http.auth.oauth.${label} must be >= 0`);
                }
            }
        }
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
