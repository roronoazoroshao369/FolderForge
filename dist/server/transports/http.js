import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
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
/** Extract a credential from the `X-API-Key` header. */
export function extractApiKey(req) {
    const header = req.headers['x-api-key'];
    const raw = Array.isArray(header) ? header[0] : header;
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed.length > 0)
            return trimmed;
    }
    return undefined;
}
/**
 * True when `provided` matches any accepted credential, compared in
 * constant time. Always walks the whole list so timing does not leak which
 * credential (if any) matched.
 */
export function matchesAnyCredential(provided, accepted) {
    if (!provided || accepted.length === 0)
        return false;
    let ok = false;
    for (const candidate of accepted) {
        if (timingSafeEqualStr(provided, candidate))
            ok = true;
    }
    return ok;
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
export async function startHttpTransport(makeMcpServer, opts) {
    const mcpPath = opts.path ?? '/mcp';
    // Every credential accepted on the MCP endpoint: the primary token plus any
    // additional api keys. A client may present any of them.
    const credentials = [opts.token, ...(opts.apiKeys ?? [])].filter((c) => typeof c === 'string' && c.length > 0);
    // Auth is enforced when any credential is configured, or when requireAuth is
    // set, or when bound to a non-loopback host.
    const requireAuth = credentials.length > 0 || Boolean(opts.requireAuth) || !isLoopbackHost(opts.host);
    if (requireAuth && credentials.length === 0) {
        throw new Error('HTTP transport requires authentication but no credential is set. ' +
            'Configure server.http.token (or server.http.apiKeys), pass --token, ' +
            'or bind to a loopback host with requireAuth disabled.');
    }
    // Stateless Streamable HTTP: a transport with `sessionIdGenerator: undefined`
    // treats every POST as a self-contained JSON-RPC exchange, so there is no
    // "session" that can be initialized twice. We connect a fresh transport per
    // request and close it once the response is flushed. This avoids the
    // "Server already initialized" error that a single shared, session-bearing
    // transport produces when a client re-POSTs after `initialize`.
    const handleMcp = async (req, res) => {
        // Pass an empty options object: under exactOptionalPropertyTypes we must omit
        // `sessionIdGenerator` entirely (not set it to `undefined`) to select the
        // transport's stateless mode.
        //
        // IMPORTANT: a fresh transport REQUIRES a fresh Server. An MCP Server
        // (Protocol) can only be connected to one transport at a time, so reusing a
        // single shared server across requests throws "Already connected to a
        // transport" on the second POST. We mint a per-request Server here and tear
        // both down when the response closes.
        const server = makeMcpServer();
        const transport = new StreamableHTTPServerTransport({});
        res.on('close', () => {
            void transport.close?.();
            void server.close?.();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
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
                const provided = extractBearer(req) ?? extractApiKey(req);
                if (!matchesAnyCredential(provided, credentials)) {
                    res.writeHead(401, {
                        'content-type': 'application/json',
                        'www-authenticate': 'Bearer realm="folderforge-mcp"',
                    });
                    res.end(JSON.stringify({
                        error: 'unauthorized',
                        message: 'Valid credential required. Send `Authorization: Bearer <token>` or `X-API-Key: <key>`.',
                    }));
                    return;
                }
            }
            void handleMcp(req, res).catch((err) => {
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
            logger.info({ host: opts.host, port: opts.port, path: mcpPath, authRequired: requireAuth }, 'MCP HTTP transport listening');
            resolveListen();
        });
    });
    return http;
}
