import { StdioChildClient } from './client.js';
import type { AdaptersConfig, AdapterDef } from '../../core/types.js';
import { logger } from '../../core/logger.js';

export type AdapterName = string;

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
  catalog: SubToolDescriptor[] | null;
}

function isAdapterDef(value: unknown): value is AdapterDef {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as AdapterDef).enabled === 'boolean' &&
      typeof (value as AdapterDef).command === 'string' &&
      Array.isArray((value as AdapterDef).args)
  );
}

/** Lazily spawns and manages built-in and installed child MCP servers. */
export class ChildMcpRegistry {
  private entries = new Map<AdapterName, AdapterEntry>();

  constructor(config: AdaptersConfig, extras: Array<{ name: string; def: AdapterDef }> = []) {
    for (const [name, def] of Object.entries(config)) {
      if (isAdapterDef(def)) this.upsert(name, def);
    }
    for (const extra of extras) this.upsert(extra.name, extra.def);
  }

  names(): string[] {
    return [...this.entries.keys()].sort();
  }

  upsert(name: string, def: AdapterDef): void {
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

  remove(name: string): void {
    this.entries.get(name)?.client?.stop();
    this.entries.delete(name);
  }

  isEnabled(name: AdapterName): boolean {
    return this.entries.get(name)?.def.enabled ?? false;
  }

  isFacade(name: AdapterName): boolean {
    return this.entries.get(name)?.def.facade ?? false;
  }

  async ensure(name: AdapterName): Promise<StdioChildClient> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Adapter not configured: ${name}`);
    if (!entry.def.enabled) throw new Error(`Adapter disabled: ${name}`);
    if (!entry.client) {
      entry.client = new StdioChildClient(
        entry.def.command,
        entry.def.args,
        entry.def.env ?? {},
        entry.def.cwd,
        entry.def.inheritEnv !== false
      );
    }
    if (!entry.client.isReady()) {
      logger.info({ adapter: name }, 'Starting child MCP adapter');
      await entry.client.start();
      entry.lazyStarted = true;
    }
    return entry.client;
  }

  async catalog(name: AdapterName, refresh = false): Promise<SubToolDescriptor[]> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Adapter not configured: ${name}`);
    if (!refresh && entry.catalog) return entry.catalog;
    const client = await this.ensure(name);
    const tools = await client.listTools();
    entry.catalog = tools.map((tool) => ({
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
    }));
    return entry.catalog;
  }

  async health(name: AdapterName): Promise<{
    enabled: boolean;
    ready: boolean;
    tools?: number;
    error?: string;
  }> {
    const entry = this.entries.get(name);
    if (!entry || !entry.def.enabled) return { enabled: false, ready: false };
    try {
      const tools = await this.catalog(name, true);
      return { enabled: true, ready: true, tools: tools.length };
    } catch (error) {
      return { enabled: true, ready: false, error: String(error) };
    }
  }

  status(): Array<{ name: AdapterName; enabled: boolean; started: boolean; facade: boolean }> {
    return [...this.entries.values()].map((entry) => ({
      name: entry.name,
      enabled: entry.def.enabled,
      started: entry.lazyStarted && (entry.client?.isReady() ?? false),
      facade: entry.def.facade ?? false,
    }));
  }

  stopAll(): void {
    for (const entry of this.entries.values()) entry.client?.stop();
  }
}
