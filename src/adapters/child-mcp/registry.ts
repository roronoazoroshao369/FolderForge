import { StdioChildClient } from './client.js';
import type { AdaptersConfig, AdapterDef } from '../../core/types.js';
import { logger } from '../../core/logger.js';

export type AdapterName = 'serena' | 'playwright' | 'desktopCommander';

/** A discovered child sub-tool descriptor, cached for facade adapters. */
export interface SubToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface AdapterEntry {
  name: AdapterName;
  def: AdapterDef;
  client: StdioChildClient | null;
  lazyStarted: boolean;
  /** Cached sub-tool catalog (facade adapters). Null until first discovery. */
  catalog: SubToolDescriptor[] | null;
}

/**
 * Lazily spawns and manages child MCP servers (Serena, Playwright, etc.).
 * Adapters only start on first use to avoid paying their cost upfront.
 */
export class ChildMcpRegistry {
  private entries = new Map<AdapterName, AdapterEntry>();

  constructor(config: AdaptersConfig) {
    const map: Array<[AdapterName, AdapterDef | undefined]> = [
      ['serena', config.serena],
      ['playwright', config.playwright],
      ['desktopCommander', config.desktopCommander],
    ];
    for (const [name, def] of map) {
      if (def) {
        this.entries.set(name, { name, def, client: null, lazyStarted: false, catalog: null });
      }
    }
  }

  isEnabled(name: AdapterName): boolean {
    return this.entries.get(name)?.def.enabled ?? false;
  }

  /** True when the adapter is configured to run behind the two-tool facade. */
  isFacade(name: AdapterName): boolean {
    return this.entries.get(name)?.def.facade ?? false;
  }

  async ensure(name: AdapterName): Promise<StdioChildClient> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Adapter not configured: ${name}`);
    if (!entry.def.enabled) throw new Error(`Adapter disabled: ${name}`);
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

  /**
   * Return the discovered sub-tool catalog for a facade adapter, spawning the
   * child and running `tools/list` on first call. The result is cached; pass
   * `refresh: true` to re-discover (e.g. after the child's tools change).
   */
  async catalog(name: AdapterName, refresh = false): Promise<SubToolDescriptor[]> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Adapter not configured: ${name}`);
    if (!refresh && entry.catalog) return entry.catalog;
    const client = await this.ensure(name);
    const tools = await client.listTools();
    entry.catalog = tools.map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
    }));
    return entry.catalog;
  }

  async health(name: AdapterName): Promise<{ enabled: boolean; ready: boolean; error?: string }> {
    const entry = this.entries.get(name);
    if (!entry) return { enabled: false, ready: false };
    if (!entry.def.enabled) return { enabled: false, ready: false };
    try {
      const client = await this.ensure(name);
      await client.listTools();
      return { enabled: true, ready: true };
    } catch (err) {
      return { enabled: true, ready: false, error: String(err) };
    }
  }

  status(): Array<{ name: AdapterName; enabled: boolean; started: boolean }> {
    return [...this.entries.values()].map((e) => ({
      name: e.name,
      enabled: e.def.enabled,
      started: e.lazyStarted && (e.client?.isReady() ?? false),
    }));
  }

  stopAll(): void {
    for (const e of this.entries.values()) e.client?.stop();
  }
}
