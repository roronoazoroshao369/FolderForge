/**
 * Quick-tunnel manager (ADR-0012, Phase 3).
 *
 * Exposes a local port through a `cloudflared` quick tunnel. Tunnels are
 * spawned through ProcessManager (injected here), so Mission Control process
 * containment applies unchanged. Quick tunnels are PUBLIC by nature: the
 * agent-facing tool that starts one is HIGH risk and policy-gated, and no
 * credentials are stored anywhere in tunnel state.
 */

import { randomUUID } from 'node:crypto';

export type TunnelState = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface TunnelRecord {
  id: string;
  targetPort: number;
  targetUrl: string;
  publicUrl?: string;
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

export interface TunnelManagerOptions {
  spawn?: TunnelSpawner;
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
