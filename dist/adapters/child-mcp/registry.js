import { StdioChildClient, ChildMcpError, redactChildArgs } from './client.js';
import { resolveAdapterLaunch } from './resolve.js';
import { logger } from '../../core/logger.js';
import { SecretPolicy } from '../../policy/secret-policy.js';
const secretPolicy = new SecretPolicy();
function isAdapterDef(value) {
    return Boolean(value &&
        typeof value === 'object' &&
        typeof value.enabled === 'boolean' &&
        typeof value.command === 'string' &&
        Array.isArray(value.args));
}
function resolutionDiagnostic(name, def, error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
        adapter: name,
        command: def.command,
        args: redactChildArgs(def.args),
        cwd: def.cwd ?? process.cwd(),
        phase: 'resolve',
        kind: /cannot find|could not resolve|missing/i.test(message)
            ? 'npm_package_resolution_failure'
            : 'unknown',
        exitCode: null,
        signal: null,
        spawnError: secretPolicy.redact(message),
        stderrTail: '',
        timedOut: false,
        remediation: name === 'playwright'
            ? 'Reinstall FolderForge so @playwright/mcp is present in the package dependency tree, then run `folderforge doctor`.'
            : 'Review the adapter command and installed package files, then run `folderforge doctor`.',
        occurredAt: new Date().toISOString(),
    };
}
/** Lazily spawns and manages built-in and installed child MCP servers. */
export class ChildMcpRegistry {
    entries = new Map();
    constructor(config, extras = []) {
        for (const [name, def] of Object.entries(config)) {
            if (isAdapterDef(def))
                this.upsert(name, def);
        }
        for (const extra of extras)
            this.upsert(extra.name, extra.def);
    }
    names() {
        return [...this.entries.keys()].sort();
    }
    upsert(name, def) {
        const existing = this.entries.get(name);
        existing?.client?.stop();
        this.entries.set(name, {
            name,
            def: { ...def, args: [...def.args], ...(def.env ? { env: { ...def.env } } : {}) },
            client: null,
            lazyStarted: false,
            catalog: null,
            launch: null,
            diagnostic: null,
        });
    }
    remove(name) {
        this.entries.get(name)?.client?.stop();
        this.entries.delete(name);
    }
    isEnabled(name) {
        return this.entries.get(name)?.def.enabled ?? false;
    }
    isFacade(name) {
        return this.entries.get(name)?.def.facade ?? false;
    }
    async ensure(name) {
        const entry = this.entries.get(name);
        if (!entry)
            throw new Error(`Adapter not configured: ${name}`);
        if (!entry.def.enabled)
            throw new Error(`Adapter disabled: ${name}`);
        if (!entry.client) {
            try {
                entry.launch = resolveAdapterLaunch(name, entry.def);
            }
            catch (error) {
                entry.diagnostic = resolutionDiagnostic(name, entry.def, error);
                logger.warn({ diagnostic: entry.diagnostic }, 'child MCP adapter resolution failed');
                throw new ChildMcpError(`${name} adapter failed during resolve: ${String(error)}`, entry.diagnostic);
            }
            const launch = entry.launch;
            entry.client = new StdioChildClient({
                adapter: name,
                command: launch.command,
                args: launch.args,
                env: entry.def.env ?? {},
                ...(launch.cwd ? { cwd: launch.cwd } : {}),
                inheritEnv: entry.def.inheritEnv !== false,
                onDiagnostic: (diagnostic) => {
                    entry.diagnostic = diagnostic;
                    entry.catalog = null;
                },
            });
        }
        if (!entry.client.isReady()) {
            logger.info({
                adapter: name,
                command: entry.launch?.command,
                args: redactChildArgs(entry.launch?.args ?? []),
                source: entry.launch?.source,
            }, 'Starting child MCP adapter');
            try {
                await entry.client.start();
                entry.lazyStarted = true;
                entry.diagnostic = null;
            }
            catch (error) {
                entry.diagnostic = entry.client.diagnostic() ?? entry.diagnostic;
                throw error;
            }
        }
        return entry.client;
    }
    async catalog(name, refresh = false) {
        const entry = this.entries.get(name);
        if (!entry)
            throw new Error(`Adapter not configured: ${name}`);
        if (!refresh && entry.catalog)
            return entry.catalog;
        const client = await this.ensure(name);
        try {
            const tools = await client.listTools();
            entry.catalog = tools.map((tool) => ({
                name: tool.name,
                ...(tool.description !== undefined ? { description: tool.description } : {}),
                ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
            }));
            entry.diagnostic = null;
            return entry.catalog;
        }
        catch (error) {
            entry.diagnostic = client.diagnostic() ?? entry.diagnostic;
            throw error;
        }
    }
    async health(name) {
        const entry = this.entries.get(name);
        if (!entry || !entry.def.enabled)
            return { enabled: false, ready: false };
        try {
            const tools = await this.catalog(name, true);
            return { enabled: true, ready: true, tools: tools.length };
        }
        catch (error) {
            return {
                enabled: true,
                ready: false,
                error: error instanceof Error ? error.message : String(error),
                ...(entry.diagnostic ? { diagnostic: { ...entry.diagnostic, args: [...entry.diagnostic.args] } } : {}),
            };
        }
    }
    status() {
        return [...this.entries.values()].map((entry) => {
            const ready = entry.client?.isReady() ?? false;
            return {
                name: entry.name,
                enabled: entry.def.enabled,
                started: entry.lazyStarted,
                ready,
                facade: entry.def.facade ?? false,
                ...(entry.launch
                    ? {
                        launch: {
                            command: entry.launch.command,
                            args: redactChildArgs(entry.launch.args),
                            ...(entry.launch.cwd ? { cwd: entry.launch.cwd } : {}),
                            source: entry.launch.source,
                            ...(entry.launch.packageName ? { packageName: entry.launch.packageName } : {}),
                            ...(entry.launch.packageVersion ? { packageVersion: entry.launch.packageVersion } : {}),
                        },
                    }
                    : {}),
                ...(entry.diagnostic
                    ? { diagnostic: { ...entry.diagnostic, args: [...entry.diagnostic.args] } }
                    : {}),
            };
        });
    }
    stopAll() {
        for (const entry of this.entries.values())
            entry.client?.stop();
    }
}
