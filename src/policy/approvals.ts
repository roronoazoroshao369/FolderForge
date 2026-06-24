import { randomUUID } from 'node:crypto';
import type { RiskLevel } from '../core/types.js';

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  risk: RiskLevel;
  reason: string;
  state: ApprovalState;
  createdAt: number;
  resolvedAt?: number;
  scope: 'once' | 'session';
}

/**
 * In-memory approval queue. The dashboard reads/resolves these.
 * Session-scoped approvals remember the tool name so repeated calls pass.
 */
export class ApprovalEngine {
  private requests = new Map<string, ApprovalRequest>();
  private sessionAllowed = new Set<string>();

  create(tool: string, args: Record<string, unknown>, risk: RiskLevel, reason: string): ApprovalRequest {
    const req: ApprovalRequest = {
      id: `appr_${randomUUID().slice(0, 8)}`,
      tool,
      args,
      risk,
      reason,
      state: 'pending',
      createdAt: Date.now(),
      scope: 'once',
    };
    this.requests.set(req.id, req);
    return req;
  }

  isSessionAllowed(tool: string): boolean {
    return this.sessionAllowed.has(tool);
  }

  approve(id: string, scope: 'once' | 'session' = 'once'): ApprovalRequest | undefined {
    const req = this.requests.get(id);
    if (!req || req.state !== 'pending') return req;
    req.state = 'approved';
    req.scope = scope;
    req.resolvedAt = Date.now();
    if (scope === 'session') this.sessionAllowed.add(req.tool);
    return req;
  }

  deny(id: string): ApprovalRequest | undefined {
    const req = this.requests.get(id);
    if (!req || req.state !== 'pending') return req;
    req.state = 'denied';
    req.resolvedAt = Date.now();
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
}
