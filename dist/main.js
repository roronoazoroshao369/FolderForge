#!/usr/bin/env node
import { loadConfig } from './core/config.js';
import { Container } from './core/container.js';
import { buildRegistry } from './tools/index.js';
import { createMcpServer } from './server/mcp-server.js';
import { startStdioTransport } from './server/transports/stdio.js';
import { startHttpTransport } from './server/transports/http.js';
import { startDashboard } from './dashboard/server.js';
import { logger } from './core/logger.js';
const VERSION = '0.1.0';
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
        'FolderForge (VibeMCP) - local development control plane for AI coding agents',
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
        '  -v, --version            Print version and exit',
        '  -h, --help               Show this help',
        '',
    ].join('\n'));
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
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
    const container = new Container(config);
    const registry = buildRegistry(container);
    const server = createMcpServer(registry, { name: config.server.name, version: VERSION });
    container.audit.record({
        type: 'server_start',
        summary: `transport=${config.server.transport} tools=${registry.listAll().length}`,
        detail: { version: VERSION, projectRoot: container.projectRoot() },
    });
    // Dashboard is independent of the MCP transport (and is safe to run alongside stdio).
    if (args.dashboard) {
        startDashboard(container, registry, {
            host: config.server.dashboard.host,
            port: config.server.dashboard.port,
        });
    }
    if (config.server.transport === 'http') {
        await startHttpTransport(server, {
            host: config.server.http.host,
            port: config.server.http.port,
        });
    }
    else {
        await startStdioTransport(server);
    }
    const shutdown = async (signal) => {
        logger.info({ signal }, 'Shutting down FolderForge');
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
