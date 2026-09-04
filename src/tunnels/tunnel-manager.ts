/**
 * Quick-tunnel manager (ADR-0012, Phase 3).
 *
 * Exposes a local port through a `cloudflared` quick tunnel. Tunnels are
 * spawned through ProcessManager (injected here), so Mission Control process
 * containment applies unchanged. Quick tunnels are PUBLIC by nature: the
 * agent-facing tool that starts one is HIGH risk and policy-gated, and no
 * credentials are stored anywhere in tunnel state.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { CloudflareClient } from '../cloudflare/api-client.js';
import type { CloudflareConfig } from '../cloudflare/config-store.js';

export type TunnelState = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export type TunnelKind = 'quick' | 'named';

export interface TunnelRecord {
  id: string;
  kind: TunnelKind;
  targetPort: number;
  targetUrl: string;
  publicUrl?: string;
  hostname?: string;
  cfTunnelId?: string;
  dnsRecordId?: string;
  zoneId?: string;
  state: TunnelState;
  sessionId?: string;
  pid?: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface TunnelSpawnResult {
  sessionId: string;
  pid: number | undefined;
}

export type TunnelSpawner = (command: string, cwd: string) => TunnelSpawnResult;
export type TunnelSessionStopper = (sessionId: string) => unknown;
export type TunnelLogReader = (sessionId: string) => string;
export type TunnelExitSubscribe = (sessionId: string, listener: () => void) => () => void;

export interface CloudflareHook {
  loadConfig: () => CloudflareConfig | null;
  makeClient: (apiToken: string) => CloudflareClient;
}

export interface TunnelManagerOptions {
  spawn?: TunnelSpawner;
  /** When wired, enables named tunnels backed by a linked Cloudflare account. */
  cloudflare?: CloudflareHook;
  stopSession?: TunnelSessionStopper;
  readSession?: TunnelLogReader;
  onExit?: TunnelExitSubscribe;
  /** cloudflared binary name or path (default: 'cloudflared'). */
  binary?: string;
  /** Max wait for the public URL to appear in tunnel output (default 15s). */
  urlTimeoutMs?: number;
  /** Poll interval while waiting for the public URL (default 250ms). */
  urlPollMs?: number;
  now?: () => number;
}

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export class TunnelManager {
  private readonly spawnFn: TunnelSpawner | undefined;
  private readonly stopFn: TunnelSessionStopper | undefined;
  private readonly readFn: TunnelLogReader | undefined;
  private readonly onExitFn: TunnelExitSubscribe | undefined;
  private readonly cloudflare: CloudflareHook | undefined;
  private readonly binary: string;
  private readonly urlTimeoutMs: number;
  private readonly urlPollMs: number;
  private readonly now: () => number;
  private tunnels: TunnelRecord[] = [];

  constructor(options: TunnelManagerOptions = {}) {
    this.spawnFn = options.spawn;
    this.stopFn = options.stopSession;
    this.readFn = options.readSession;
    this.onExitFn = options.onExit;
    this.cloudflare = options.cloudflare;
    this.binary = options.binary ?? 'cloudflared';
    this.urlTimeoutMs = options.urlTimeoutMs ?? 15_000;
    this.urlPollMs = options.urlPollMs ?? 250;
    this.now = options.now ?? (() => Date.now());
  }

  list(): TunnelRecord[] {
    return this.tunnels.map((tunnel) => ({ ...tunnel }));
  }

  get(id: string): TunnelRecord {
    return { ...this.mutable(id) };
  }

  /**
   * Start a quick tunnel for a local port. Resolves once cloudflared prints
   * the public trycloudflare URL, or throws when startup fails/times out.
   */
  async start(input: { targetPort: number; actor?: string }): Promise<TunnelRecord> {
    const { targetPort } = input;
    if (!Number.isInteger(targetPort) || targetPort < 1024 || targetPort > 65535) {
      throw new Error(`Invalid target port: ${targetPort} (expected an integer in 1024-65535).`);
    }
    const existing = this.tunnels.find(
      (tunnel) =>
        tunnel.targetPort === targetPort &&
        (tunnel.state === 'running' || tunnel.state === 'starting'),
    );
    if (existing) {
      throw new Error(`Port ${targetPort} is already exposed by tunnel ${existing.id}.`);
    }
    if (!this.spawnFn) {
      throw new Error('No process spawner is wired; tunnel start is unavailable.');
    }

    const timestamp = new Date(this.now()).toISOString();
    const record: TunnelRecord = {
      id: `tun_${randomUUID().slice(0, 8)}`,
      kind: 'quick',
      targetPort,
      targetUrl: `http://127.0.0.1:${targetPort}`,
      state: 'starting',
      createdBy: input.actor?.trim() || 'unknown',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.tunnels.push(record);

    try {
      const command = `${this.binary} tunnel --url ${JSON.stringify(record.targetUrl)} --no-autoupdate`;
      const session = this.spawnFn(command, process.cwd());
      record.sessionId = session.sessionId;
      if (session.pid !== undefined) record.pid = session.pid;
      if (this.onExitFn) {
        this.onExitFn(session.sessionId, () => this.handleExit(record.id, session.sessionId));
      }
    } catch (error) {
      record.state = 'failed';
      record.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }

    const deadline = this.now() + this.urlTimeoutMs;
    while (this.now() < deadline) {
      if (record.state === 'failed') {
        throw new Error(record.lastError ?? 'Tunnel process exited during startup.');
      }
      const output = record.sessionId && this.readFn ? this.readFn(record.sessionId) : '';
      const match = QUICK_TUNNEL_URL.exec(output);
      if (match) {
        record.publicUrl = match[0];
        record.state = 'running';
        this.touch(record);
        return { ...record };
      }
      await new Promise((resolve) => setTimeout(resolve, this.urlPollMs));
    }
    record.state = 'failed';
    record.lastError = `Timed out after ${this.urlTimeoutMs}ms waiting for the public tunnel URL.`;
    throw new Error(record.lastError);
  }

  /**
   * Start a NAMED tunnel: creates a Cloudflare tunnel + DNS record via the API
   * (hostname must sit under the linked zone domain), then runs cloudflared
   * with the tunnel token. publicUrl is https://<hostname> — stable across
   * restarts, unlike quick tunnels. Any failure rolls back created CF
   * resources best-effort.
   */
  async startNamed(input: {
    targetPort: number;
    hostname: string;
    actor?: string;
  }): Promise<TunnelRecord> {
    const { targetPort } = input;
    const hostname = input.hostname.trim().toLowerCase();
    if (!Number.isInteger(targetPort) || targetPort < 1024 || targetPort > 65535) {
      throw new Error(`Invalid target port: ${targetPort} (expected an integer in 1024-65535).`);
    }
    if (
      !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)
    ) {
      throw new Error(`Invalid hostname: ${input.hostname} (expected a DNS hostname like mcp1.example.com).`);
    }
    if (!this.cloudflare) {
      throw new Error('cloudflare_not_configured: link a Cloudflare account first (Settings → Cloudflare).');
    }
    const config = this.cloudflare.loadConfig();
    if (!config) {
      throw new Error('cloudflare_not_configured: link a Cloudflare account first (Settings → Cloudflare).');
    }
    if (!hostname.endsWith(`.${config.domain}`) && hostname !== config.domain) {
      throw new Error(`Hostname must be under the linked domain ${config.domain}.`);
    }
    const dupe = this.tunnels.find(
      (tunnel) =>
        tunnel.hostname === hostname &&
        (tunnel.state === 'running' || tunnel.state === 'starting'),
    );
    if (dupe) {
      throw new Error(`Hostname ${hostname} is already exposed by tunnel ${dupe.id}.`);
    }
    if (!this.spawnFn) {
      throw new Error('No process spawner is wired; tunnel start is unavailable.');
    }

    const timestamp = new Date(this.now()).toISOString();
    const record: TunnelRecord = {
      id: `tun_${randomUUID().slice(0, 8)}`,
      kind: 'named',
      targetPort,
      targetUrl: `http://127.0.0.1:${targetPort}`,
      hostname,
      zoneId: config.zoneId,
      state: 'starting',
      createdBy: input.actor?.trim() || 'unknown',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.tunnels.push(record);

    const client = this.cloudflare.makeClient(config.apiToken);
    let createdTunnelId: string | undefined;
    let createdDnsId: string | undefined;
    const rollback = async (): Promise<void> => {
      if (createdDnsId) {
        try { await client.deleteDnsRecord(config.zoneId, createdDnsId); } catch { /* best-effort */ }
      }
      if (createdTunnelId) {
        try { await client.deleteTunnel(config.accountId, createdTunnelId); } catch { /* best-effort */ }
      }
    };

    try {
      const secret = randomBytes(32).toString('base64');
      const tunnel = await client.createTunnel(config.accountId, `ff-${hostname}`, secret);
      createdTunnelId = tunnel.id;
      record.cfTunnelId = tunnel.id;
      await client.putTunnelIngress(config.accountId, tunnel.id, hostname, record.targetUrl);
      const dns = await client.createDnsRecord(config.zoneId, hostname, tunnel.id);
      createdDnsId = dns.id;
      record.dnsRecordId = dns.id;

      const command = `${this.binary} tunnel --no-autoupdate run --token ${JSON.stringify(tunnel.token)}`;
      const session = this.spawnFn(command, process.cwd());
      record.sessionId = session.sessionId;
      if (session.pid !== undefined) record.pid = session.pid;
      if (this.onExitFn) {
        this.onExitFn(session.sessionId, () => this.handleExit(record.id, session.sessionId));
      }
    } catch (error) {
      await rollback();
      record.state = 'failed';
      record.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }

    const NAMED_UP = /Registered tunnel connection|connection .* registered/i;
    const deadline = this.now() + this.urlTimeoutMs;
    while (this.now() < deadline) {
      if (record.state === 'failed') {
        await rollback();
        throw new Error(record.lastError ?? 'Tunnel process exited during startup.');
      }
      const output = record.sessionId && this.readFn ? this.readFn(record.sessionId) : '';
      if (NAMED_UP.test(output)) {
        record.publicUrl = `https://${hostname}`;
        record.state = 'running';
        this.touch(record);
        return { ...record };
      }
      await new Promise((resolve) => setTimeout(resolve, this.urlPollMs));
    }
    await rollback();
    record.state = 'failed';
    record.lastError = `Timed out after ${this.urlTimeoutMs}ms waiting for the named tunnel connection.`;
    throw new Error(record.lastError);
  }

  /**
   * Stop the process AND delete the Cloudflare-side resources (DNS record +
   * tunnel) for named tunnels. For quick tunnels this is just `stop`.
   */
  async destroy(id: string): Promise<TunnelRecord> {
    const snapshot = this.stop(id);
    if (snapshot.kind === 'named' && snapshot.cfTunnelId && this.cloudflare) {
      const config = this.cloudflare.loadConfig();
      if (config) {
        const client = this.cloudflare.makeClient(config.apiToken);
        if (snapshot.dnsRecordId && snapshot.zoneId) {
          try { await client.deleteDnsRecord(snapshot.zoneId, snapshot.dnsRecordId); } catch { /* best-effort */ }
        }
        try { await client.deleteTunnel(config.accountId, snapshot.cfTunnelId); } catch { /* best-effort */ }
      }
    }
    return { ...this.mutable(id) };
  }

  stop(id: string): TunnelRecord {
    const record = this.mutable(id);
    if (record.state === 'stopped') return { ...record };
    if (record.sessionId && this.stopFn) {
      record.state = 'stopping';
      try {
        this.stopFn(record.sessionId);
      } catch {
        // The session may already be gone; the record still converges to stopped.
      }
    }
    record.state = 'stopped';
    delete record.sessionId;
    delete record.pid;
    this.touch(record);
    return { ...record };
  }

  /**
   * Control-plane shutdown path: stop every non-stopped tunnel. Best-effort
   * per record so one failing stop never blocks the rest.
   */
  stopAll(): void {
    for (const record of this.tunnels) {
      try {
        this.stop(record.id);
      } catch {
        // Converge: the remaining tunnels still get their stop.
      }
    }
  }

  /**
   * Handle an unexpected tunnel process exit. Deliberate stops pass through
   * `stopping`/`stopped` first, so an active state here means a crash.
   */
  private handleExit(id: string, sessionId: string): void {
    const record = this.tunnels.find((tunnel) => tunnel.id === id);
    if (!record || record.sessionId !== sessionId) return; // stale session
    if (record.state !== 'running' && record.state !== 'starting') return;
    record.state = 'failed';
    record.lastError = 'Tunnel process exited unexpectedly.';
    delete record.sessionId;
    delete record.pid;
    this.touch(record);
  }

  private mutable(id: string): TunnelRecord {
    const record = this.tunnels.find((tunnel) => tunnel.id === id);
    if (!record) throw new Error(`Unknown tunnel: ${id}`);
    return record;
  }

  private touch(record: TunnelRecord): void {
    record.updatedAt = new Date(this.now()).toISOString();
  }
}
