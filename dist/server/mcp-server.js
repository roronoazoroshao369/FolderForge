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
 * `tools/list` additionally advertises, when present:
 *  - `outputSchema`  (MCP structured tool output, 2025-06-18)
 *  - `annotations`   (readOnly/destructive/idempotent hints, derived from
 *                     the frozen mutates/risk contract in defineTool)
 *
 * Transport binding (stdio / http) is handled separately in `server/transports/*`.
 */
export function createMcpServer(registry, info) {
    const roots = info.roots ?? [];
    // NOTE on `roots`: in MCP, `roots` is a *client* capability (the client tells
    // the server which directories are in scope). A server cannot declare it.
    // FolderForge instead surfaces its own filesystem scope to the client through
    // the server `instructions` string below (and via the workspace_* tools), so
    // the agent can discover the allowed directories without us mis-declaring a
    // capability we don't own. This satisfies roadmap P5 truthfully.
    const rootsLine = roots.length
        ? `\n\nWorkspace roots (allowed directories): ${roots.join(', ')}.`
        : '';
    const server = new Server({ name: info.name, version: info.version }, {
        capabilities: { tools: {} },
        instructions: 'FolderForge: local development control plane. All tools run through a ' +
            'policy + audit pipeline; tool annotations (readOnlyHint/destructiveHint) ' +
            'are hints only.' +
            rootsLine,
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const tools = registry.listActive().map((t) => {
            const tool = {
                name: t.name,
                description: t.description,
                inputSchema: toJsonSchema(t.inputSchema),
            };
            // Advertise structured output schema (MCP outputSchema) when a tool
            // declares one. Clients use it to validate `structuredContent`.
            if (t.outputSchema) {
                tool.outputSchema = toJsonSchema(t.outputSchema);
            }
            // Advertise behaviour hints. Derived from mutates/risk in defineTool;
            // hints only - never a security boundary.
            if (t.annotations) {
                tool.annotations = t.annotations;
            }
            return tool;
        });
        return { tools };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const { name, arguments: args } = request.params;
        // Wire MCP protocol features into the tool pipeline via a per-call control
        // object (roadmap P4/P6/P8). All three are optional: a long-running handler
        // may report progress, observe cancellation, or elicit input, while a
        // simple handler ignores `control` entirely. None of this touches the
        // frozen tool schema, so the schema-lock is unaffected.
        const progressToken = request.params._meta?.progressToken;
        // P8 - elicitation adapter: normalize the SDK's elicitInput result into the
        // project's ElicitResult shape (narrowing `action` to our union). Present
        // only when the client advertised the `elicitation` capability; otherwise
        // omitted entirely so handlers fall back to non-interactive defaults.
        const elicit = server.getClientCapabilities()
            ?.elicitation
            ? async (params) => {
                const r = await server.elicitInput(params);
                const action = r.action;
                return r.content !== undefined ? { action, content: r.content } : { action };
            }
            : undefined;
        // P4 - progress: only emit when the client opted in by sending a
        // progressToken in the request _meta. Mirrors the SDK contract.
        const reportProgress = progressToken === undefined
            ? undefined
            : async (progress, total, message) => {
                await extra.sendNotification({
                    method: 'notifications/progress',
                    params: { progressToken, progress, total, message },
                });
            };
        // Build the control object with conditional spreads: under
        // exactOptionalPropertyTypes an optional field cannot be assigned
        // `undefined` explicitly, so we omit absent capabilities entirely.
        const control = {
            // P6 - cancellation: the SDK aborts `extra.signal` on a notifications/
            // cancelled for this request id. Handlers long-poll against it the same
            // way ProcessManager.readUntil waits on its own waiters.
            signal: extra.signal,
            ...(reportProgress !== undefined ? { reportProgress } : {}),
            ...(elicit !== undefined ? { elicitInput: elicit } : {}),
        };
        const result = await registry.call(name, (args ?? {}), control);
        const tool = registry.get(name);
        return toCallToolResult(result, Boolean(tool?.outputSchema));
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
/**
 * Convert a FolderForge {@link ToolResult} into an MCP `tools/call` result.
 *
 * Exported for unit testing of the structuredContent mirroring contract.
 */
export function toCallToolResult(result, hasOutputSchema = false) {
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
    // Build the content array. The text block always leads (back-compat for
    // text-only clients); rich content blocks (embedded resources / links) are
    // appended so spec-aware clients can render a diff inline or open a file in a
    // viewer/tab. See ToolContentBlock in core/types.
    const content = [{ type: 'text', text }];
    for (const block of result.content ?? []) {
        if (block.kind === 'text') {
            content.push({ type: 'text', text: block.text });
        }
        else if (block.kind === 'resource') {
            content.push({
                type: 'resource',
                resource: {
                    uri: block.uri,
                    text: block.text,
                    ...(block.mimeType ? { mimeType: block.mimeType } : {}),
                    ...(block.title ? { title: block.title } : {}),
                },
            });
        }
        else if (block.kind === 'resource_link') {
            content.push({
                type: 'resource_link',
                uri: block.uri,
                ...(block.name ? { name: block.name } : {}),
                ...(block.title ? { title: block.title } : {}),
                ...(block.description ? { description: block.description } : {}),
                ...(block.mimeType ? { mimeType: block.mimeType } : {}),
            });
        }
    }
    const out = { content };
    // When a tool declares an outputSchema, also return machine-readable
    // structuredContent so spec-aware clients can consume typed output without
    // re-parsing the text block (MCP 2025-06-18 structured tool output).
    if (hasOutputSchema && result.data !== undefined && result.data !== null) {
        out.structuredContent =
            result.data;
    }
    return out;
}
