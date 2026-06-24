import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from '../../core/logger.js';
/**
 * Bind the MCP server to a Streamable HTTP transport.
 *
 * A single MCP {@link Server} can only be connected to one transport, so we
 * reuse one {@link StreamableHTTPServerTransport} across requests (stateful,
 * session-id based) rather than instantiating one per request.
 */
export async function startHttpTransport(server, opts) {
    const mcpPath = opts.path ?? '/mcp';
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
    });
    await server.connect(transport);
    const http = createServer((req, res) => {
        const url = req.url ?? '/';
        if (req.method === 'GET' && url === '/healthz') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (url === mcpPath || url.startsWith(`${mcpPath}?`)) {
            void transport.handleRequest(req, res).catch((err) => {
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
            logger.info({ host: opts.host, port: opts.port, path: mcpPath }, 'MCP HTTP transport listening');
            resolveListen();
        });
    });
    return http;
}
