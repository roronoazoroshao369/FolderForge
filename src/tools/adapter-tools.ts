import type { Container } from '../core/container.js';
import type { ToolDefinition, ToolResult, RiskLevel } from '../core/types.js';
import type { AdapterName, SubToolDescriptor } from '../adapters/child-mcp/registry.js';
import { resolveSubOpRisk } from '../adapters/child-mcp/risk-map.js';
import { bm25Rank } from '../adapters/child-mcp/rank.js';
import { defineTool } from './registry.js';
import { logger } from '../core/logger.js';

/** Adapters we expose, in a stable order, with their namespace prefix. */
const ADAPTER_NAMES: AdapterName[] = ['serena', 'playwright', 'desktopCommander'];

/** Separator between an adapter namespace and the child tool name. */
export const NS_SEP = '__';

/** Suffix appended to a facade adapter's namespace for the discovery tool. */
export const LIST_TOOLS_SUFFIX = 'list_tools';
/** Suffix appended to a facade adapter's namespace for the dispatcher tool. */
export const CALL_TOOL_SUFFIX = 'call_tool';

/** Default page size for the facade `list_tools` catalog response. */
const LIST_TOOLS_PAGE = 50;

/**
 * Build the namespaced tool name for a child tool, e.g. `serena__find_symbol`.
 */
export function namespacedName(adapter: AdapterName, childTool: string): string {
  return `${adapter}${NS_SEP}${childTool}`;
}

/**
 * The synthetic governance identity for a facade sub-op, e.g.
 * `godot__call_tool:open_scene`. This is what {@link ToolRegistry.callDynamic}
 * is keyed on and what the audit trail records, so it never collides with the
 * flat `<adapter>__<tool>` namespace used by non-facade adapters.
 */
export function subOpIdentity(adapter: AdapterName, childTool: string): string {
  return `${adapter}${NS_SEP}${CALL_TOOL_SUFFIX}:${childTool}`;
}

/**
 * Discover the tools exposed by every enabled child MCP adapter and wrap them as
 * native FolderForge {@link ToolDefinition}s.
 *
 *  - Flat adapters (default) re-export each child tool namespaced
 *    (`serena__find_symbol`), routed through the normal policy + audit pipeline.
 *  - Facade adapters (`facade: true`) instead emit a fixed two-tool pair
 *    (`<adapter>__list_tools` + `<adapter>__call_tool`) so a huge child (100+
 *    tools) consumes ~2 slots instead of N. Sub-ops are governed individually
 *    via {@link ToolRegistry.callDynamic}. See docs/mcp-facade.md.
 *
 * Discovery failures for one adapter never block the others.
 */
export async function buildAdapterTools(container: Container): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [];

  for (const name of ADAPTER_NAMES) {
    if (!container.adapters.isEnabled(name)) continue;

    if (container.adapters.isFacade(name)) {
      try {
        // Warm the catalog so `list_tools` is instant and the child is known to
        // be reachable; a discovery failure skips just this adapter.
        const catalog = await container.adapters.catalog(name);
        tools.push(...buildFacadeTools(container, name));
        logger.info(
          { adapter: name, subTools: catalog.length },
          'Registered facade adapter (2 tools)'
        );
      } catch (err) {
        logger.warn({ adapter: name, err: String(err) }, 'Skipping facade adapter; discovery failed');
      }
      continue;
    }

    let childTools: SubToolDescriptor[];
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

/**
 * Build the fixed `<adapter>__list_tools` + `<adapter>__call_tool` pair for a
 * facade adapter. `list_tools` is a LOW read over the cached catalog;
 * `call_tool` resolves each sub-op's own risk/mutation and re-enters the
 * governance pipeline via `registry.callDynamic` before forwarding to the child.
 */
function buildFacadeTools(container: Container, name: AdapterName): ToolDefinition[] {
  const listName = `${name}${NS_SEP}${LIST_TOOLS_SUFFIX}`;
  const callName = `${name}${NS_SEP}${CALL_TOOL_SUFFIX}`;

  const listTool = defineTool({
    name: listName,
    description:
      `Discover the tools available on the "${name}" server. Optionally filter ` +
      `by name substring and paginate. Returns each sub-tool's name, ` +
      `description, inputSchema, risk, and mutates flag so you can pick one and ` +
      `read its exact arguments before calling it via ${callName}.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Free-text search. When set, sub-tools are ranked by relevance ' +
            '(BM25 over name + description, name weighted higher) and only ' +
            'matching tools are returned, best first. Combine with name_contains ' +
            'to pre-filter. Omit to list in catalog order.',
        },
        name_contains: {
          type: 'string',
          description: 'Case-insensitive substring filter on the sub-tool name.',
        },
        cursor: {
          type: 'number',
          description: 'Zero-based offset into the (filtered/ranked) catalog for pagination.',
        },
        limit: {
          type: 'number',
          description: `Max sub-tools to return (default ${LIST_TOOLS_PAGE}).`,
        },
      },
    },
    group: `adapter:${name}`,
    mutates: false,
    risk: 'LOW',
    handler: async (args): Promise<ToolResult> => {
      try {
        const catalog = await container.adapters.catalog(name);
        const filter =
          typeof args.name_contains === 'string' ? args.name_contains.toLowerCase() : null;
        const filtered = filter
          ? catalog.filter((t) => t.name.toLowerCase().includes(filter))
          : catalog;

        // When a free-text query is given, rank the (already substring-filtered)
        // catalog by BM25 relevance and drop non-matching tools; otherwise keep
        // catalog order. `scores` maps sub-tool name -> relevance for the page.
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        let ordered = filtered;
        let scores: Map<string, number> | null = null;
        if (query) {
          const ranked = bm25Rank(
            filtered.map((t) => ({
              id: t.name,
              name: t.name,
              ...(t.description !== undefined ? { description: t.description } : {}),
            })),
            query
          );
          scores = new Map(ranked.map((r) => [r.id, r.score]));
          const byName = new Map(filtered.map((t) => [t.name, t]));
          ordered = ranked.map((r) => byName.get(r.id)!);
        }

        const cursor = Number.isFinite(args.cursor as number) ? Math.max(0, Number(args.cursor)) : 0;
        const limit =
          Number.isFinite(args.limit as number) && Number(args.limit) > 0
            ? Number(args.limit)
            : LIST_TOOLS_PAGE;
        const page = ordered.slice(cursor, cursor + limit);
        const nextCursor = cursor + limit < ordered.length ? cursor + limit : null;
        return {
          ok: true,
          data: {
            adapter: name,
            total: ordered.length,
            cursor,
            nextCursor,
            ranked: scores !== null,
            tools: page.map((t) => {
              const cls = resolveSubOpRisk(name, t.name);
              return {
                name: t.name,
                description: t.description ?? '',
                inputSchema: t.inputSchema ?? { type: 'object' },
                risk: cls.risk,
                mutates: cls.mutates,
                ...(scores !== null ? { score: scores.get(t.name) ?? 0 } : {}),
              };
            }),
          },
        };
      } catch (err) {
        return { ok: false, error: `${listName} failed: ${String(err)}` };
      }
    },
  });

  const callTool = defineTool({
    name: callName,
    description:
      `Call one tool on the "${name}" server. Use ${listName} first to find the ` +
      `sub-tool name and its argument schema. Each sub-op is risk-classified and ` +
      `approval-gated individually - the dispatcher is not a governance bypass.`,
    inputSchema: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description: `The sub-tool name to invoke (see ${listName}).`,
        },
        args: {
          type: 'object',
          description: 'Arguments object for the sub-tool, matching its inputSchema.',
        },
      },
      required: ['tool'],
    },
    // Envelope defaults: the *effective* risk is the per-sub-op risk resolved at
    // call time (mirroring how shell_exec is re-classified per command).
    group: `adapter:${name}`,
    mutates: true,
    risk: 'MEDIUM',
    handler: async (args, ctx): Promise<ToolResult> => {
      const subTool = typeof args.tool === 'string' ? args.tool : '';
      if (!subTool) {
        return { ok: false, error: `${callName}: "tool" is required (the sub-tool name).` };
      }
      const subArgs =
        args.args && typeof args.args === 'object' ? (args.args as Record<string, unknown>) : {};

      // Resolve the sub-op's OWN risk/mutation from the per-adapter risk map
      // (default MEDIUM/mutates:true). This is what governance keys on - the
      // dispatcher can never downgrade a CRITICAL sub-op.
      const cls = resolveSubOpRisk(name, subTool);
      const registry = container.registry as {
        callDynamic: (
          d: { name: string; risk: RiskLevel; mutates: boolean; handler: ToolDefinition['handler'] },
          a: Record<string, unknown>,
          control?: unknown
        ) => Promise<ToolResult>;
      };

      return registry.callDynamic(
        {
          name: subOpIdentity(name, subTool),
          risk: cls.risk,
          mutates: cls.mutates,
          handler: async (innerArgs): Promise<ToolResult> => {
            try {
              const client = await container.adapters.ensure(name);
              const raw = await client.callTool(subTool, innerArgs);
              return { ok: true, data: raw };
            } catch (err) {
              return { ok: false, error: `${name}:${subTool} failed: ${String(err)}` };
            }
          },
        },
        subArgs,
        ctx.control
      );
    },
  });

  return [listTool, callTool];
}
