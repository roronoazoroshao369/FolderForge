import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, appendFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RiskLevel } from '../core/types.js';
import { logger } from '../core/logger.js';

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired';
export type ApprovalResolutionErrorCode = 'self_approval' | 'expired';

export class ApprovalResolutionError extends Error {
  constructor(
    readonly code: ApprovalResolutionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ApprovalResolutionError';
  }
}

export interface ApprovalRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** SHA-256 of canonical unredacted args, used only for exact retry matching. */
  argsFingerprint?: string;
  risk: RiskLevel;
  reason: string;
  state: ApprovalState;
  requesterId: string;
  approverId?: string;
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number;
  consumedAt?: number;
  scope: 'once' | 'session';
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(args: Record<string, unknown>): string {
  return `sha256:${createHash('sha256').update(canonical(args)).digest('hex')}`;
}

function boundedEvidence(value: unknown, depth = 0): unknown {
  if (depth >= 5) return '[TRUNCATED: depth]';
  if (typeof value === 'string') {
    return value.length > 1024 ? `${value.slice(0, 1024)}…[TRUNCATED]` : value;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item) => boundedEvidence(item, depth + 1));
    if (value.length > 20) items.push(`[TRUNCATED: ${value.length - 20} items]`);
    return items;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const bounded = Object.fromEntries(
      entries.slice(0, 20).map(([key, child]) => [key, boundedEvidence(child, depth + 1)])
    );
    if (entries.length > 20) bounded.__truncated = `${entries.length - 20} fields`;
    return bounded;
  }
  return value;
}

export interface ApprovalEngineOptions {
  /**
   * Path to a JSONL file used to persist approvals across restarts. When omitted
   * the engine stays purely in-memory (previous behaviour, used by unit tests).
   */
  persistPath?: string;
  /**
   * Re-arm session-scoped allowances from persisted state on load. Defaults to
   * false: a fresh process starts a fresh session, so session approvals from a
   * previous run must be re-granted. Persisted records are still loaded for
   * audit/history regardless.
   */
  restoreSession?: boolean;
  /** Redact structured args before they are retained or persisted. */
  sanitizeArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
  /** Lifetime for newly-created pending requests. Defaults to 15 minutes. */
  approvalTtlMs?: number;
  /** Injectable clock for deterministic expiry tests. */
  now?: () => number;
}

/**
 * Approval queue. Only the admin control plane may resolve requests.
 *
 * Every request is bound to its requester principal, exact canonical arguments,
 * and an expiry. A session allowance is scoped to requester + tool; a once
 * allowance is scoped to requester + tool + arguments and consumed exactly once.
 */
export class ApprovalEngine {
  private requests = new Map<string, ApprovalRequest>();
  private sessionAllowed = new Set<string>();
  private persistPath: string | undefined;
  private restoreSession: boolean;
  private sanitizeArgs: (args: Record<string, unknown>) => Record<string, unknown>;
  private approvalTtlMs: number;
  private now: () => number;

  constructor(opts: ApprovalEngineOptions = {}) {
    this.persistPath = opts.persistPath;
    this.restoreSession = opts.restoreSession ?? false;
    this.sanitizeArgs = opts.sanitizeArgs ?? ((args) => JSON.parse(JSON.stringify(args)) as Record<string, unknown>);
    this.approvalTtlMs = opts.approvalTtlMs ?? 15 * 60 * 1000;
    this.now = opts.now ?? Date.now;
    if (this.persistPath) this.load();
  }

  create(
    tool: string,
    args: Record<string, unknown>,
    risk: RiskLevel,
    reason: string,
    requesterId = 'agent:unknown'
  ): ApprovalRequest {
    const createdAt = this.now();
    const req: ApprovalRequest = {
      id: `appr_${randomUUID().slice(0, 8)}`,
      tool,
      args: this.sanitizeArgs(boundedEvidence(args) as Record<string, unknown>),
      argsFingerprint: fingerprint(args),
      risk,
      reason,
      state: 'pending',
      requesterId,
      createdAt,
      expiresAt: createdAt + this.approvalTtlMs,
      scope: 'once',
    };
    this.requests.set(req.id, req);
    this.append(req);
    return req;
  }

  isSessionAllowed(tool: string, requesterId = 'agent:unknown'): boolean {
    return this.sessionAllowed.has(this.sessionKey(tool, requesterId));
  }

  /** Consume one approved request matching requester, exact tool, and exact args. */
  consumeOnce(
    tool: string,
    args: Record<string, unknown>,
    requesterId = 'agent:unknown'
  ): boolean {
    const requestedFingerprint = fingerprint(args);
    const match = [...this.requests.values()]
      .filter(
        (request) =>
          request.requesterId === requesterId &&
          request.tool === tool &&
          request.state === 'approved' &&
          request.scope === 'once' &&
          request.consumedAt === undefined &&
          (request.argsFingerprint ?? fingerprint(request.args)) === requestedFingerprint
      )
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!match) return false;
    match.consumedAt = this.now();
    this.append(match);
    return true;
  }

  approve(
    id: string,
    scope: 'once' | 'session' = 'once',
    approverId = 'admin:unknown'
  ): ApprovalRequest | undefined {
    const req = this.requests.get(id);
    if (!req) return undefined;
    this.expireIfNeeded(req);
    if (req.state === 'expired') {
      throw new ApprovalResolutionError('expired', `Approval ${id} expired at ${new Date(req.expiresAt).toISOString()}.`);
    }
    if (req.state !== 'pending') return req;
    if (req.requesterId === approverId) {
      throw new ApprovalResolutionError(
        'self_approval',
        `Principal ${approverId} cannot approve its own request ${id}.`
      );
    }
    req.state = 'approved';
    req.scope = scope;
    req.approverId = approverId;
    req.resolvedAt = this.now();
    if (scope === 'session') {
      this.sessionAllowed.add(this.sessionKey(req.tool, req.requesterId));
    }
    this.append(req);
    return req;
  }

  deny(id: string, approverId = 'admin:unknown'): ApprovalRequest | undefined {
    const req = this.requests.get(id);
    if (!req) return undefined;
    this.expireIfNeeded(req);
    if (req.state === 'expired') {
      throw new ApprovalResolutionError('expired', `Approval ${id} expired at ${new Date(req.expiresAt).toISOString()}.`);
    }
    if (req.state !== 'pending') return req;
    req.state = 'denied';
    req.approverId = approverId;
    req.resolvedAt = this.now();
    this.append(req);
    return req;
  }

  get(id: string): ApprovalRequest | undefined {
    const req = this.requests.get(id);
    if (req) this.expireIfNeeded(req);
    return req;
  }

  pending(): ApprovalRequest[] {
    this.expirePending();
    return [...this.requests.values()].filter((r) => r.state === 'pending');
  }

  all(): ApprovalRequest[] {
    this.expirePending();
    return [...this.requests.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Replay the persisted JSONL log. Each line is the latest snapshot of one
   * request keyed by id, so later lines overwrite earlier ones. Legacy records
   * receive a conservative requester id and expiry before atomic compaction.
   */
  private load(): void {
    const path = this.persistPath;
    if (!path || !existsSync(path)) return;
    let lines: string[];
    try {
      lines = readFileSync(path, 'utf8').split('\n');
    } catch (err) {
      logger.warn({ path, err: String(err) }, 'Failed to read approvals store; starting empty');
      return;
    }
    let loaded = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const req = JSON.parse(trimmed) as ApprovalRequest;
        if (req && typeof req.id === 'string' && req.args && typeof req.args === 'object') {
          req.argsFingerprint ??= fingerprint(req.args);
          req.args = this.sanitizeArgs(boundedEvidence(req.args) as Record<string, unknown>);
          req.requesterId ??= 'legacy:unknown';
          req.expiresAt ??= req.createdAt + this.approvalTtlMs;
          this.requests.set(req.id, req);
          loaded++;
        }
      } catch {
        // Skip corrupt lines rather than failing startup.
      }
    }
    this.expirePending(false);
    if (this.restoreSession) {
      for (const req of this.requests.values()) {
        if (req.state === 'approved' && req.scope === 'session') {
          this.sessionAllowed.add(this.sessionKey(req.tool, req.requesterId));
        }
      }
    }
    logger.info({ path, loaded }, 'Loaded persisted approvals');
    this.compact();
  }

  private expirePending(append = true): void {
    for (const req of this.requests.values()) this.expireIfNeeded(req, append);
  }

  private expireIfNeeded(req: ApprovalRequest, append = true): void {
    if (req.state !== 'pending' || this.now() < req.expiresAt) return;
    req.state = 'expired';
    req.resolvedAt = this.now();
    if (append) this.append(req);
  }

  private sessionKey(tool: string, requesterId: string): string {
    return `${requesterId}\u0000${tool}`;
  }

  /** Append the current snapshot of one request to the JSONL log. */
  private append(req: ApprovalRequest): void {
    const path = this.persistPath;
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(req) + '\n', { encoding: 'utf8', mode: 0o600 });
      chmodSync(path, 0o600);
    } catch (err) {
      logger.warn({ path, id: req.id, err: String(err) }, 'Failed to persist approval');
    }
  }

  /** Rewrite the log with exactly one current line per request (atomic). */
  private compact(): void {
    const path = this.persistPath;
    if (!path) return;
    try {
      const body = [...this.requests.values()].map((r) => JSON.stringify(r)).join('\n');
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, body ? body + '\n' : '', { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, path);
      chmodSync(path, 0o600);
    } catch (err) {
      logger.warn({ path, err: String(err) }, 'Failed to compact approvals store');
    }
  }
}
