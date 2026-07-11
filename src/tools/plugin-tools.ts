import type { ToolDefinition, ToolResult } from '../core/types.js';
import type { InstalledPlugin } from '../plugins/plugin-manager.js';
import { registerAdapterRiskMap, unregisterAdapterRiskMap } from '../adapters/child-mcp/risk-map.js';
import { buildAdapterToolsFor, NS_SEP } from './adapter-tools.js';
import { defineTool } from './registry.js';

const pluginListSchema = {
  type: 'object',
  properties: {
    plugins: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  required: ['plugins'],
} as const;

async function loadPlugin(id: string, ctx: Parameters<ToolDefinition['handler']>[1]): Promise<string[]> {
  const adapter = ctx.container.plugins.adapter(id);
  registerAdapterRiskMap(adapter.name, adapter.riskDefault, adapter.riskMap);
  ctx.container.adapters.upsert(adapter.name, adapter.def);
  const registry = ctx.container.registry;
  registry.unregisterWhere((tool: ToolDefinition) => tool.group === `adapter:${id}`);
  const tools = await buildAdapterToolsFor(ctx.container, [id]);
  if (tools.length === 0) throw new Error(`Plugin ${id} started but exposed no usable tools.`);
  registry.registerAll(tools);
  registry.activate(tools.map((tool: ToolDefinition) => tool.name));
  return tools.map((tool) => tool.name);
}

function unloadPlugin(id: string, ctx: Parameters<ToolDefinition['handler']>[1]): string[] {
  const registry = ctx.container.registry;
  const removed = registry.unregisterWhere((tool: ToolDefinition) =>
    tool.group === `adapter:${id}` || tool.name.startsWith(`${id}${NS_SEP}`)
  );
  ctx.container.adapters.remove(id);
  unregisterAdapterRiskMap(id);
  return removed;
}

function failure(error: unknown): ToolResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export function pluginTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'plugin_list',
      description: 'List locally installed FolderForge MCP plugins, versions, enabled state, permissions, compatibility, and facade mode.',
      group: 'plugin',
      mutates: false,
      inputSchema: { type: 'object', properties: {} },
      outputSchema: pluginListSchema,
      handler: async (_args, ctx) => ({ ok: true, data: { plugins: ctx.container.plugins.list() } }),
    }),
    defineTool({
      name: 'plugin_inspect',
      description: 'Inspect one installed plugin manifest and its persisted installation metadata without starting it.',
      group: 'plugin',
      mutates: false,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      outputSchema: { type: 'object', additionalProperties: true },
      handler: async (args, ctx) => {
        try { return { ok: true, data: ctx.container.plugins.inspect(String(args.id ?? '')) }; }
        catch (error) { return failure(error); }
      },
    }),
    defineTool({
      name: 'plugin_install',
      description: 'Install a validated local FolderForge MCP plugin package. Copies a bounded, symlink-free directory; remote fetching and package scripts are not executed.',
      group: 'plugin',
      mutates: true,
      risk: 'HIGH',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Local directory containing folderforge.plugin.json and prepared runtime files.' },
          enable: { type: 'boolean', description: 'Hot-enable after installation. Defaults false so permissions can be inspected first.' },
        },
        required: ['source'],
      },
      outputSchema: { type: 'object', additionalProperties: true },
      handler: async (args, ctx) => {
        try {
          const installed = ctx.container.plugins.install(String(args.source ?? ''), args.enable === true);
          try {
            const tools = installed.enabled ? await loadPlugin(installed.id, ctx) : [];
            return { ok: true, data: { installed, tools, restartRequired: false } };
          } catch (error) {
            ctx.container.plugins.setEnabled(installed.id, false);
            unloadPlugin(installed.id, ctx);
            return failure(error);
          }
        } catch (error) { return failure(error); }
      },
    }),
    defineTool({
      name: 'plugin_update',
      description: 'Replace an installed plugin from a validated local package with the same id, preserving enabled state and hot-reloading its MCP facade.',
      group: 'plugin',
      mutates: true,
      risk: 'HIGH',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, source: { type: 'string' } },
        required: ['id', 'source'],
      },
      outputSchema: { type: 'object', additionalProperties: true },
      handler: async (args, ctx) => {
        const id = String(args.id ?? '');
        let previousEnabled = false;
        try {
          previousEnabled = ctx.container.plugins.inspect(id).installed.enabled;
          unloadPlugin(id, ctx);
          let tools: string[] = [];
          const updated = await ctx.container.plugins.update(
            id,
            String(args.source ?? ''),
            async (candidate: InstalledPlugin) => {
              tools = candidate.enabled ? await loadPlugin(id, ctx) : [];
            }
          );
          return { ok: true, data: { updated, tools, restartRequired: false } };
        } catch (error) {
          // Manager-level update rollback restores the previous package and
          // registry record. Replace any partially loaded candidate facade with
          // the previously enabled facade so a failed update is not an outage.
          unloadPlugin(id, ctx);
          if (previousEnabled) {
            try { await loadPlugin(id, ctx); } catch { /* preserve original update error */ }
          }
          return failure(error);
        }
      },
    }),
    defineTool({
      name: 'plugin_enable',
      description: 'Enable and hot-load an installed plugin into the governed MCP tool registry.',
      group: 'plugin',
      mutates: true,
      risk: 'MEDIUM',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: { type: 'object', additionalProperties: true },
      handler: async (args, ctx) => {
        const id = String(args.id ?? '');
        try {
          ctx.container.plugins.setEnabled(id, true);
          const tools = await loadPlugin(id, ctx);
          return { ok: true, data: { id, enabled: true, tools } };
        } catch (error) {
          try { ctx.container.plugins.setEnabled(id, false); } catch { /* preserve original error */ }
          unloadPlugin(id, ctx);
          return failure(error);
        }
      },
    }),
    defineTool({
      name: 'plugin_disable',
      description: 'Disable an installed plugin, stop its child MCP process, and remove its tools from the current registry.',
      group: 'plugin',
      mutates: true,
      risk: 'MEDIUM',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: { type: 'object', additionalProperties: true },
      handler: async (args, ctx) => {
        const id = String(args.id ?? '');
        try {
          const removed = unloadPlugin(id, ctx);
          const plugin = ctx.container.plugins.setEnabled(id, false);
          return { ok: true, data: { plugin, removed } };
        } catch (error) { return failure(error); }
      },
    }),
    defineTool({
      name: 'plugin_uninstall',
      description: 'Stop, unregister, and delete an installed local plugin package and registry entry.',
      group: 'plugin',
      mutates: true,
      risk: 'HIGH',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: { type: 'object', additionalProperties: true },
      handler: async (args, ctx) => {
        const id = String(args.id ?? '');
        try {
          const removedTools = unloadPlugin(id, ctx);
          const removed = ctx.container.plugins.uninstall(id);
          return { ok: true, data: { removed, removedTools } };
        } catch (error) { return failure(error); }
      },
    }),
    defineTool({
      name: 'plugin_health',
      description: 'Start an enabled plugin if necessary, refresh its tool catalog, and report readiness/tool count.',
      group: 'plugin',
      mutates: true,
      risk: 'MEDIUM',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: { type: 'object', additionalProperties: true },
      handler: async (args, ctx) => {
        const id = String(args.id ?? '');
        try {
          const installed = ctx.container.plugins.inspect(id).installed;
          if (!installed.enabled) return { ok: true, data: { id, enabled: false, ready: false } };
          return { ok: true, data: { id, ...(await ctx.container.adapters.health(id)) } };
        } catch (error) { return failure(error); }
      },
    }),
  ];
}
