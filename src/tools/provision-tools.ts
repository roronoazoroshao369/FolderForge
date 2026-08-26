/**
 * Agent-facing per-folder fleet provisioning tools (ADR-0012, Phase 1).
 *
 * Every tool delegates to the container's FleetManager and records lifecycle
 * events in the audit log. Folder paths are validated against the configured
 * workspace.allowedDirectories before any state is written, and instance log
 * output is secret-redacted before it leaves the handler.
 */

import { isAbsolute, resolve, sep } from 'node:path';
import { defineTool } from './registry.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../core/types.js';
import {
  FLEET_POLICY_MODES,
  FLEET_TOOLS_PRESETS,
  type FleetInstance,
} from '../provisioner/fleet-manager.js';

function resolveFolder(input: string, ctx: ToolContext): string {
  const target = isAbsolute(input) ? resolve(input) : resolve(ctx.projectRoot, input);
  const allowed: string[] = ctx.config.workspace.allowedDirectories ?? [];
  const inside = allowed.some((dir) => {
    const base = resolve(dir);
    return target === base || target.startsWith(base + sep);
  });
  if (!inside) {
    throw new Error(`Folder is outside the configured allowedDirectories: ${target}`);
  }
  return target;
}

function actorOf(ctx: ToolContext): string {
  const principal = ctx.control?.principal as { id?: string } | undefined;
  return principal?.id ?? 'agent';
}

/** Shapes the public view: hash kept, raw tokens never leave the manager. */
function publicInstance(instance: FleetInstance): FleetInstance {
  return { ...instance };
}

function guard(fn: () => ToolResult): ToolResult {
  try {
    return fn();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function guardAsync(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function provisionTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'provision_create',
      description:
        'Provision a new governed MCP server instance for a project folder (one per folder). ' +
        'Returns the instance bearer token exactly once; only its SHA-256 hash is persisted.',
      group: 'provision',
      mutates: true,
      risk: 'MEDIUM',
      inputSchema: {
        type: 'object',
        properties: {
          projectPath: { type: 'string', description: 'Absolute or project-relative folder path.' },
          name: { type: 'string', description: 'Display name (defaults to the folder name).' },
          port: { type: 'number', description: 'HTTP port (default: first free in the fleet range).' },
          toolsPreset: { type: 'string', enum: [...FLEET_TOOLS_PRESETS] },
          policyMode: { type: 'string', enum: [...FLEET_POLICY_MODES] },
        },
        required: ['projectPath'],
        additionalProperties: false,
      },
      handler: async (args, ctx) =>
        guard(() => {
          const projectPath = resolveFolder(String(args.projectPath), ctx);
          const { instance, token } = ctx.container.fleet.create({
            projectPath,
            name: args.name !== undefined ? String(args.name) : undefined,
            port: args.port !== undefined ? Number(args.port) : undefined,
            toolsPreset: args.toolsPreset !== undefined ? String(args.toolsPreset) : undefined,
            policyMode: args.policyMode !== undefined ? String(args.policyMode) : undefined,
            actor: actorOf(ctx),
          });
          ctx.container.audit.record({
            type: 'provision_event',
            summary: `create ${instance.id} (${instance.projectPath}:${instance.port}, preset=${instance.toolsPreset}, policy=${instance.policyMode})`,
          });
          return {
            ok: true,
            data: {
              ...publicInstance(instance),
              token,
              tokenNote:
                'Store this token now. It is returned exactly once and never persisted in plaintext.',
            },
          };
        }),
    }),

    defineTool({
      name: 'provision_list',
      description: 'List provisioned per-folder MCP instances (secrets shown as hashes only).',
      group: 'provision',
      mutates: false,
      risk: 'LOW',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (_args, ctx) =>
        guard(() => ({
          ok: true,
          data: { instances: ctx.container.fleet.list().map(publicInstance) },
        })),
    }),

    defineTool({
      name: 'provision_status',
      description: 'Show one provisioned instance: state, port, uptime-relevant timestamps, last error.',
      group: 'provision',
      mutates: false,
      risk: 'LOW',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args, ctx) =>
        guard(() => ({ ok: true, data: publicInstance(ctx.container.fleet.get(String(args.id))) })),
    }),

    defineTool({
      name: 'provision_start',
      description:
        'Start a provisioned instance (spawns a loopback, token-authenticated FolderForge MCP ' +
        'server for its folder). HIGH risk; requires approval per policy.',
      group: 'provision',
      mutates: true,
      risk: 'HIGH',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args, ctx) =>
        guard(() => {
          const instance = ctx.container.fleet.start(String(args.id));
          ctx.container.audit.record({
            type: 'provision_event',
            summary: `start ${instance.id} (session ${instance.sessionId ?? 'n/a'})`,
          });
          return { ok: true, data: publicInstance(instance) };
        }),
    }),

    defineTool({
      name: 'provision_stop',
      description: 'Stop a running provisioned instance gracefully (SIGTERM via ProcessManager).',
      group: 'provision',
      mutates: true,
      risk: 'MEDIUM',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args, ctx) =>
        guard(() => {
          const instance = ctx.container.fleet.stop(String(args.id));
          ctx.container.audit.record({ type: 'provision_event', summary: `stop ${instance.id}` });
          return { ok: true, data: publicInstance(instance) };
        }),
    }),

    defineTool({
      name: 'provision_logs',
      description:
        'Read new output from a provisioned instance since the last cursor (secret-redacted).',
      group: 'provision',
      mutates: false,
      risk: 'LOW',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args, ctx) =>
        guard(() => {
          const id = String(args.id);
          const output = ctx.container.policy.secret.redact(ctx.container.fleet.logs(id));
          return { ok: true, data: { id, output } };
        }),
    }),

    defineTool({
      name: 'provision_destroy',
      description:
        'Destroy a stopped provisioned instance: removes its state record and token config ' +
        'file. HIGH risk; requires approval per policy.',
      group: 'provision',
      mutates: true,
      risk: 'HIGH',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args, ctx) =>
        guard(() => {
          const result = ctx.container.fleet.destroy(String(args.id));
          ctx.container.audit.record({
            type: 'provision_event',
            summary: `destroy ${result.destroyed}`,
          });
          return { ok: true, data: result };
        }),
    }),

    defineTool({
      name: 'provision_health',
      description:
        'Probe one provisioned instance: policy state, pid liveness, and whether its ' +
        'loopback MCP endpoint answers and enforces auth.',
      group: 'provision',
      mutates: false,
      risk: 'LOW',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args, ctx) =>
        guardAsync(async () => ({
          ok: true,
          data: await ctx.container.fleet.health(String(args.id)),
        })),
    }),

    defineTool({
      name: 'provision_restart',
      description:
        'Restart a provisioned instance (graceful stop then start). HIGH risk; requires approval per policy.',
      group: 'provision',
      mutates: true,
      risk: 'HIGH',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args, ctx) =>
        guard(() => {
          const instance = ctx.container.fleet.restart(String(args.id));
          ctx.container.audit.record({
            type: 'provision_event',
            summary: `restart ${instance.id} (session ${instance.sessionId ?? 'n/a'})`,
          });
          return { ok: true, data: publicInstance(instance) };
        }),
    }),

    defineTool({
      name: 'provision_update',
      description:
        'Update instance settings: autoRestart (boolean) and/or toolsPreset ' +
        '(vibe|vibe-lite|readonly|full|godot). A preset change applies on the ' +
        'next start/restart of the instance.',
      group: 'provision',
      mutates: true,
      risk: 'MEDIUM',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          autoRestart: { type: 'boolean' },
          toolsPreset: {
            type: 'string',
            enum: ['vibe', 'vibe-lite', 'readonly', 'full', 'godot'],
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args, ctx) =>
        guard(() => {
          const id = String(args.id);
          const autoRestart = args.autoRestart;
          const toolsPreset = args.toolsPreset;
          if (typeof autoRestart !== 'boolean' && typeof toolsPreset !== 'string') {
            throw new Error('Nothing to update: pass autoRestart and/or toolsPreset.');
          }
          const changes: string[] = [];
          if (typeof autoRestart === 'boolean') {
            ctx.container.fleet.setAutoRestart(id, autoRestart);
            changes.push(`auto-restart ${autoRestart ? 'enabled' : 'disabled'}`);
          }
          if (typeof toolsPreset === 'string') {
            ctx.container.fleet.setToolsPreset(id, toolsPreset);
            changes.push(`tools-preset -> ${toolsPreset} (restart to apply)`);
          }
          const instance = ctx.container.fleet.get(id);
          ctx.container.audit.record({
            type: 'provision_event',
            summary: `update ${instance.id}: ${changes.join('; ')}`,
          });
          return { ok: true, data: publicInstance(instance) };
        }),
    }),
  ];
}
