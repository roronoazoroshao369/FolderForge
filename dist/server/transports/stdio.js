import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from '../../core/logger.js';
/**
 * Bind the MCP server to the stdio transport.
 *
 * stdin/stdout carry the JSON-RPC channel, so logs must go to stderr only
 * (see core/logger.ts). Returns once the transport is connected.
 */
export async function startStdioTransport(server) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('MCP stdio transport connected');
    return transport;
}
