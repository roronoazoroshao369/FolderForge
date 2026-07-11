import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, appendFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../core/logger.js';
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
 * Approval queue. The dashboard reads/resolves these.
 *
 * Session-scoped approvals remember the tool name so repeated calls pass within
 * the same session. When constructed with a `persistPath`, every state change is
 * appended to an append-only JSONL log and replayed on startup so pending and
 * resolved approvals survive a restart.
 */
export class ApprovalEngine {
    requests = new Map();
    sessionAllowed = new Set();
    persistPath;
    restoreSession;
    sanitizeArgs;
    constructor(opts = {}) {
        this.persistPath = opts.persistPath;
        this.restoreSession = opts.restoreSession ?? false;
        this.sanitizeArgs = opts.sanitizeArgs ?? ((args) => JSON.parse(JSON.stringify(args)));
        if (this.persistPath)
            this.load();
    }
    create(tool, args, risk, reason) {
        const req = {
            id: `appr_${randomUUID().slice(0, 8)}`,
            tool,
            args: this.sanitizeArgs(boundedEvidence(args)),
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
    isSessionAllowed(tool) {
        return this.sessionAllowed.has(tool);
    }
    /** Consume one approved one-shot request matching the exact tool and args. */
    consumeOnce(tool, args) {
        const requestedFingerprint = fingerprint(args);
        const match = [...this.requests.values()]
            .filter((request) => request.tool === tool &&
            request.state === 'approved' &&
            request.scope === 'once' &&
            request.consumedAt === undefined &&
            (request.argsFingerprint ?? fingerprint(request.args)) === requestedFingerprint)
            .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!match)
            return false;
        match.consumedAt = Date.now();
        this.append(match);
        return true;
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
        this.append(req);
        return req;
    }
    deny(id) {
        const req = this.requests.get(id);
        if (!req || req.state !== 'pending')
            return req;
        req.state = 'denied';
        req.resolvedAt = Date.now();
        this.append(req);
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
    /**
     * Replay the persisted JSONL log. Each line is the latest snapshot of one
     * request keyed by id, so later lines overwrite earlier ones. After loading
     * we compact the file to one line per request to keep it from growing forever.
     */
    load() {
        const path = this.persistPath;
        if (!path || !existsSync(path))
            return;
        let lines;
        try {
            lines = readFileSync(path, 'utf8').split('\n');
        }
        catch (err) {
            logger.warn({ path, err: String(err) }, 'Failed to read approvals store; starting empty');
            return;
        }
        let loaded = 0;
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                const req = JSON.parse(trimmed);
                if (req && typeof req.id === 'string' && req.args && typeof req.args === 'object') {
                    // Migrate legacy records without retaining raw arguments: fingerprint
                    // first, then sanitize before the next atomic compaction.
                    req.argsFingerprint ??= fingerprint(req.args);
                    req.args = this.sanitizeArgs(boundedEvidence(req.args));
                    this.requests.set(req.id, req);
                    loaded++;
                }
            }
            catch {
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
    append(req) {
        const path = this.persistPath;
        if (!path)
            return;
        try {
            mkdirSync(dirname(path), { recursive: true });
            appendFileSync(path, JSON.stringify(req) + '\n', { encoding: 'utf8', mode: 0o600 });
            chmodSync(path, 0o600);
        }
        catch (err) {
            logger.warn({ path, id: req.id, err: String(err) }, 'Failed to persist approval');
        }
    }
    /** Rewrite the log with exactly one current line per request (atomic). */
    compact() {
        const path = this.persistPath;
        if (!path)
            return;
        try {
            const body = [...this.requests.values()].map((r) => JSON.stringify(r)).join('\n');
            const tmp = `${path}.tmp`;
            writeFileSync(tmp, body ? body + '\n' : '', { encoding: 'utf8', mode: 0o600 });
            renameSync(tmp, path);
            chmodSync(path, 0o600);
        }
        catch (err) {
            logger.warn({ path, err: String(err) }, 'Failed to compact approvals store');
        }
    }
}
