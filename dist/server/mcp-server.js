import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../core/logger.js';
/**
 * Build an MCP {@link Server} backed by the FolderForge {@link ToolRegistry}.
 *
 * The server exposes exactly two capabilities:
 *  - `tools/list`  -> reads {@link ToolRegistry.listActive} (curated/active subset)
 *  - `tools/call`  -> delegates to {@link ToolRegistry.call} (policy + audit pipeline)
 *
 * Transport binding (stdio / http) is handled separately in `server/transports/*`.
 */
export function createMcpServer(registry, info) {
    const server = new Server({ name: info.name, version: info.version }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const tools = registry.listActive().map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: toJsonSchema(t.inputSchema),
        }));
        return { tools };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const result = await registry.call(name, (args ?? {}));
        return toCallToolResult(result);
    });
    server.onerror = (err) => {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, 'MCP server error');
    };
    return server;
}
/**
 * Tool input schemas are stored as plain JSON-schema objects. The MCP SDK
 * requires the top-level `type` to be `"object"`; normalize defensively.
 */
function toJsonSchema(schema) {
    const base = schema && typeof schema === 'object' ? schema : {};
    return { type: 'object', ...base };
}
/** Convert a FolderForge {@link ToolResult} into an MCP `tools/call` result. */
function toCallToolResult(result) {
    if (!result.ok) {
        const text = result.approvalId
            ? `${result.error ?? 'Approval required'}\n(approvalId=${result.approvalId})`
            : result.error ?? 'Tool call failed';
        return { content: [{ type: 'text', text }], isError: true };
    }
    const payload = {};
    if (result.data !== undefined)
        payload.data = result.data;
    if (result.diff !== undefined)
        payload.diff = result.diff;
    const text = result.diff && result.data === undefined
        ? result.diff
        : JSON.stringify(Object.keys(payload).length ? payload : { ok: true }, null, 2);
    return { content: [{ type: 'text', text }] };
}
