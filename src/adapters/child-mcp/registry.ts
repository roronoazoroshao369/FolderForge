import { StdioChildClient, ChildMcpError, redactChildArgs, type ChildMcpDiagnostic } from './client.js';
import { resolveAdapterLaunch, type ResolvedAdapterLaunch } from './resolve.js';
import type { AdaptersConfig, AdapterDef } from '../../core/types.js';
import { logger } from '../../core/logger.js';
import { SecretPolicy } from '../../policy/secret-policy.js';

export type AdapterName = string;

/** A discovered child sub-tool descriptor, cached for facade adapters. */
export interface SubToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface AdapterStatus {
  name: AdapterName;
  enabled: boolean;
  started: boolean;
  ready: boolean;
  facade: boolean;
  launch?: {
    command: string;
    args: string[];
    cwd?: string;
    source: 'custom' | 'package-local';
    packageName?: string;
    packageVersion?: string;
  };
  diagnostic?: ChildMcpDiagnostic;
}

interface AdapterEntry {
  name: AdapterName;
  def: AdapterDef;
  client: StdioChildClient | null;
  lazyStarted: boolean;
  catalog: SubToolDescriptor[] | null;
  catalogGeneration: number;
  launch: ResolvedAdapterLaunch | null;
  diagnostic: ChildMcpDiagnostic | null;
}

const secretPolicy = new SecretPolicy();

function isAdapterDef(value: unknown): value is AdapterDef {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as AdapterDef).enabled === 'boolean' &&
      typeof (value as AdapterDef).command === 'string' &&
      Array.isArray((value as AdapterDef).args)
  );
}

function resolutionDiagnostic(name: string, def: AdapterDef, error: unknown): ChildMcpDiagnostic {
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
      catalogGeneration: 0,
      launch: null,
      diagnostic: null,
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
      try {
        entry.launch = resolveAdapterLaunch(name, entry.def);
      } catch (error) {
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
          entry.catalogGeneration += 1;
        },
        onToolsListChanged: () => {
          entry.catalog = null;
          entry.catalogGeneration += 1;
          logger.info({ adapter: name }, 'Child MCP tool catalog invalidated');
        },
      });
    }
    if (!entry.client.isReady()) {
      logger.info(
        {
          adapter: name,
          command: entry.launch?.command,
          args: redactChildArgs(entry.launch?.args ?? []),
          source: entry.launch?.source,
        },
        'Starting child MCP adapter'
      );
      try {
        await entry.client.start();
        entry.lazyStarted = true;
        entry.diagnostic = null;
      } catch (error) {
        entry.diagnostic = entry.client.diagnostic() ?? entry.diagnostic;
        throw error;
      }
    }
    return entry.client;
  }

  async catalog(name: AdapterName, refresh = false): Promise<SubToolDescriptor[]> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Adapter not configured: ${name}`);
    if (!refresh && entry.catalog) return entry.catalog;
    const client = await this.ensure(name);
    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const generation = entry.catalogGeneration;
        const tools = await client.listTools();
        const catalog = tools.map((tool) => ({
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
        }));
        if (entry.catalogGeneration !== generation) continue;
        entry.catalog = catalog;
        entry.diagnostic = null;
        return entry.catalog;
      }
      throw new Error(`Adapter ${name} changed its tool catalog repeatedly during discovery.`);
    } catch (error) {
      entry.diagnostic = client.diagnostic() ?? entry.diagnostic;
      throw error;
    }
  }

  async health(name: AdapterName): Promise<{
    enabled: boolean;
    ready: boolean;
    tools?: number;
    error?: string;
    diagnostic?: ChildMcpDiagnostic;
  }> {
    const entry = this.entries.get(name);
    if (!entry || !entry.def.enabled) return { enabled: false, ready: false };
    try {
      const tools = await this.catalog(name, true);
      return { enabled: true, ready: true, tools: tools.length };
    } catch (error) {
      return {
        enabled: true,
        ready: false,
        error: error instanceof Error ? error.message : String(error),
        ...(entry.diagnostic ? { diagnostic: { ...entry.diagnostic, args: [...entry.diagnostic.args] } } : {}),
      };
    }
  }

  status(): AdapterStatus[] {
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

  stopAll(): void {
    for (const entry of this.entries.values()) entry.client?.stop();
  }
}
