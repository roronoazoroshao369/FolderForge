import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, appendFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RiskLevel } from '../core/types.js';
import { logger } from '../core/logger.js';

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** SHA-256 of canonical unredacted args, used only for exact retry matching. */
  argsFingerprint?: string;
  risk: RiskLevel;
  reason: string;
  state: ApprovalState;
  createdAt: number;
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
}

/**
 * Approval queue. The dashboard reads/resolves these.
 *
 * Session-scoped approvals remember the tool name so repeated calls pass within
 * the same session. When constructed with a `persistPath`, every state change is
 * appended to an append-only JSONL log and replayed on startup so pending and
 * resolved approvals survive a restart.
 */
export class ApprovalEngine {
  private requests = new Map<string, ApprovalRequest>();
  private sessionAllowed = new Set<string>();
  private persistPath: string | undefined;
  private restoreSession: boolean;
  private sanitizeArgs: (args: Record<string, unknown>) => Record<string, unknown>;

  constructor(opts: ApprovalEngineOptions = {}) {
    this.persistPath = opts.persistPath;
    this.restoreSession = opts.restoreSession ?? false;
    this.sanitizeArgs = opts.sanitizeArgs ?? ((args) => JSON.parse(JSON.stringify(args)) as Record<string, unknown>);
    if (this.persistPath) this.load();
  }

  create(tool: string, args: Record<string, unknown>, risk: RiskLevel, reason: string): ApprovalRequest {
    const req: ApprovalRequest = {
      id: `appr_${randomUUID().slice(0, 8)}`,
      tool,
      args: this.sanitizeArgs(boundedEvidence(args) as Record<string, unknown>),
      argsFingerprint: fingerprint(args),
      risk,
      reason,
      state: 'pending',
      createdAt: Date.now(),
      scope: 'once',
    };
    this.requests.set(req.id, req);
    this.append(req);
    return req;
  }

  isSessionAllowed(tool: string): boolean {
    return this.sessionAllowed.has(tool);
  }

  /** Consume one approved one-shot request matching the exact tool and args. */
  consumeOnce(tool: string, args: Record<string, unknown>): boolean {
    const requestedFingerprint = fingerprint(args);
    const match = [...this.requests.values()]
      .filter(
        (request) =>
          request.tool === tool &&
          request.state === 'approved' &&
          request.scope === 'once' &&
          request.consumedAt === undefined &&
          (request.argsFingerprint ?? fingerprint(request.args)) === requestedFingerprint
      )
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!match) return false;
    match.consumedAt = Date.now();
    this.append(match);
    return true;
  }

  approve(id: string, scope: 'once' | 'session' = 'once'): ApprovalRequest | undefined {
    const req = this.requests.get(id);
    if (!req || req.state !== 'pending') return req;
    req.state = 'approved';
    req.scope = scope;
    req.resolvedAt = Date.now();
    if (scope === 'session') this.sessionAllowed.add(req.tool);
    this.append(req);
    return req;
  }

  deny(id: string): ApprovalRequest | undefined {
    const req = this.requests.get(id);
    if (!req || req.state !== 'pending') return req;
    req.state = 'denied';
    req.resolvedAt = Date.now();
    this.append(req);
    return req;
  }

  get(id: string): ApprovalRequest | undefined {
    return this.requests.get(id);
  }

  pending(): ApprovalRequest[] {
    return [...this.requests.values()].filter((r) => r.state === 'pending');
  }

  all(): ApprovalRequest[] {
    return [...this.requests.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Replay the persisted JSONL log. Each line is the latest snapshot of one
   * request keyed by id, so later lines overwrite earlier ones. After loading
   * we compact the file to one line per request to keep it from growing forever.
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
          // Migrate legacy records without retaining raw arguments: fingerprint
          // first, then sanitize before the next atomic compaction.
          req.argsFingerprint ??= fingerprint(req.args);
          req.args = this.sanitizeArgs(boundedEvidence(req.args) as Record<string, unknown>);
          this.requests.set(req.id, req);
          loaded++;
        }
      } catch {
        // Skip corrupt lines rather than failing startup.
      }
    }
    if (this.restoreSession) {
      for (const req of this.requests.values()) {
        if (req.state === 'approved' && req.scope === 'session') {
          this.sessionAllowed.add(req.tool);
        }
      }
    }
    logger.info({ path, loaded }, 'Loaded persisted approvals');
    this.compact();
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
