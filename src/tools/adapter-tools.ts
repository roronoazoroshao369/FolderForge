import type { Container } from '../core/container.js';
import type { ToolDefinition, ToolResult } from '../core/types.js';
import type { AdapterName } from '../adapters/child-mcp/registry.js';
import { defineTool } from './registry.js';
import { logger } from '../core/logger.js';

/** Adapters we expose, in a stable order, with their namespace prefix. */
const ADAPTER_NAMES: AdapterName[] = ['serena', 'playwright', 'desktopCommander'];

/** Separator between an adapter namespace and the child tool name. */
export const NS_SEP = '__';

/**
 * Build the namespaced tool name for a child tool, e.g. `serena__find_symbol`.
 */
export function namespacedName(adapter: AdapterName, childTool: string): string {
  return `${adapter}${NS_SEP}${childTool}`;
}

/**
 * Discover the tools exposed by every enabled child MCP adapter and wrap each
 * one as a native FolderForge {@link ToolDefinition}. The wrapper:
 *  - prefixes the name with the adapter namespace (`serena__find_symbol`)
 *  - lazily starts the child process on first call (via `adapters.ensure`)
 *  - routes the call through the same policy + audit pipeline as native tools
 *
 * Child tools are treated as MEDIUM risk and `mutates: true` by default so that
 * policy mode (readonly/safe) and the approval list still gate them. Discovery
 * failures for one adapter never block the others.
 */
export async function buildAdapterTools(container: Container): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [];

  for (const name of ADAPTER_NAMES) {
    if (!container.adapters.isEnabled(name)) continue;

    let childTools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    try {
      const client = await container.adapters.ensure(name);
      childTools = await client.listTools();
    } catch (err) {
      logger.warn({ adapter: name, err: String(err) }, 'Skipping adapter; tool discovery failed');
      continue;
    }

    for (const child of childTools) {
      const toolName = namespacedName(name, child.name);
      tools.push(
        defineTool({
          name: toolName,
          description: child.description ?? `${name} tool: ${child.name}`,
          inputSchema: child.inputSchema ?? { type: 'object' },
          group: `adapter:${name}`,
          mutates: true,
          risk: 'MEDIUM',
          handler: async (args): Promise<ToolResult> => {
            try {
              const client = await container.adapters.ensure(name);
              const raw = await client.callTool(child.name, args);
              return { ok: true, data: raw };
            } catch (err) {
              return { ok: false, error: `${toolName} failed: ${String(err)}` };
            }
          },
        })
      );
    }

    logger.info({ adapter: name, count: childTools.length }, 'Registered adapter tools');
  }

  return tools;
}
