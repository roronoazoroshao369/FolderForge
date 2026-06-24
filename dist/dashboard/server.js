import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { logger } from '../core/logger.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
/**
 * Local control-plane dashboard. Read-only views plus approval actions.
 *
 * Endpoints:
 *   GET  /            -> static dashboard (dashboard/static/index.html)
 *   GET  /status      -> server + workspace + policy snapshot
 *   GET  /audit       -> recent audit events
 *   GET  /processes   -> managed long-running processes
 *   GET  /approvals   -> pending + resolved approval requests
 *   POST /approvals/:id/approve  -> approve (body: { scope?: 'once'|'session' })
 *   POST /approvals/:id/deny     -> deny
 */
export function startDashboard(container, registry, opts) {
    const server = createServer((req, res) => {
        handle(req, res, container, registry).catch((err) => {
            logger.error({ err: String(err) }, 'Dashboard request failed');
            sendJson(res, 500, { error: 'internal_error', message: String(err) });
        });
    });
    server.listen(opts.port, opts.host, () => {
        logger.info({ host: opts.host, port: opts.port }, 'Dashboard listening');
    });
    return server;
}
async function handle(req, res, container, registry) {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
        return sendStatic(res);
    }
    if (method === 'GET' && path === '/status') {
        const active = container.workspace.getActive();
        return sendJson(res, 200, {
            server: {
                name: container.config.server.name,
                transport: container.config.server.transport,
            },
            workspace: {
                active: Boolean(active),
                projectRoot: container.projectRoot(),
                name: active?.name ?? null,
                languageHints: active?.languageHints ?? [],
                allowedDirectories: container.config.workspace.allowedDirectories,
            },
            policy: container.policy.describe(),
            tools: {
                active: registry.listActive().length,
                total: registry.listAll().length,
            },
        });
    }
    if (method === 'GET' && path === '/audit') {
        const limit = clampInt(url.searchParams.get('limit'), 50, 1, 500);
        return sendJson(res, 200, { entries: container.audit.recent(limit) });
    }
    if (method === 'GET' && path === '/processes') {
        return sendJson(res, 200, { processes: container.processes.list() });
    }
    if (method === 'GET' && path === '/approvals') {
        return sendJson(res, 200, {
            pending: container.policy.approvals.pending(),
            all: container.policy.approvals.all(),
        });
    }
    // POST /approvals/:id/approve | /approvals/:id/deny
    const approvalMatch = /^\/approvals\/([^/]+)\/(approve|deny)$/.exec(path);
    if (method === 'POST' && approvalMatch) {
        const id = approvalMatch[1];
        const action = approvalMatch[2];
        const body = await readJsonBody(req);
        let result;
        if (action === 'approve') {
            const scope = body?.scope === 'session' ? 'session' : 'once';
            result = container.policy.approvals.approve(id, scope);
        }
        else {
            result = container.policy.approvals.deny(id);
        }
        if (!result) {
            return sendJson(res, 404, { error: 'approval_not_found', id });
        }
        container.audit.record({
            type: 'approval_resolved',
            tool: result.tool,
            risk: result.risk,
            summary: `${action} (${result.state})`,
            detail: { approvalId: id },
        });
        return sendJson(res, 200, { approval: result });
    }
    sendJson(res, 404, { error: 'not_found', path });
}
function sendStatic(res) {
    const candidates = [
        join(__dirname, 'static', 'index.html'),
        join(process.cwd(), 'src', 'dashboard', 'static', 'index.html'),
    ];
    for (const file of candidates) {
        if (existsSync(file)) {
            const html = readFileSync(file, 'utf8');
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
            return;
        }
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Dashboard static asset not found');
}
function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body, null, 2));
}
async function readJsonBody(req) {
    return new Promise((resolveBody) => {
        let raw = '';
        req.on('data', (chunk) => {
            raw += chunk;
            if (raw.length > 1_000_000)
                req.destroy();
        });
        req.on('end', () => {
            if (!raw.trim())
                return resolveBody(null);
            try {
                resolveBody(JSON.parse(raw));
            }
            catch {
                resolveBody(null);
            }
        });
        req.on('error', () => resolveBody(null));
    });
}
function clampInt(value, fallback, min, max) {
    const n = value ? Number(value) : NaN;
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}
