import { Server } from '@modelcontextprotocol/server';
import type { ToolPrincipal, ToolResult } from '../../core/types.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { Container } from '../../runtime/container.js';
import { McpResourceCatalog } from '../mcp-resources.js';
import { McpPromptCatalog } from '../mcp-prompts.js';
import { toCallToolResult } from '../mcp-server.js';

/**
 * The official 2026 SDK handles version discovery, schema validation, JSON-RPC
 * framing, result envelopes, and protocol-level capability negotiation.
 * This thin binding delegates business operations to FolderForge governance.
 */
export function createModernMcpServer(
  registry: ToolRegistry,
  info: { name: string; version: string; principal: ToolPrincipal; container?: Container },
): Server {
  const { principal } = info;
  const server = new Server(
    { name: info.name, version: info.version },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  const resources = info.container
    ? new McpResourceCatalog(info.container, info.container.mcpTasks, principal)
    : undefined;
  const prompts = new McpPromptCatalog();

  function hasScope(mutates: boolean): boolean {
    if (principal.authMode !== 'oauth') return true;
    if (!principal.readScope || (mutates && !principal.writeScope)) return false;
    const required = mutates ? [principal.readScope, principal.writeScope] : [principal.readScope];
    return required.every(scope => scope && (principal.scopes ?? []).includes(scope));
  }

  const visibleTools = () => registry.listAgentActive().filter(tool =>
    tool.audience === 'agent' && !tool.mutates && hasScope(false)
  );

  server.setRequestHandler('tools/list', async () => ({
    tools: visibleTools().map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object' as const, ...tool.inputSchema },
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    })),
  }));

  server.setRequestHandler('tools/call', async (request, ctx) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    const tool = registry.get(name);
    const classification = tool ? registry.classifyCall(name, args) : undefined;
    if (!tool || tool.audience !== 'agent' ||
        (classification?.mutates ?? tool.mutates) || !hasScope(false) ||
        !visibleTools().some(t => t.name === name)) {
      // A modern call cannot use the legacy per-session replay map as
      // durable idempotency. Every potentially mutating operation is denied.
      return {
        resultType: 'complete' as const,
        content: [{ type: 'text' as const, text: 'Modern MCP mutation or tool access is not available.' }],
        isError: true,
      };
    }
    const result: ToolResult = await registry.callAgent(name, args, {
      principal,
      signal: ctx.mcpReq.signal,
    });
    const legacy = toCallToolResult(result, Boolean(tool.outputSchema));
    return {
      ...legacy,
      resultType: 'complete' as const,
    };
  });

  server.setRequestHandler('resources/list', async () => ({
    resources: hasScope(false) ? (resources?.list() ?? []) : [],
  }));
  server.setRequestHandler('resources/read', async request => {
    if (!resources || !hasScope(false)) throw new Error('Resource access is unavailable');
    return resources.read(request.params.uri);
  });
  server.setRequestHandler('prompts/list', async () => ({
    prompts: hasScope(false) ? prompts.list() : [],
  }));
  server.setRequestHandler('prompts/get', async request => {
    if (!hasScope(false)) throw new Error('Scope denied');
    return prompts.get(request.params.name, request.params.arguments ?? {});
  });
  return server;
}
