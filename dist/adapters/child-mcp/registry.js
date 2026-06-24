import { StdioChildClient } from './client.js';
import { logger } from '../../core/logger.js';
/**
 * Lazily spawns and manages child MCP servers (Serena, Playwright, etc.).
 * Adapters only start on first use to avoid paying their cost upfront.
 */
export class ChildMcpRegistry {
    entries = new Map();
    constructor(config) {
        const map = [
            ['serena', config.serena],
            ['playwright', config.playwright],
            ['desktopCommander', config.desktopCommander],
        ];
        for (const [name, def] of map) {
            if (def) {
                this.entries.set(name, { name, def, client: null, lazyStarted: false });
            }
        }
    }
    isEnabled(name) {
        return this.entries.get(name)?.def.enabled ?? false;
    }
    async ensure(name) {
        const entry = this.entries.get(name);
        if (!entry)
            throw new Error(`Adapter not configured: ${name}`);
        if (!entry.def.enabled)
            throw new Error(`Adapter disabled: ${name}`);
        if (!entry.client) {
            entry.client = new StdioChildClient(entry.def.command, entry.def.args, entry.def.env ?? {});
        }
        if (!entry.client.isReady()) {
            logger.info({ adapter: name }, 'Starting child MCP adapter');
            await entry.client.start();
            entry.lazyStarted = true;
        }
        return entry.client;
    }
    async health(name) {
        const entry = this.entries.get(name);
        if (!entry)
            return { enabled: false, ready: false };
        if (!entry.def.enabled)
            return { enabled: false, ready: false };
        try {
            const client = await this.ensure(name);
            await client.listTools();
            return { enabled: true, ready: true };
        }
        catch (err) {
            return { enabled: true, ready: false, error: String(err) };
        }
    }
    status() {
        return [...this.entries.values()].map((e) => ({
            name: e.name,
            enabled: e.def.enabled,
            started: e.lazyStarted && (e.client?.isReady() ?? false),
        }));
    }
    stopAll() {
        for (const e of this.entries.values())
            e.client?.stop();
    }
}
