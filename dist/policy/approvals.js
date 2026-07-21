import { createHash, randomUUID } from 'node:crypto';
import { logger } from '../core/logger.js';
import { FileSnapshotStore } from '../evidence/file-stores.js';
export class ApprovalResolutionError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'ApprovalResolutionError';
    }
}
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}
function fingerprint(args) {
    return `sha256:${createHash('sha256').update(canonical(args)).digest('hex')}`;
}
function approvalBinding(requester) {
    const principal = typeof requester === 'string'
        ? { id: requester, role: 'agent' }
        : requester;
    return {
        principalId: principal.id,
        ...(principal.oauthClientId ? { clientId: principal.oauthClientId } : {}),
        ...(principal.projectId ? { projectId: principal.projectId } : {}),
        ...(principal.sessionId ? { sessionId: principal.sessionId } : {}),
        ...(principal.capsuleId ? { capsuleId: principal.capsuleId } : {}),
        ...(principal.taskId ? { taskId: principal.taskId } : {}),
    };
}
function bindingKey(binding) {
    const contextual = Object.keys(binding).some((key) => key !== 'principalId');
    if (!contextual)
        return binding.principalId;
    return `binding:sha256:${createHash('sha256').update(canonical(binding)).digest('hex')}`;
}
function boundedEvidence(value, depth = 0) {
    if (depth >= 5)
        return '[TRUNCATED: depth]';
    if (typeof value === 'string') {
        return value.length > 1024 ? `${value.slice(0, 1024)}…[TRUNCATED]` : value;
    }
    if (Array.isArray(value)) {
        const items = value.slice(0, 20).map((item) => boundedEvidence(item, depth + 1));
        if (value.length > 20)
            items.push(`[TRUNCATED: ${value.length - 20} items]`);
        return items;
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value);
        const bounded = Object.fromEntries(entries.slice(0, 20).map(([key, child]) => [key, boundedEvidence(child, depth + 1)]));
        if (entries.length > 20)
            bounded.__truncated = `${entries.length - 20} fields`;
        return bounded;
    }
    return value;
}
/**
 * Approval queue. Only the admin control plane may resolve requests.
 *
 * Every request is bound to its requester principal, exact canonical arguments,
 * and an expiry. A session allowance is scoped to requester + tool; a once
 * allowance is scoped to requester + tool + arguments and consumed exactly once.
 */
export class ApprovalEngine {
    requests = new Map();
    sessionAllowed = new Set();
    persistPath;
    store;
    restoreSession;
    sanitizeArgs;
    approvalTtlMs;
    now;
    constructor(opts = {}) {
        this.persistPath = opts.persistPath;
        this.store =
            opts.store ??
                (opts.persistPath
                    ? new FileSnapshotStore(opts.persistPath, validateApprovalRecord)
                    : undefined);
        this.restoreSession = opts.restoreSession ?? false;
        this.sanitizeArgs = opts.sanitizeArgs ?? ((args) => JSON.parse(JSON.stringify(args)));
        this.approvalTtlMs = opts.approvalTtlMs ?? 15 * 60 * 1000;
        this.now = opts.now ?? Date.now;
        if (this.store)
            this.load();
    }
    create(tool, args, risk, reason, requester = 'agent:unknown') {
        const createdAt = this.now();
        const binding = approvalBinding(requester);
        const requesterKey = bindingKey(binding);
        const req = {
            id: `appr_${randomUUID().slice(0, 8)}`,
            tool,
            args: this.sanitizeArgs(boundedEvidence(args)),
            argsFingerprint: fingerprint(args),
            risk,
            reason,
            state: 'pending',
            requesterId: binding.principalId,
            binding,
            requesterKey,
            createdAt,
            expiresAt: createdAt + this.approvalTtlMs,
            scope: 'once',
        };
        this.append(req);
        this.requests.set(req.id, req);
        return req;
    }
    isSessionAllowed(tool, requester = 'agent:unknown') {
        return this.sessionAllowed.has(this.sessionKey(tool, bindingKey(approvalBinding(requester))));
    }
    /** Consume one approved request matching requester, exact tool, and exact args. */
    consumeOnce(tool, args, requester = 'agent:unknown') {
        const requestedFingerprint = fingerprint(args);
        const requesterKey = bindingKey(approvalBinding(requester));
        const match = [...this.requests.values()]
            .filter((request) => (request.requesterKey ?? request.requesterId) === requesterKey &&
            request.tool === tool &&
            request.state === 'approved' &&
            request.scope === 'once' &&
            request.consumedAt === undefined &&
            (request.argsFingerprint ?? fingerprint(request.args)) === requestedFingerprint)
            .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!match)
            return false;
        const previousConsumedAt = match.consumedAt;
        match.consumedAt = this.now();
        try {
            this.append(match);
        }
        catch (error) {
            if (previousConsumedAt === undefined)
                delete match.consumedAt;
            else
                match.consumedAt = previousConsumedAt;
            throw error;
        }
        return true;
    }
    approve(id, scope = 'once', approverId = 'admin:unknown') {
        const req = this.requests.get(id);
        if (!req)
            return undefined;
        this.expireIfNeeded(req);
        if (req.state === 'expired') {
            throw new ApprovalResolutionError('expired', `Approval ${id} expired at ${new Date(req.expiresAt).toISOString()}.`);
        }
        if (req.state !== 'pending')
            return req;
        if (req.requesterId === approverId) {
            throw new ApprovalResolutionError('self_approval', `Principal ${approverId} cannot approve its own request ${id}.`);
        }
        const previous = snapshotApproval(req);
        const sessionKey = this.sessionKey(req.tool, req.requesterKey ?? req.requesterId);
        const sessionWasAllowed = this.sessionAllowed.has(sessionKey);
        req.state = 'approved';
        req.scope = scope;
        req.approverId = approverId;
        req.resolvedAt = this.now();
        if (scope === 'session')
            this.sessionAllowed.add(sessionKey);
        try {
            this.append(req);
        }
        catch (error) {
            restoreApproval(req, previous);
            if (!sessionWasAllowed)
                this.sessionAllowed.delete(sessionKey);
            throw error;
        }
        return req;
    }
    deny(id, approverId = 'admin:unknown') {
        const req = this.requests.get(id);
        if (!req)
            return undefined;
        this.expireIfNeeded(req);
        if (req.state === 'expired') {
            throw new ApprovalResolutionError('expired', `Approval ${id} expired at ${new Date(req.expiresAt).toISOString()}.`);
        }
        if (req.state !== 'pending')
            return req;
        const previous = snapshotApproval(req);
        req.state = 'denied';
        req.approverId = approverId;
        req.resolvedAt = this.now();
        try {
            this.append(req);
        }
        catch (error) {
            restoreApproval(req, previous);
            throw error;
        }
        return req;
    }
    get(id) {
        const req = this.requests.get(id);
        if (req)
            this.expireIfNeeded(req);
        return req;
    }
    pending() {
        this.expirePending();
        return [...this.requests.values()].filter((r) => r.state === 'pending');
    }
    all() {
        this.expirePending();
        return [...this.requests.values()].sort((a, b) => b.createdAt - a.createdAt);
    }
    /**
     * Replay the persisted JSONL log. Each line is the latest snapshot of one
     * request keyed by id, so later lines overwrite earlier ones. Legacy records
     * receive a conservative requester id and expiry before atomic compaction.
     */
    load() {
        const records = this.store?.load() ?? [];
        for (const req of records) {
            req.argsFingerprint ??= fingerprint(req.args);
            req.args = this.sanitizeArgs(boundedEvidence(req.args));
            req.requesterId ??= 'legacy:unknown';
            req.binding ??= { principalId: req.requesterId };
            req.requesterKey ??= bindingKey(req.binding);
            req.expiresAt ??= req.createdAt + this.approvalTtlMs;
            this.requests.set(req.id, req);
        }
        this.expirePending(false);
        if (this.restoreSession) {
            for (const req of this.requests.values()) {
                if (req.state === 'approved' && req.scope === 'session') {
                    this.sessionAllowed.add(this.sessionKey(req.tool, req.requesterKey ?? req.requesterId));
                }
            }
        }
        logger.info({ path: this.persistPath ?? 'custom-store', loaded: records.length }, 'Loaded persisted approvals');
        this.compact();
    }
    expirePending(append = true) {
        for (const req of this.requests.values())
            this.expireIfNeeded(req, append);
    }
    expireIfNeeded(req, append = true) {
        if (req.state !== 'pending' || this.now() < req.expiresAt)
            return;
        const previous = snapshotApproval(req);
        req.state = 'expired';
        req.resolvedAt = this.now();
        if (!append)
            return;
        try {
            this.append(req);
        }
        catch (error) {
            restoreApproval(req, previous);
            throw error;
        }
    }
    sessionKey(tool, requesterKey) {
        return `${requesterKey}\u0000${tool}`;
    }
    /** Persist the current snapshot before reporting the state transition complete. */
    append(req) {
        this.store?.append(req);
    }
    /** Rewrite the store with exactly one current snapshot per request. */
    compact() {
        this.store?.replaceAll([...this.requests.values()]);
    }
}
function snapshotApproval(request) {
    return { ...request, args: { ...request.args } };
}
function restoreApproval(request, snapshot) {
    for (const key of Object.keys(request)) {
        delete request[key];
    }
    Object.assign(request, snapshot);
}
function validateApprovalRecord(value, location) {
    if (!value || typeof value !== 'object') {
        throw new Error(`${location} is not an approval object.`);
    }
    const record = value;
    if (typeof record.id !== 'string' ||
        typeof record.tool !== 'string' ||
        !record.args ||
        typeof record.args !== 'object' ||
        typeof record.createdAt !== 'number' ||
        !['pending', 'approved', 'denied', 'expired'].includes(String(record.state)) ||
        !['once', 'session'].includes(String(record.scope))) {
        throw new Error(`${location} does not match the approval record schema.`);
    }
    return record;
}
