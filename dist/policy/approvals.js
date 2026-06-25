import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, appendFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../core/logger.js';
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
    constructor(opts = {}) {
        this.persistPath = opts.persistPath;
        this.restoreSession = opts.restoreSession ?? false;
        if (this.persistPath)
            this.load();
    }
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
        this.append(req);
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
                if (req && typeof req.id === 'string') {
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
            appendFileSync(path, JSON.stringify(req) + '\n', 'utf8');
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
            writeFileSync(tmp, body ? body + '\n' : '', 'utf8');
            renameSync(tmp, path);
        }
        catch (err) {
            logger.warn({ path, err: String(err) }, 'Failed to compact approvals store');
        }
    }
}
