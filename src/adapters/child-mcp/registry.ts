import {
  StdioChildClient,
  ChildMcpError,
  classifyChildFailureDisposition,
  redactChildArgs,
  type ChildFailureDisposition,
  type ChildFailureKind,
  type ChildFailurePhase,
  type ChildMcpDiagnostic,
  type ChildTransportStats,
} from './client.js';
import { resolveAdapterLaunch, type ResolvedAdapterLaunch } from './resolve.js';
import { applySandboxLaunch, sandboxSummary } from '../../sandbox/launcher.js';
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

export type AdapterLifecycleState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'backoff'
  | 'open'
  | 'half_open'
  | 'degraded'
  | 'blocked'
  | 'stopped';

export interface AdapterMetrics {
  observedMs: number;
  currentUptimeMs: number;
  totalReadyMs: number;
  availability: number;
  totalFailures: number;
  failureRatePerHour: number;
  recoveries: number;
  meanRecoveryMs: number | null;
  failuresByKind: Partial<Record<ChildFailureKind, number>>;
  failuresByDisposition: Record<ChildFailureDisposition, number>;
}

export interface AdapterStatus {
  name: AdapterName;
  enabled: boolean;
  started: boolean;
  ready: boolean;
  degraded: boolean;
  facade: boolean;
  state: AdapterLifecycleState;
  pid?: number;
  startAttempts: number;
  successfulStarts: number;
  restartCount: number;
  consecutiveFailures: number;
  nextRetryAt?: string;
  lastStartAt?: string;
  lastReadyAt?: string;
  lastFailureAt?: string;
  failureDisposition?: ChildFailureDisposition;
  metrics: AdapterMetrics;
  transport?: ChildTransportStats;
  launch?: {
    command: string;
    args: string[];
    cwd?: string;
    source: 'custom' | 'package-local';
    packageName?: string;
    packageVersion?: string;
    sandbox?: Record<string, unknown>;
  };
  diagnostic?: ChildMcpDiagnostic;
}

export interface ChildMcpRegistryOptions {
  retryBaseMs?: number;
  retryMaxMs?: number;
  circuitFailureThreshold?: number;
  circuitOpenMs?: number;
  now?: () => number;
}

export class AdapterUnavailableError extends Error {
  constructor(
    readonly adapter: string,
    readonly state: AdapterLifecycleState,
    readonly retryAt: string | null,
    readonly diagnostic: ChildMcpDiagnostic | null
  ) {
    const retry = retryAt ? ` Retry is available at ${retryAt}.` : '';
    super(`Adapter ${adapter} is ${state}.${retry}`);
    this.name = 'AdapterUnavailableError';
  }
}

interface AdapterEntry {
  name: AdapterName;
  def: AdapterDef;
  client: StdioChildClient | null;
  startPromise: Promise<StdioChildClient> | null;
  lazyStarted: boolean;
  catalog: SubToolDescriptor[] | null;
  catalogGeneration: number;
  launch: ResolvedAdapterLaunch | null;
  diagnostic: ChildMcpDiagnostic | null;
  state: AdapterLifecycleState;
  stopped: boolean;
  startAttempts: number;
  successfulStarts: number;
  restartCount: number;
  consecutiveFailures: number;
  nextRetryAtMs: number;
  lastStartAt: string | null;
  lastReadyAt: string | null;
  lastFailureAt: string | null;
  lastCountedFailure: string | null;
  failureDisposition: ChildFailureDisposition | null;
  createdAtMs: number;
  readySinceMs: number | null;
  totalReadyMs: number;
  totalFailures: number;
  recoveries: number;
  totalRecoveryMs: number;
  recoveryStartedAtMs: number | null;
  failuresByKind: Partial<Record<ChildFailureKind, number>>;
  failuresByDisposition: Record<ChildFailureDisposition, number>;
}

interface NormalizedRegistryOptions {
  retryBaseMs: number;
  retryMaxMs: number;
  circuitFailureThreshold: number;
  circuitOpenMs: number;
  now: () => number;
}

const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 10_000;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_OPEN_MS = 30_000;
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

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function cloneDiagnostic(diagnostic: ChildMcpDiagnostic | null): ChildMcpDiagnostic | null {
  return diagnostic ? { ...diagnostic, args: [...diagnostic.args] } : null;
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
      : /sandbox|docker|podman|image|mount|memoryMb|pidsLimit|tmpfsMb|cpus/i.test(message)
        ? 'invalid_adapter_arguments'
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

function unexpectedDiagnostic(
  name: string,
  def: AdapterDef,
  phase: ChildFailurePhase,
  error: unknown
): ChildMcpDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  return {
    adapter: name,
    command: def.command,
    args: redactChildArgs(def.args),
    cwd: def.cwd ?? process.cwd(),
    phase,
    kind: phase === 'runtime' ? 'runtime_crash' : 'unknown',
    exitCode: null,
    signal: null,
    spawnError: secretPolicy.redact(message),
    stderrTail: '',
    timedOut: false,
    remediation: 'Run `folderforge doctor` and inspect the adapter lifecycle status.',
    occurredAt: new Date().toISOString(),
  };
}

function createEntry(name: string, def: AdapterDef, now: number): AdapterEntry {
  return {
    name,
    def: {
      ...def,
      args: [...def.args],
      ...(def.env ? { env: { ...def.env } } : {}),
      ...(def.sandbox
        ? {
            sandbox: {
              ...def.sandbox,
              ...(def.sandbox.args ? { args: [...def.sandbox.args] } : {}),
              ...(def.sandbox.mounts
                ? { mounts: def.sandbox.mounts.map((mount) => ({ ...mount })) }
                : {}),
            },
          }
        : {}),
    },
    client: null,
    startPromise: null,
    lazyStarted: false,
    catalog: null,
    catalogGeneration: 0,
    launch: null,
    diagnostic: null,
    state: 'idle',
    stopped: false,
    startAttempts: 0,
    successfulStarts: 0,
    restartCount: 0,
    consecutiveFailures: 0,
    nextRetryAtMs: 0,
    lastStartAt: null,
    lastReadyAt: null,
    lastFailureAt: null,
    lastCountedFailure: null,
    failureDisposition: null,
    createdAtMs: now,
    readySinceMs: null,
    totalReadyMs: 0,
    totalFailures: 0,
    recoveries: 0,
    totalRecoveryMs: 0,
    recoveryStartedAtMs: null,
    failuresByKind: {},
    failuresByDisposition: {
      transient: 0,
      configuration: 0,
      compatibility: 0,
      resource: 0,
      shutdown: 0,
    },
  };
}

/** Lazily spawns and manages built-in and installed child MCP servers. */
export class ChildMcpRegistry {
  private entries = new Map<AdapterName, AdapterEntry>();
  private readonly lifecycle: NormalizedRegistryOptions;

  constructor(
    config: AdaptersConfig,
    extras: Array<{ name: string; def: AdapterDef }> = [],
    options: ChildMcpRegistryOptions = {}
  ) {
    const retryBaseMs = positiveSafeInteger(
      options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
      'retryBaseMs'
    );
    const retryMaxMs = positiveSafeInteger(
      options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
      'retryMaxMs'
    );
    if (retryMaxMs < retryBaseMs) {
      throw new Error('retryMaxMs must be greater than or equal to retryBaseMs.');
    }
    this.lifecycle = {
      retryBaseMs,
      retryMaxMs,
      circuitFailureThreshold: positiveSafeInteger(
        options.circuitFailureThreshold ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
        'circuitFailureThreshold'
      ),
      circuitOpenMs: positiveSafeInteger(
        options.circuitOpenMs ?? DEFAULT_CIRCUIT_OPEN_MS,
        'circuitOpenMs'
      ),
      now: options.now ?? Date.now,
    };

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
    if (existing) this.closeReadyWindow(existing);
    existing?.client?.stop();
    this.entries.set(name, createEntry(name, def, this.now()));
  }

  remove(name: string): void {
    const entry = this.entries.get(name);
    if (entry) this.closeReadyWindow(entry);
    entry?.client?.stop();
    this.entries.delete(name);
  }

  isEnabled(name: AdapterName): boolean {
    return this.entries.get(name)?.def.enabled ?? false;
  }

  isFacade(name: AdapterName): boolean {
    return this.entries.get(name)?.def.facade ?? false;
  }

  private now(): number {
    return this.lifecycle.now();
  }

  private closeReadyWindow(entry: AdapterEntry): void {
    if (entry.readySinceMs === null) return;
    entry.totalReadyMs += Math.max(0, this.now() - entry.readySinceMs);
    entry.readySinceMs = null;
  }

  private metricsFor(entry: AdapterEntry): AdapterMetrics {
    const now = this.now();
    const observedMs = Math.max(0, now - entry.createdAtMs);
    const currentUptimeMs = entry.readySinceMs === null ? 0 : Math.max(0, now - entry.readySinceMs);
    const totalReadyMs = entry.totalReadyMs + currentUptimeMs;
    return {
      observedMs,
      currentUptimeMs,
      totalReadyMs,
      availability: observedMs === 0 ? (entry.client?.isReady() ? 1 : 0) : totalReadyMs / observedMs,
      totalFailures: entry.totalFailures,
      failureRatePerHour: observedMs === 0 ? 0 : entry.totalFailures / (observedMs / 3_600_000),
      recoveries: entry.recoveries,
      meanRecoveryMs: entry.recoveries === 0 ? null : entry.totalRecoveryMs / entry.recoveries,
      failuresByKind: { ...entry.failuresByKind },
      failuresByDisposition: { ...entry.failuresByDisposition },
    };
  }

  private refreshLifecycleState(entry: AdapterEntry): void {
    if (entry.stopped) {
      entry.state = 'stopped';
      return;
    }
    if (entry.client?.isReady()) {
      entry.state = 'ready';
      return;
    }
    if (entry.startPromise) return;
    if (
      (entry.state === 'backoff' || entry.state === 'open') &&
      entry.nextRetryAtMs <= this.now()
    ) {
      entry.state = 'degraded';
    }
  }

  private retryDelayMs(consecutiveFailures: number): number {
    const exponent = Math.min(30, Math.max(0, consecutiveFailures - 1));
    const exponential = Math.min(
      this.lifecycle.retryMaxMs,
      this.lifecycle.retryBaseMs * 2 ** exponent
    );
    return consecutiveFailures >= this.lifecycle.circuitFailureThreshold
      ? Math.max(exponential, this.lifecycle.circuitOpenMs)
      : exponential;
  }

  private recordFailure(entry: AdapterEntry, diagnostic: ChildMcpDiagnostic): void {
    entry.diagnostic = cloneDiagnostic(diagnostic);
    entry.lastFailureAt = diagnostic.occurredAt;

    const token = [
      diagnostic.occurredAt,
      diagnostic.phase,
      diagnostic.kind,
      diagnostic.exitCode,
      diagnostic.signal,
    ].join('|');
    if (entry.lastCountedFailure === token) return;

    const now = this.now();
    this.closeReadyWindow(entry);
    entry.catalog = null;
    entry.catalogGeneration += 1;
    entry.lastCountedFailure = token;
    entry.failureDisposition = classifyChildFailureDisposition(diagnostic.kind);
    entry.totalFailures += 1;
    entry.failuresByKind[diagnostic.kind] = (entry.failuresByKind[diagnostic.kind] ?? 0) + 1;
    entry.failuresByDisposition[entry.failureDisposition] += 1;
    entry.recoveryStartedAtMs ??= now;
    entry.consecutiveFailures += 1;

    if (entry.failureDisposition !== 'transient') {
      entry.nextRetryAtMs = 0;
      entry.state = entry.failureDisposition === 'shutdown' ? 'stopped' : 'blocked';
      return;
    }

    entry.nextRetryAtMs = now + this.retryDelayMs(entry.consecutiveFailures);
    entry.state = entry.consecutiveFailures >= this.lifecycle.circuitFailureThreshold
      ? 'open'
      : 'backoff';
  }

  private markReady(entry: AdapterEntry): void {
    const now = this.now();
    const recovered = entry.startAttempts > 1 || entry.lazyStarted || entry.consecutiveFailures > 0;
    entry.lazyStarted = true;
    entry.successfulStarts += 1;
    if (recovered) entry.restartCount += 1;
    if (entry.recoveryStartedAtMs !== null) {
      entry.recoveries += 1;
      entry.totalRecoveryMs += Math.max(0, now - entry.recoveryStartedAtMs);
      entry.recoveryStartedAtMs = null;
    }
    entry.readySinceMs = now;
    entry.consecutiveFailures = 0;
    entry.nextRetryAtMs = 0;
    entry.diagnostic = null;
    entry.lastCountedFailure = null;
    entry.failureDisposition = null;
    entry.lastReadyAt = new Date(now).toISOString();
    entry.state = 'ready';
  }

  private unavailable(entry: AdapterEntry): AdapterUnavailableError {
    this.refreshLifecycleState(entry);
    const retryAt = entry.nextRetryAtMs > this.now()
      ? new Date(entry.nextRetryAtMs).toISOString()
      : null;
    return new AdapterUnavailableError(
      entry.name,
      entry.state,
      retryAt,
      cloneDiagnostic(entry.diagnostic)
    );
  }

  private createClient(entry: AdapterEntry): StdioChildClient {
    try {
      entry.launch = applySandboxLaunch(
        entry.def,
        resolveAdapterLaunch(entry.name, entry.def)
      );
    } catch (error) {
      const diagnostic = resolutionDiagnostic(entry.name, entry.def, error);
      this.recordFailure(entry, diagnostic);
      logger.warn({ diagnostic }, 'child MCP adapter resolution failed');
      throw new ChildMcpError(
        `${entry.name} adapter failed during resolve: ${String(error)}`,
        diagnostic
      );
    }

    const launch = entry.launch;
    return new StdioChildClient({
      adapter: entry.name,
      command: launch.command,
      args: launch.args,
      env: entry.def.env ?? {},
      ...(launch.cwd ? { cwd: launch.cwd } : {}),
      // Container runtimes need the host PATH to locate docker/podman. Only
      // explicitly named --env keys cross into the sandboxed plugin process.
      inheritEnv: entry.def.sandbox && entry.def.sandbox.mode !== 'process'
        ? true
        : entry.def.inheritEnv !== false,
      onDiagnostic: (diagnostic) => {
        if (!entry.stopped) this.recordFailure(entry, diagnostic);
      },
      onToolsListChanged: () => {
        entry.catalog = null;
        entry.catalogGeneration += 1;
        logger.info({ adapter: entry.name }, 'Child MCP tool catalog invalidated');
      },
    });
  }

  private async startEntry(entry: AdapterEntry): Promise<StdioChildClient> {
    if (!entry.client) entry.client = this.createClient(entry);
    const client = entry.client;

    logger.info(
      {
        adapter: entry.name,
        command: entry.launch?.command,
        args: redactChildArgs(entry.launch?.args ?? []),
        source: entry.launch?.source,
        attempt: entry.startAttempts,
        lifecycleState: entry.state,
      },
      'Starting child MCP adapter'
    );

    try {
      await client.start();
      if (entry.stopped) {
        client.stop();
        throw new AdapterUnavailableError(entry.name, 'stopped', null, null);
      }
      this.markReady(entry);
      return client;
    } catch (error) {
      if (!entry.stopped) {
        const diagnostic = client.diagnostic()
          ?? entry.diagnostic
          ?? unexpectedDiagnostic(entry.name, entry.def, 'initialize', error);
        this.recordFailure(entry, diagnostic);
      }
      throw error;
    }
  }

  async ensure(name: AdapterName): Promise<StdioChildClient> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Adapter not configured: ${name}`);
    if (!entry.def.enabled) throw new Error(`Adapter disabled: ${name}`);
    if (entry.stopped || entry.state === 'blocked') throw this.unavailable(entry);
    if (entry.client?.isReady()) {
      entry.state = 'ready';
      return entry.client;
    }
    if (entry.startPromise) return entry.startPromise;

    this.refreshLifecycleState(entry);
    if (entry.nextRetryAtMs > this.now()) throw this.unavailable(entry);

    const circuitProbe = entry.consecutiveFailures >= this.lifecycle.circuitFailureThreshold;
    entry.state = circuitProbe ? 'half_open' : 'starting';
    entry.startAttempts += 1;
    entry.lastStartAt = new Date(this.now()).toISOString();

    let startPromise: Promise<StdioChildClient>;
    startPromise = this.startEntry(entry).finally(() => {
      if (entry.startPromise === startPromise) entry.startPromise = null;
      this.refreshLifecycleState(entry);
    });
    entry.startPromise = startPromise;
    return startPromise;
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
        entry.state = 'ready';
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
    state: AdapterLifecycleState;
    tools?: number;
    error?: string;
    nextRetryAt?: string;
    failureDisposition?: ChildFailureDisposition;
    metrics: AdapterMetrics;
    transport?: ChildTransportStats;
    diagnostic?: ChildMcpDiagnostic;
  }> {
    const entry = this.entries.get(name);
    if (!entry || !entry.def.enabled) {
      const empty = entry ? this.metricsFor(entry) : {
        observedMs: 0,
        currentUptimeMs: 0,
        totalReadyMs: 0,
        availability: 0,
        totalFailures: 0,
        failureRatePerHour: 0,
        recoveries: 0,
        meanRecoveryMs: null,
        failuresByKind: {},
        failuresByDisposition: {
          transient: 0,
          configuration: 0,
          compatibility: 0,
          resource: 0,
          shutdown: 0,
        },
      } satisfies AdapterMetrics;
      return { enabled: false, ready: false, state: 'idle', metrics: empty };
    }
    try {
      const tools = await this.catalog(name, true);
      return {
        enabled: true,
        ready: true,
        state: 'ready',
        tools: tools.length,
        metrics: this.metricsFor(entry),
        ...(entry.client ? { transport: entry.client.transportStats() } : {}),
      };
    } catch (error) {
      const status = this.status().find((candidate) => candidate.name === name);
      return {
        enabled: true,
        ready: false,
        state: status?.state ?? 'degraded',
        error: error instanceof Error ? error.message : String(error),
        metrics: status?.metrics ?? this.metricsFor(entry),
        ...(status?.nextRetryAt ? { nextRetryAt: status.nextRetryAt } : {}),
        ...(status?.failureDisposition
          ? { failureDisposition: status.failureDisposition }
          : {}),
        ...(status?.transport ? { transport: status.transport } : {}),
        ...(entry.diagnostic ? { diagnostic: cloneDiagnostic(entry.diagnostic)! } : {}),
      };
    }
  }

  status(): AdapterStatus[] {
    return [...this.entries.values()].map((entry) => {
      this.refreshLifecycleState(entry);
      const ready = entry.client?.isReady() ?? false;
      const pid = entry.client?.pid();
      const nextRetryAt = entry.nextRetryAtMs > this.now()
        ? new Date(entry.nextRetryAtMs).toISOString()
        : null;
      return {
        name: entry.name,
        enabled: entry.def.enabled,
        started: entry.lazyStarted,
        ready,
        degraded: entry.def.enabled && !ready && entry.state !== 'idle' && entry.state !== 'stopped',
        facade: entry.def.facade ?? false,
        state: entry.state,
        ...(pid !== undefined ? { pid } : {}),
        startAttempts: entry.startAttempts,
        successfulStarts: entry.successfulStarts,
        restartCount: entry.restartCount,
        consecutiveFailures: entry.consecutiveFailures,
        ...(nextRetryAt ? { nextRetryAt } : {}),
        ...(entry.lastStartAt ? { lastStartAt: entry.lastStartAt } : {}),
        ...(entry.lastReadyAt ? { lastReadyAt: entry.lastReadyAt } : {}),
        ...(entry.lastFailureAt ? { lastFailureAt: entry.lastFailureAt } : {}),
        ...(entry.failureDisposition
          ? { failureDisposition: entry.failureDisposition }
          : {}),
        metrics: this.metricsFor(entry),
        ...(entry.client ? { transport: entry.client.transportStats() } : {}),
        ...(entry.launch
          ? {
              launch: {
                command: entry.launch.command,
                args: redactChildArgs(entry.launch.args),
                ...(entry.launch.cwd ? { cwd: entry.launch.cwd } : {}),
                source: entry.launch.source,
                ...(entry.launch.packageName ? { packageName: entry.launch.packageName } : {}),
                ...(entry.launch.packageVersion ? { packageVersion: entry.launch.packageVersion } : {}),
                sandbox: sandboxSummary(entry.def.sandbox),
              },
            }
          : {}),
        ...(entry.diagnostic ? { diagnostic: cloneDiagnostic(entry.diagnostic)! } : {}),
      };
    });
  }

  stopAll(): void {
    for (const entry of this.entries.values()) {
      this.closeReadyWindow(entry);
      entry.stopped = true;
      entry.state = 'stopped';
      entry.catalog = null;
      entry.client?.stop();
    }
  }

  async stopAllAndWait(timeoutMs = 1_000): Promise<void> {
    positiveSafeInteger(timeoutMs, 'timeoutMs');
    const stops: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      this.closeReadyWindow(entry);
      entry.stopped = true;
      entry.state = 'stopped';
      entry.catalog = null;
      if (entry.client) stops.push(entry.client.stopAndWait(timeoutMs));
    }
    await Promise.allSettled(stops);
  }
}
