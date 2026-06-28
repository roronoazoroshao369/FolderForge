#!/usr/bin/env node
import { loadConfig, ensureConfigFile } from './core/config.js';
import { Container } from './core/container.js';
import { buildRegistry, registerAdapterTools, resolveActiveTools } from './tools/index.js';
import { createMcpServer } from './server/mcp-server.js';
import { startStdioTransport } from './server/transports/stdio.js';
import { startHttpTransport } from './server/transports/http.js';
import { startDashboard, isLoopbackHost } from './dashboard/server.js';
import { logger } from './core/logger.js';
import { randomBytes } from 'node:crypto';
const VERSION = '1.4.0';
function parseArgs(argv) {
    const args = { stdio: false, http: false, dashboard: true };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        switch (a) {
            case '--project':
            case '-p': {
                const v = next();
                if (v !== undefined)
                    args.project = v;
                break;
            }
            case '--config':
            case '-c': {
                const v = next();
                if (v !== undefined)
                    args.config = v;
                break;
            }
            case '--stdio':
                args.stdio = true;
                break;
            case '--http':
                args.http = true;
                break;
            case '--port':
                args.port = Number(next());
                break;
            case '--host': {
                const v = next();
                if (v !== undefined)
                    args.host = v;
                break;
            }
            case '--dashboard-port':
                args.dashboardPort = Number(next());
                break;
            case '--no-dashboard':
                args.dashboard = false;
                break;
            case '--tools-preset': {
                const v = next();
                if (v !== undefined)
                    args.toolsPreset = v;
                break;
            }
            case '--tools-groups': {
                const v = next();
                if (v !== undefined)
                    args.toolsGroups = v.split(',').map((s) => s.trim()).filter(Boolean);
                break;
            }
            case '--tools-enable': {
                const v = next();
                if (v !== undefined)
                    args.toolsEnable = v.split(',').map((s) => s.trim()).filter(Boolean);
                break;
            }
            case '--tools-disable': {
                const v = next();
                if (v !== undefined)
                    args.toolsDisable = v.split(',').map((s) => s.trim()).filter(Boolean);
                break;
            }
            case '--token': {
                const v = next();
                if (v !== undefined)
                    args.token = v;
                break;
            }
            case '--api-key': {
                const v = next();
                if (v !== undefined) {
                    (args.apiKeys ??= []).push(...v.split(',').map((s) => s.trim()).filter(Boolean));
                }
                break;
            }
            case '--require-auth':
                args.requireAuth = true;
                break;
            case '--version':
            case '-v':
                process.stdout.write(`folderforge ${VERSION}\n`);
                process.exit(0);
                break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
                break;
            default:
                if (a && a.startsWith('-')) {
                    logger.warn({ arg: a }, 'Unknown argument ignored');
                }
        }
    }
    return args;
}
function printHelp() {
    process.stdout.write([
        'FolderForge - local development control plane for AI coding agents',
        '',
        'Usage: folderforge [options]',
        '',
        'Options:',
        '  -p, --project <dir>      Project root to activate (default: cwd)',
        '  -c, --config <file>      Path to a YAML config file',
        '      --stdio              Serve MCP over stdio (default for agent clients)',
        '      --http               Serve MCP over Streamable HTTP',
        '      --port <n>           HTTP MCP port (default 7331)',
        '      --host <addr>        Bind address (default 127.0.0.1)',
        '      --dashboard-port <n> Dashboard port (default 7332)',
        '      --no-dashboard       Disable the local dashboard',
        '      --token <secret>     Bearer/API token required on the HTTP MCP endpoint',
        '      --api-key <csv>      Additional accepted API keys (repeatable / comma-separated)',
        '      --require-auth       Enforce auth even on a loopback (localhost) bind',
        '      --tools-preset <id>  Limit advertised tools to a preset (vibe|vibe-lite|readonly|full)',
        '      --tools-groups <csv> Limit advertised tools to these groups (e.g. file,search,git)',
        '      --tools-enable <csv> Always-keep tool names (added back on top of the filter)',
        '      --tools-disable <csv> Drop these tool names from the advertised list',
        '  -v, --version            Print version and exit',
        '  -h, --help               Show this help',
        '',
    ].join('\n'));
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    // First-run convenience: if the user did not point at an explicit --config and
    // the project has no config file yet, write a full batteries-included config
    // (vibe-lite + Playwright enabled) so browser/UI tools work out of the box.
    // Never overwrites an existing file; failures are non-fatal.
    if (args.config === undefined) {
        ensureConfigFile(args.project ?? process.cwd());
    }
    const config = loadConfig({
        ...(args.config !== undefined ? { configPath: args.config } : {}),
        ...(args.project !== undefined ? { projectRoot: args.project } : {}),
    });
    // CLI overrides for transport/ports.
    if (args.http)
        config.server.transport = 'http';
    if (args.stdio)
        config.server.transport = 'stdio';
    if (args.host !== undefined)
        config.server.http.host = args.host;
    if (args.port !== undefined)
        config.server.http.port = args.port;
    if (args.dashboardPort !== undefined)
        config.server.dashboard.port = args.dashboardPort;
    // CLI auth overrides for the HTTP transport.
    if (args.token !== undefined)
        config.server.http.token = args.token;
    if (args.apiKeys && args.apiKeys.length > 0) {
        config.server.http.apiKeys = [...(config.server.http.apiKeys ?? []), ...args.apiKeys];
    }
    if (args.requireAuth)
        config.server.http.requireAuth = true;
    const container = new Container(config);
    const registry = buildRegistry(container);
    // Trim the advertised tool surface (config + CLI). Clients that cap the tool
    // list (e.g. ~50 tools) can run a focused preset like "vibe". CLI flags win
    // over the config file. Applied before the first tools/list.
    const cfgTools = config.tools;
    const active = resolveActiveTools(registry, {
        preset: args.toolsPreset ?? cfgTools?.preset,
        enabledGroups: args.toolsGroups ?? cfgTools?.enabledGroups,
        enabled: args.toolsEnable ?? cfgTools?.enabled,
        disabled: args.toolsDisable ?? cfgTools?.disabled,
    });
    if (active) {
        registry.setActive(active);
        logger.info({ advertised: active.length, total: registry.listAll().length }, 'Tool surface filtered');
    }
    // Wire enabled child MCP adapters (Serena, Playwright, ...). Each child tool is
    // exposed namespaced (e.g. serena__find_symbol). Discovery never blocks startup.
    try {
        const added = await registerAdapterTools(container, registry);
        if (added > 0)
            logger.info({ added }, 'Registered child MCP adapter tools');
    }
    catch (err) {
        logger.warn({ err: String(err) }, 'Adapter tool registration failed; continuing without adapters');
    }
    const makeServer = () => createMcpServer(registry, {
        name: config.server.name,
        version: VERSION,
        roots: config.workspace.allowedDirectories,
    });
    // A primary server instance for stdio + lifecycle (shutdown). The HTTP
    // transport mints its own per-request server via `makeServer` (a shared
    // server can only connect to one transport at a time).
    const server = makeServer();
    container.audit.record({
        type: 'server_start',
        summary: `transport=${config.server.transport} tools=${registry.listAll().length}`,
        detail: { version: VERSION, projectRoot: container.projectRoot() },
    });
    // Dashboard is independent of the MCP transport (and is safe to run alongside stdio).
    if (args.dashboard) {
        const dashHost = config.server.dashboard.host;
        // A non-loopback bind exposes the control plane to the network, so it must be
        // token-protected. Use the configured token or mint one and log it once.
        let token = config.server.dashboard.token;
        if (!isLoopbackHost(dashHost) && !token) {
            token = randomBytes(24).toString('base64url');
            logger.warn({ host: dashHost, token }, 'Dashboard bound to a non-loopback host; generated an auth token (set server.dashboard.token to pin it)');
        }
        startDashboard(container, registry, {
            host: dashHost,
            port: config.server.dashboard.port,
            ...(token ? { token } : {}),
        });
    }
    if (config.server.transport === 'http') {
        const httpHost = config.server.http.host;
        const forceAuth = Boolean(config.server.http.requireAuth);
        // A non-loopback bind (or requireAuth) must be credential-protected. Use a
        // configured credential or mint a token and log it once.
        let httpToken = config.server.http.token;
        const hasCredential = Boolean(httpToken) || (config.server.http.apiKeys?.length ?? 0) > 0;
        if ((!isLoopbackHost(httpHost) || forceAuth) && !hasCredential) {
            httpToken = randomBytes(24).toString('base64url');
            logger.warn({ host: httpHost, token: httpToken, requireAuth: forceAuth }, 'HTTP transport requires auth but no credential was set; generated one (set server.http.token to pin it)');
        }
        await startHttpTransport(makeServer, {
            host: httpHost,
            port: config.server.http.port,
            ...(httpToken ? { token: httpToken } : {}),
            ...(config.server.http.apiKeys ? { apiKeys: config.server.http.apiKeys } : {}),
            ...(forceAuth ? { requireAuth: true } : {}),
            ...(config.server.http.corsOrigins ? { corsOrigins: config.server.http.corsOrigins } : {}),
            ...(config.server.http.sessionTtlMs !== undefined
                ? { sessionTtlMs: config.server.http.sessionTtlMs }
                : {}),
        });
    }
    else {
        await startStdioTransport(server);
    }
    const shutdown = async (signal) => {
        logger.info({ signal }, 'Shutting down FolderForge');
        try {
            container.adapters.stopAll();
        }
        catch {
            // ignore
        }
        try {
            await server.close();
        }
        catch {
            // ignore
        }
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
main().catch((err) => {
    logger.error({ err: err instanceof Error ? err.stack : String(err) }, 'Fatal startup error');
    process.exit(1);
});
