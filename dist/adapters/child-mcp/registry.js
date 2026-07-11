import { StdioChildClient } from './client.js';
import { logger } from '../../core/logger.js';
function isAdapterDef(value) {
    return Boolean(value &&
        typeof value === 'object' &&
        typeof value.enabled === 'boolean' &&
        typeof value.command === 'string' &&
        Array.isArray(value.args));
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
            entry.client = new StdioChildClient(entry.def.command, entry.def.args, entry.def.env ?? {}, entry.def.cwd, entry.def.inheritEnv !== false);
        }
        if (!entry.client.isReady()) {
            logger.info({ adapter: name }, 'Starting child MCP adapter');
            await entry.client.start();
            entry.lazyStarted = true;
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
        const tools = await client.listTools();
        entry.catalog = tools.map((tool) => ({
            name: tool.name,
            ...(tool.description !== undefined ? { description: tool.description } : {}),
            ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
        }));
        return entry.catalog;
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
            return { enabled: true, ready: false, error: String(error) };
        }
    }
    status() {
        return [...this.entries.values()].map((entry) => ({
            name: entry.name,
            enabled: entry.def.enabled,
            started: entry.lazyStarted && (entry.client?.isReady() ?? false),
            facade: entry.def.facade ?? false,
        }));
    }
    stopAll() {
        for (const entry of this.entries.values())
            entry.client?.stop();
    }
}
