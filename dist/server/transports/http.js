import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from '../../core/logger.js';
/** True when the bind host is loopback-only and therefore safe without a token. */
export function isLoopbackHost(host) {
    return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
/** Constant-time string comparison that tolerates length differences. */
export function timingSafeEqualStr(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) {
        // Still compare against self to keep timing roughly constant.
        timingSafeEqual(ab, ab);
        return false;
    }
    return timingSafeEqual(ab, bb);
}
/** Extract a bearer token from the Authorization header. */
export function extractBearer(req) {
    const header = req.headers['authorization'];
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
        return header.slice('Bearer '.length).trim();
    }
    return undefined;
}
/**
 * Resolve the CORS origin header value for a request, or null to omit it.
 * `['*']` echoes any origin (so credentials can still work); a concrete list
 * echoes only matching origins.
 */
export function resolveCorsOrigin(requestOrigin, allowed) {
    if (!allowed || allowed.length === 0)
        return null;
    if (allowed.includes('*'))
        return requestOrigin ?? '*';
    if (requestOrigin && allowed.includes(requestOrigin))
        return requestOrigin;
    return null;
}
/**
 * Bind the MCP server to a hardened Streamable HTTP transport.
 *
 * Hardening over the bare transport:
 *  - Bearer-token auth (constant-time) when a token is configured.
 *  - CORS handling with an explicit allowlist + preflight support.
 *  - Idle session expiry: the underlying transport is recreated after
 *    `sessionTtlMs` of inactivity so stale sessions don't linger.
 */
export async function startHttpTransport(server, opts) {
    const mcpPath = opts.path ?? '/mcp';
    const ttl = opts.sessionTtlMs ?? 30 * 60 * 1000; // 30 min default
    const requireAuth = Boolean(opts.token);
    if (!isLoopbackHost(opts.host) && !opts.token) {
        throw new Error('HTTP transport bound to a non-loopback host requires server.http.token');
    }
    let transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    await server.connect(transport);
    let lastActivity = Date.now();
    // Recreate the transport (and reconnect the server) when it has been idle past
    // the TTL, expiring any stale session id.
    const refreshIfIdle = async () => {
        if (Date.now() - lastActivity > ttl) {
            try {
                await transport.close?.();
            }
            catch {
                // ignore close errors
            }
            transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
            await server.connect(transport);
            logger.info({ ttlMs: ttl }, 'HTTP MCP session expired after idle TTL; rotated transport');
        }
        lastActivity = Date.now();
    };
    const applyCors = (req, res) => {
        const origin = resolveCorsOrigin(req.headers.origin, opts.corsOrigins);
        if (origin) {
            res.setHeader('access-control-allow-origin', origin);
            res.setHeader('vary', 'Origin');
            res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
            res.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-session-id');
        }
    };
    const http = createServer((req, res) => {
        const url = req.url ?? '/';
        applyCors(req, res);
        // CORS preflight.
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.method === 'GET' && url === '/healthz') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (url === mcpPath || url.startsWith(`${mcpPath}?`)) {
            if (requireAuth) {
                const provided = extractBearer(req);
                if (!provided || !timingSafeEqualStr(provided, opts.token)) {
                    res.writeHead(401, {
                        'content-type': 'application/json',
                        'www-authenticate': 'Bearer realm="folderforge-mcp"',
                    });
                    res.end(JSON.stringify({ error: 'unauthorized', message: 'Valid bearer token required.' }));
                    return;
                }
            }
            void refreshIfIdle()
                .then(() => transport.handleRequest(req, res))
                .catch((err) => {
                logger.error({ err: String(err) }, 'HTTP MCP request failed');
                if (!res.headersSent) {
                    res.writeHead(500, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: 'internal_error' }));
                }
            });
            return;
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
    });
    await new Promise((resolveListen) => {
        http.listen(opts.port, opts.host, () => {
            logger.info({ host: opts.host, port: opts.port, path: mcpPath, authRequired: requireAuth, sessionTtlMs: ttl }, 'MCP HTTP transport listening');
            resolveListen();
        });
    });
    return http;
}
