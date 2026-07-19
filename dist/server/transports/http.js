import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
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
/** Bind the MCP server to a hardened stateless Streamable HTTP transport. */
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
    const oauthRuntime = authMode === 'oauth' ? await createOAuthRuntime(opts.oauth) : undefined;
    const handleMcp = async (req, res, principal) => {
        const rawSession = req.headers['mcp-session-id'];
        const sessionHint = Array.isArray(rawSession) ? rawSession[0] : rawSession;
        const sessionPrincipal = {
            ...principal,
            sessionId: scopedSessionId(principal.id, sessionHint),
        };
        const server = makeMcpServer(sessionPrincipal);
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
            res.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-session-id, x-api-key');
        }
    };
    const http = createServer((req, res) => {
        const route = async () => {
            const requestUrl = new URL(req.url ?? '/', 'http://folderforge.invalid');
            const pathname = requestUrl.pathname;
            applyCors(req, res);
            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }
            if (req.method === 'GET' && pathname === '/healthz') {
                writeJson(res, 200, { ok: true });
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
    await new Promise((resolveListen) => {
        http.listen(opts.port, opts.host, () => {
            logger.info({
                host: opts.host,
                port: opts.port,
                path: mcpPath,
                authMode,
                ...(oauthRuntime ? { resource: oauthRuntime.config.resource, issuer: oauthRuntime.config.issuer } : {}),
            }, 'MCP HTTP transport listening');
            resolveListen();
        });
    });
    return http;
}
