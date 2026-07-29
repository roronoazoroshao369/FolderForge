import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from '../../core/logger.js';
import { agentPrincipalFromCredential, scopedSessionId } from '../../core/principal.js';
import { buildBearerChallenge, createOAuthRuntime, } from '../auth/oauth.js';
/** True when the bind host is loopback-only and therefore safe without a token. */
export function isLoopbackHost(host) {
    return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
/** Constant-time string comparison that tolerates length differences. */
export function timingSafeEqualStr(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) {
        timingSafeEqual(ab, ab);
        return false;
    }
    return timingSafeEqual(ab, bb);
}
/** Extract a bearer token from the Authorization header. */
export function extractBearer(req) {
    const header = req.headers.authorization;
    if (typeof header === 'string' && /^Bearer\s+/i.test(header)) {
        const value = header.replace(/^Bearer\s+/i, '').trim();
        return value || undefined;
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
/** Extract a single non-empty header value by normalized field name. */
export function extractHeaderValue(req, name) {
    const header = req.headers[name.toLowerCase()];
    const raw = Array.isArray(header) ? header[0] : header;
    if (typeof raw !== 'string')
        return undefined;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
/**
 * True when `provided` matches any accepted credential, compared in constant
 * time. Always walks the whole list so timing does not leak which credential
 * matched.
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
/** Resolve the CORS origin header value for a request, or null to omit it. */
export function resolveCorsOrigin(requestOrigin, allowed) {
    if (!allowed || allowed.length === 0)
        return null;
    if (allowed.includes('*'))
        return requestOrigin ?? '*';
    if (requestOrigin && allowed.includes(requestOrigin))
        return requestOrigin;
    return null;
}
const DEFAULT_SESSION_TTL_MS = 30 * 60_000;
const MAX_JSON_BODY_BYTES = 1_048_576;
async function readJsonBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > MAX_JSON_BODY_BYTES) {
            throw new Error(`MCP request body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
        }
        chunks.push(buffer);
    }
    if (total === 0)
        return undefined;
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function isInitializeRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
        return false;
    return body.method === 'initialize';
}
function sessionHeader(req) {
    const raw = req.headers['mcp-session-id'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function writeJson(res, status, body, headers = {}) {
    res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        ...headers,
    });
    res.end(JSON.stringify(body));
}
function oauthChallenge(runtime, options) {
    return buildBearerChallenge({
        resourceMetadataUrl: runtime.resourceMetadataUrl,
        scopes: options.scopes,
        ...(options.error ? { error: options.error } : {}),
        ...(options.errorDescription ? { errorDescription: options.errorDescription } : {}),
    });
}
/** Bind the MCP server to a hardened Streamable HTTP transport with durable sessions. */
export async function startHttpTransport(makeMcpServer, opts) {
    const mcpPath = opts.path ?? '/mcp';
    const credentials = [opts.token, ...(opts.apiKeys ?? [])].filter((credential) => typeof credential === 'string' && credential.length > 0);
    const legacyRequiresAuth = credentials.length > 0 || Boolean(opts.requireAuth) || !isLoopbackHost(opts.host);
    const authMode = opts.authMode ?? (opts.oauth ? 'oauth' : legacyRequiresAuth ? 'token' : 'none');
    if (authMode === 'none' && !isLoopbackHost(opts.host)) {
        throw new Error('HTTP auth mode none is only allowed on a loopback bind');
    }
    if (authMode === 'token' && credentials.length === 0) {
        throw new Error('HTTP token auth requires server.http.token or server.http.apiKeys; callers must provide a credential explicitly.');
    }
    if (authMode === 'oauth' && credentials.length > 0) {
        throw new Error('OAuth mode cannot be combined with static token/API-key credentials');
    }
    if (authMode !== 'oauth' && opts.oauth) {
        throw new Error(`OAuth configuration conflicts with HTTP auth mode ${authMode}`);
    }
    if (authMode === 'oauth' && !opts.oauth) {
        throw new Error('OAuth mode requires OAuth resource-server configuration');
    }
    const gatewayGuard = opts.gatewayGuard
        ? {
            header: opts.gatewayGuard.header.trim().toLowerCase(),
            token: opts.gatewayGuard.token,
        }
        : undefined;
    if (gatewayGuard) {
        if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(gatewayGuard.header)) {
            throw new Error('HTTP gateway guard header is invalid');
        }
        if (['authorization', 'cookie', 'host', 'content-length', 'proxy-authorization'].includes(gatewayGuard.header)) {
            throw new Error(`HTTP gateway guard header is reserved: ${gatewayGuard.header}`);
        }
        if (!gatewayGuard.token)
            throw new Error('HTTP gateway guard token must not be empty');
    }
    const oauthRuntime = authMode === 'oauth' ? await createOAuthRuntime(opts.oauth) : undefined;
    const instanceId = `http_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const startedAt = new Date().toISOString();
    const sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    if (!Number.isFinite(sessionTtlMs) || sessionTtlMs <= 0) {
        throw new Error('server.http.sessionTtlMs must be a positive finite number');
    }
    const sessions = new Map();
    const closeSession = async (id, reason) => {
        const session = sessions.get(id);
        if (!session)
            return;
        sessions.delete(id);
        await Promise.allSettled([session.transport.close(), session.server.close()]);
        logger.info({ instanceId, sessionId: id, reason }, 'MCP HTTP session closed');
    };
    const sweeper = setInterval(() => {
        const now = Date.now();
        for (const session of sessions.values()) {
            if (session.activeRequests === 0 && now - session.lastUsedAt >= sessionTtlMs) {
                void closeSession(session.id, 'idle_ttl');
            }
        }
    }, Math.min(Math.max(Math.floor(sessionTtlMs / 4), 25), 30_000));
    sweeper.unref();
    const createStatefulSession = async (principal) => {
        const id = randomUUID();
        const sessionPrincipal = {
            ...principal,
            sessionId: scopedSessionId(principal.id, id),
        };
        const server = makeMcpServer(sessionPrincipal);
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => id,
            onsessionclosed: () => {
                void closeSession(id, 'client_delete');
            },
        });
        const session = {
            id,
            principalId: principal.id,
            server,
            transport,
            lastUsedAt: Date.now(),
            activeRequests: 0,
        };
        sessions.set(id, session);
        try {
            await server.connect(transport);
            return session;
        }
        catch (error) {
            sessions.delete(id);
            await Promise.allSettled([transport.close(), server.close()]);
            throw error;
        }
    };
    const handleStateless = async (req, res, principal, parsedBody) => {
        const server = makeMcpServer(principal);
        const transport = new StreamableHTTPServerTransport({});
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, parsedBody);
        }
        finally {
            await Promise.allSettled([transport.close(), server.close()]);
        }
    };
    const handleMcp = async (req, res, principal) => {
        const requestedSessionId = sessionHeader(req);
        if (requestedSessionId) {
            const session = sessions.get(requestedSessionId);
            if (!session || session.principalId !== principal.id) {
                writeJson(res, 404, {
                    jsonrpc: '2.0',
                    id: null,
                    error: { code: -32001, message: 'MCP session not found or no longer valid' },
                });
                return;
            }
            session.activeRequests += 1;
            try {
                await session.transport.handleRequest(req, res);
            }
            finally {
                session.activeRequests = Math.max(0, session.activeRequests - 1);
                session.lastUsedAt = Date.now();
            }
            return;
        }
        if (req.method !== 'POST') {
            await handleStateless(req, res, principal);
            return;
        }
        let parsedBody;
        try {
            parsedBody = await readJsonBody(req);
        }
        catch (error) {
            writeJson(res, 400, {
                jsonrpc: '2.0',
                id: null,
                error: {
                    code: -32700,
                    message: error instanceof SyntaxError ? 'Invalid JSON request body' : String(error),
                },
            });
            return;
        }
        if (!isInitializeRequest(parsedBody)) {
            await handleStateless(req, res, principal, parsedBody);
            return;
        }
        const session = await createStatefulSession(principal);
        session.activeRequests += 1;
        try {
            await session.transport.handleRequest(req, res, parsedBody);
        }
        catch (error) {
            await closeSession(session.id, 'initialize_failed');
            throw error;
        }
        finally {
            session.activeRequests = Math.max(0, session.activeRequests - 1);
            session.lastUsedAt = Date.now();
        }
    };
    const applyCors = (req, res) => {
        const origin = resolveCorsOrigin(req.headers.origin, opts.corsOrigins);
        if (origin) {
            res.setHeader('access-control-allow-origin', origin);
            res.setHeader('vary', 'Origin');
            res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
            res.setHeader('access-control-allow-headers', [
                'authorization',
                'content-type',
                'mcp-session-id',
                'x-api-key',
                ...(gatewayGuard ? [gatewayGuard.header] : []),
            ].join(', '));
        }
    };
    const http = createServer((req, res) => {
        const route = async () => {
            const requestUrl = new URL(req.url ?? '/', 'http://folderforge.invalid');
            const pathname = requestUrl.pathname;
            applyCors(req, res);
            res.setHeader('x-folderforge-instance-id', instanceId);
            res.setHeader('x-folderforge-started-at', startedAt);
            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }
            if (req.method === 'GET' && pathname === '/healthz') {
                writeJson(res, 200, { ok: true, instanceId, startedAt, activeSessions: sessions.size, sessionTtlMs });
                return;
            }
            const gatewayProtected = pathname === mcpPath ||
                Boolean(oauthRuntime?.protectedResourceMetadataPaths.includes(pathname));
            if (gatewayProtected &&
                gatewayGuard &&
                !matchesAnyCredential(extractHeaderValue(req, gatewayGuard.header), [gatewayGuard.token])) {
                writeJson(res, 401, { error: 'gateway_unauthorized', message: 'Trusted gateway credential required' }, { 'www-authenticate': 'FolderForge-Gateway realm="folderforge-mcp"' });
                return;
            }
            if (oauthRuntime?.protectedResourceMetadataPaths.includes(pathname)) {
                if (req.method !== 'GET') {
                    res.writeHead(405, { allow: 'GET, OPTIONS' });
                    res.end();
                    return;
                }
                res.writeHead(200, {
                    'content-type': 'application/json',
                    'cache-control': 'public, max-age=300',
                    'access-control-allow-origin': '*',
                });
                res.end(JSON.stringify(oauthRuntime.protectedResourceMetadata));
                return;
            }
            if (pathname === mcpPath) {
                if (authMode === 'oauth') {
                    const runtime = oauthRuntime;
                    const bearer = extractBearer(req);
                    if (!bearer) {
                        writeJson(res, 401, { error: 'unauthorized', message: 'OAuth bearer access token required' }, {
                            'www-authenticate': oauthChallenge(runtime, {
                                scopes: [runtime.config.readScope],
                            }),
                        });
                        return;
                    }
                    let verified;
                    try {
                        verified = await runtime.verifyAccessToken(bearer);
                    }
                    catch {
                        writeJson(res, 401, { error: 'invalid_token', message: 'Access token is invalid or expired' }, {
                            'www-authenticate': oauthChallenge(runtime, {
                                scopes: [runtime.config.readScope],
                                error: 'invalid_token',
                                errorDescription: 'Access token is invalid or expired',
                            }),
                        });
                        return;
                    }
                    if (!verified.scopes.includes(runtime.config.readScope)) {
                        writeJson(res, 403, { error: 'insufficient_scope', message: 'Read scope is required for MCP access' }, {
                            'www-authenticate': oauthChallenge(runtime, {
                                scopes: [runtime.config.readScope],
                                error: 'insufficient_scope',
                                errorDescription: 'Read scope is required for MCP access',
                            }),
                        });
                        return;
                    }
                    await handleMcp(req, res, runtime.principalFor(verified));
                    return;
                }
                const provided = extractBearer(req) ?? extractApiKey(req);
                if (authMode === 'token' && !matchesAnyCredential(provided, credentials)) {
                    writeJson(res, 401, {
                        error: 'unauthorized',
                        message: 'Valid static credential required in Authorization: Bearer or X-API-Key',
                    }, { 'www-authenticate': 'Bearer realm="folderforge-mcp"' });
                    return;
                }
                await handleMcp(req, res, agentPrincipalFromCredential(provided));
                return;
            }
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Not found');
        };
        void route().catch((error) => {
            logger.error({ err: error instanceof Error ? error.message : String(error) }, 'HTTP MCP request failed');
            if (!res.headersSent)
                writeJson(res, 500, { error: 'internal_error' });
            else
                res.end();
        });
    });
    http.on('close', () => {
        clearInterval(sweeper);
        for (const session of [...sessions.values()]) {
            void closeSession(session.id, 'server_shutdown');
        }
    });
    await new Promise((resolveListen) => {
        http.listen(opts.port, opts.host, () => {
            logger.info({
                host: opts.host,
                port: opts.port,
                path: mcpPath,
                authMode,
                instanceId,
                sessionTtlMs,
                ...(gatewayGuard ? { gatewayGuardHeader: gatewayGuard.header } : {}),
                ...(oauthRuntime ? { resource: oauthRuntime.config.resource, issuer: oauthRuntime.config.issuer } : {}),
            }, 'MCP HTTP transport listening');
            resolveListen();
        });
    });
    return http;
}
