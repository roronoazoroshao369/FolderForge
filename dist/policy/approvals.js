import { randomUUID } from 'node:crypto';
/**
 * In-memory approval queue. The dashboard reads/resolves these.
 * Session-scoped approvals remember the tool name so repeated calls pass.
 */
export class ApprovalEngine {
    requests = new Map();
    sessionAllowed = new Set();
    create(tool, args, risk, reason) {
        const req = {
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
    isSessionAllowed(tool) {
        return this.sessionAllowed.has(tool);
    }
    approve(id, scope = 'once') {
        const req = this.requests.get(id);
        if (!req || req.state !== 'pending')
            return req;
        req.state = 'approved';
        req.scope = scope;
        req.resolvedAt = Date.now();
        if (scope === 'session')
            this.sessionAllowed.add(req.tool);
        return req;
    }
    deny(id) {
        const req = this.requests.get(id);
        if (!req || req.state !== 'pending')
            return req;
        req.state = 'denied';
        req.resolvedAt = Date.now();
        return req;
    }
    get(id) {
        return this.requests.get(id);
    }
    pending() {
        return [...this.requests.values()].filter((r) => r.state === 'pending');
    }
    all() {
        return [...this.requests.values()].sort((a, b) => b.createdAt - a.createdAt);
    }
}
