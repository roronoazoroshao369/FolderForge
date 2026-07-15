import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { adminPrincipalFromCredential } from '../core/principal.js';
import { ApprovalResolutionError } from '../policy/approvals.js';
import { logger } from '../core/logger.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
/** True when the bind host is loopback-only and therefore safe without a token. */
export function isLoopbackHost(host) {
    return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
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
 *   POST /policy/mode             -> change runtime policy mode (admin only)
 */
export function startDashboard(container, registry, opts) {
    // Auth is enforced only when bound to a non-loopback address. A loopback bind
    // is treated as trusted (same machine), matching the default 127.0.0.1.
    const requireAuth = !isLoopbackHost(opts.host);
    if (requireAuth && !opts.token) {
        throw new Error('Dashboard bound to a non-loopback host requires a token');
    }
    const server = createServer((req, res) => {
        const credential = extractDashboardCredential(req);
        if (requireAuth && (!credential || !timingSafeEqualStr(credential, opts.token))) {
            res.writeHead(401, {
                'content-type': 'application/json; charset=utf-8',
                'www-authenticate': 'Bearer realm="folderforge-dashboard"',
            });
            res.end(JSON.stringify({ error: 'unauthorized', message: 'Valid bearer token required.' }));
            return;
        }
        const principal = adminPrincipalFromCredential(requireAuth ? credential : undefined);
        handle(req, res, container, registry, principal).catch((err) => {
            logger.error({ err: String(err) }, 'Dashboard request failed');
            sendJson(res, 500, { error: 'internal_error', message: String(err) });
        });
    });
    server.listen(opts.port, opts.host, () => {
        logger.info({ host: opts.host, port: opts.port, authRequired: requireAuth }, 'Dashboard listening');
    });
    return server;
}
/**
 * Accept the token via either `Authorization: Bearer <token>` or a `?token=`
 * query parameter (handy for opening the dashboard in a browser). Comparison is
 * constant-time to avoid leaking the token length/prefix via timing.
 */
function extractDashboardCredential(req) {
    const header = req.headers['authorization'];
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
        const credential = header.slice('Bearer '.length).trim();
        if (credential)
            return credential;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    return url.searchParams.get('token') ?? undefined;
}
function timingSafeEqualStr(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length)
        return false;
    return timingSafeEqual(ab, bb);
}
async function handle(req, res, container, registry, principal) {
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
        try {
            if (action === 'approve') {
                const scope = body?.scope === 'session' ? 'session' : 'once';
                result = container.policy.approvals.approve(id, scope, principal.id);
            }
            else {
                result = container.policy.approvals.deny(id, principal.id);
            }
        }
        catch (error) {
            if (error instanceof ApprovalResolutionError) {
                return sendJson(res, 409, { error: error.code, message: error.message, id });
            }
            throw error;
        }
        if (!result) {
            return sendJson(res, 404, { error: 'approval_not_found', id });
        }
        container.audit.record({
            type: 'approval_resolved',
            tool: result.tool,
            risk: result.risk,
            summary: `${action} (${result.state})`,
            detail: { approvalId: id, approverId: principal.id },
        });
        return sendJson(res, 200, { approval: result });
    }
    if (method === 'POST' && path === '/policy/mode') {
        const body = await readJsonBody(req);
        const mode = String(body?.mode ?? '');
        if (!['readonly', 'safe', 'dev', 'danger'].includes(mode)) {
            return sendJson(res, 400, { error: 'invalid_policy_mode', mode });
        }
        container.policy.setMode(mode);
        container.audit.record({
            type: 'policy_change',
            summary: `mode=${mode}`,
            detail: { actorId: principal.id, mode },
        });
        return sendJson(res, 200, { mode });
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
