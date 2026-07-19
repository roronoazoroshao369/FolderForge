import type { AdapterDef } from '../core/types.js';
import type { ChildMcpRegistry } from '../adapters/child-mcp/registry.js';
import { ShapingProxy, normalizeNetworkShape, type NetworkShape, type NetworkProxyStatus } from './network-proxy.js';

export type BrowserEmulationPreset =
  | 'desktop'
  | 'mobile'
  | 'tablet'
  | 'slow3g'
  | 'fast3g'
  | 'offline'
  | 'reset';

export interface BrowserEmulationInput {
  preset?: BrowserEmulationPreset;
  device?: string;
  viewport?: { width: number; height: number };
  userAgent?: string;
  network?: NetworkShape;
}

export interface BrowserEmulationStatus {
  active: boolean;
  preset: BrowserEmulationPreset | 'custom' | 'none';
  device?: string;
  viewport?: { width: number; height: number };
  userAgent?: string;
  network: NetworkProxyStatus;
  adapterArgs: string[];
  appliedAt?: number;
}

const MANAGED_FLAGS = new Set(['--device', '--viewport-size', '--user-agent', '--proxy-server']);
const PRESETS: Record<Exclude<BrowserEmulationPreset, 'reset'>, BrowserEmulationInput> = {
  desktop: { viewport: { width: 1440, height: 900 } },
  mobile: { device: 'iPhone 15' },
  tablet: { device: 'iPad (gen 7)' },
  slow3g: {
    viewport: { width: 1365, height: 768 },
    network: { latencyMs: 400, downloadBytesPerSecond: 400_000, uploadBytesPerSecond: 400_000 },
  },
  fast3g: {
    viewport: { width: 1365, height: 768 },
    network: { latencyMs: 150, downloadBytesPerSecond: 1_600_000, uploadBytesPerSecond: 750_000 },
  },
  offline: { viewport: { width: 1365, height: 768 }, network: { offline: true } },
};

function stripManagedArgs(args: string[]): string[] {
  const output: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const key = [...MANAGED_FLAGS].find((flag) => arg === flag || arg.startsWith(`${flag}=`));
    if (!key) {
      output.push(arg);
      continue;
    }
    if (arg === key) i += 1;
  }
  return output;
}

function viewport(value: unknown): { width: number; height: number } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('viewport must be an object.');
  const record = value as Record<string, unknown>;
  const width = Number(record.width);
  const height = Number(record.height);
  if (!Number.isSafeInteger(width) || width < 1 || width > 10_000) throw new Error('viewport.width must be 1-10000.');
  if (!Number.isSafeInteger(height) || height < 1 || height > 10_000) throw new Error('viewport.height must be 1-10000.');
  return { width, height };
}

function mergeProfile(input: BrowserEmulationInput): BrowserEmulationInput & { presetName: BrowserEmulationStatus['preset'] } {
  const preset = input.preset;
  if (preset === 'reset') return { presetName: 'none', preset: 'reset' };
  const base = preset ? PRESETS[preset] : {};
  const merged: BrowserEmulationInput & { presetName: BrowserEmulationStatus['preset'] } = {
    ...base,
    ...input,
    ...(base.network || input.network ? { network: { ...(base.network ?? {}), ...(input.network ?? {}) } } : {}),
    presetName: preset ?? 'custom',
  };
  if (merged.device && merged.viewport) throw new Error('device and viewport are mutually exclusive; device already defines viewport and user agent.');
  if (merged.device !== undefined) {
    const value = String(merged.device).trim();
    if (!value || value.length > 128 || /[\0\r\n]/.test(value)) throw new Error('device must be a bounded single-line Playwright device name.');
    merged.device = value;
  }
  if (merged.userAgent !== undefined) {
    const value = String(merged.userAgent).trim();
    if (!value || value.length > 1024 || /[\0\r\n]/.test(value)) throw new Error('userAgent must be a bounded single-line value.');
    merged.userAgent = value;
  }
  const normalizedViewport = viewport(merged.viewport);
  if (normalizedViewport) merged.viewport = normalizedViewport;
  else delete merged.viewport;
  if (merged.network) merged.network = normalizeNetworkShape(merged.network);
  return merged;
}

function cloneDef(def: AdapterDef): AdapterDef {
  return {
    ...def,
    args: [...def.args],
    ...(def.env ? { env: { ...def.env } } : {}),
    ...(def.sandbox
      ? {
          sandbox: {
            ...def.sandbox,
            ...(def.sandbox.args ? { args: [...def.sandbox.args] } : {}),
            ...(def.sandbox.mounts ? { mounts: def.sandbox.mounts.map((mount) => ({ ...mount })) } : {}),
          },
        }
      : {}),
  };
}

export class BrowserEmulationManager {
  private readonly proxy = new ShapingProxy();
  private baseline: AdapterDef | null = null;
  private current: BrowserEmulationStatus | null = null;

  constructor(private readonly adapters: ChildMcpRegistry) {}

  async apply(input: BrowserEmulationInput): Promise<BrowserEmulationStatus> {
    const currentDef = this.adapters.definition('playwright');
    if (!currentDef || !currentDef.enabled) throw new Error('Playwright adapter must be enabled before applying browser emulation.');
    this.baseline ??= cloneDef(currentDef);
    const profile = mergeProfile(input);
    if (profile.preset === 'reset') return this.reset();

    const args = stripManagedArgs(this.baseline.args);
    if (profile.device) args.push('--device', profile.device);
    if (profile.viewport) args.push('--viewport-size', `${profile.viewport.width}x${profile.viewport.height}`);
    if (profile.userAgent) args.push('--user-agent', profile.userAgent);

    const network = normalizeNetworkShape(profile.network);
    const networkEnabled = network.offline || network.latencyMs > 0 || network.downloadBytesPerSecond > 0 || network.uploadBytesPerSecond > 0;
    let proxyStatus: NetworkProxyStatus;
    if (networkEnabled) {
      await this.proxy.start(network);
      proxyStatus = this.proxy.configure(network);
      args.push('--proxy-server', proxyStatus.url!);
    } else {
      await this.proxy.close();
      proxyStatus = this.proxy.status();
    }

    this.adapters.upsert('playwright', { ...cloneDef(this.baseline), args });
    this.current = {
      active: true,
      preset: profile.presetName,
      ...(profile.device ? { device: profile.device } : {}),
      ...(profile.viewport ? { viewport: profile.viewport } : {}),
      ...(profile.userAgent ? { userAgent: profile.userAgent } : {}),
      network: proxyStatus,
      adapterArgs: [...args],
      appliedAt: Date.now(),
    };
    return this.status();
  }

  async reset(): Promise<BrowserEmulationStatus> {
    await this.proxy.close();
    if (this.baseline) this.adapters.upsert('playwright', cloneDef(this.baseline));
    const args = this.baseline?.args ?? this.adapters.definition('playwright')?.args ?? [];
    this.current = {
      active: false,
      preset: 'none',
      network: this.proxy.status(),
      adapterArgs: [...args],
    };
    return this.status();
  }

  status(): BrowserEmulationStatus {
    if (this.current) return JSON.parse(JSON.stringify(this.current)) as BrowserEmulationStatus;
    return {
      active: false,
      preset: 'none',
      network: this.proxy.status(),
      adapterArgs: [...(this.adapters.definition('playwright')?.args ?? [])],
    };
  }

  async close(): Promise<void> {
    await this.proxy.close();
  }
}
