/**
 * Agent-facing quick-tunnel tools (ADR-0012, Phase 3).
 *
 * Starting a tunnel exposes a local port on a PUBLIC trycloudflare URL, so
 * `tunnel_start` is HIGH risk and policy-gated (approval in safe/readonly
 * modes). Stop/list/status stay cheap. Every lifecycle event is audited.
 */

import { defineTool } from './registry.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../core/types.js';
import type { TunnelRecord } from '../tunnels/tunnel-manager.js';

function publicTunnel(record: TunnelRecord): TunnelRecord {
  return { ...record };
}

function actorOf(ctx: ToolContext): string {
  const principal = ctx.control?.principal as { id?: string } | undefined;
  return principal?.id ?? 'agent';
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

export function tunnelTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'tunnel_start',
      description:
        'Expose a local port on a PUBLIC Cloudflare quick-tunnel URL (trycloudflare.com). ' +
        'HIGH risk: anyone with the URL can reach the target port. Requires approval per policy.',
      group: 'tunnel',
      mutates: true,
      risk: 'HIGH',
      inputSchema: {
        type: 'object',
        properties: {
          targetPort: {
            type: 'number',
            description: 'Local loopback port to expose (1024-65535).',
          },
        },
        required: ['targetPort'],
        additionalProperties: false,
      },
      handler: async (args, ctx) =>
        guardAsync(async () => {
          const record = await ctx.container.tunnels.start({
            targetPort: Number(args.targetPort),
            actor: actorOf(ctx),
          });
          ctx.container.audit.record({
            type: 'tunnel_event',
            summary: `start ${record.id} (${record.targetUrl} -> ${record.publicUrl ?? 'pending'})`,
          });
          return { ok: true, data: publicTunnel(record) };
        }),
    }),

    defineTool({
      name: 'tunnel_stop',
      description: 'Stop a running quick tunnel (closes the public URL).',
      group: 'tunnel',
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
          const record = ctx.container.tunnels.stop(String(args.id));
          ctx.container.audit.record({ type: 'tunnel_event', summary: `stop ${record.id}` });
          return { ok: true, data: publicTunnel(record) };
        }),
    }),

    defineTool({
      name: 'tunnel_list',
      description: 'List quick tunnels and their public URLs.',
      group: 'tunnel',
      mutates: false,
      risk: 'LOW',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (_args, ctx) =>
        guard(() => ({
          ok: true,
          data: { tunnels: ctx.container.tunnels.list().map(publicTunnel) },
        })),
    }),

    defineTool({
      name: 'tunnel_status',
      description: 'Show one tunnel: state, target, public URL, last error.',
      group: 'tunnel',
      mutates: false,
      risk: 'LOW',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args, ctx) =>
        guard(() => ({ ok: true, data: publicTunnel(ctx.container.tunnels.get(String(args.id))) })),
    }),
  ];
}
