/**
 * Agent-facing per-folder fleet provisioning tools (ADR-0012).
 *
 * Every mutation delegates to FleetManager and remains inside the normal
 * policy/approval/audit pipeline. Folder paths are bounded by allowedDirectories
 * before any Fleet state is written. Secret values are returned only on the
 * exact create/change/rotate call that issued them.
 */

import { isAbsolute, resolve, sep } from 'node:path';
import { defineTool } from './registry.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../core/types.js';
import {
  FLEET_AUTH_MODES,
  FLEET_POLICY_MODES,
  FLEET_TOOLS_PRESETS,
  publicFleetInstance,
  type FleetAuthMode,
  type FleetInstance,
  type FleetOAuthConfig,
} from '../provisioner/fleet-manager.js';

function resolveFolder(input: string, ctx: ToolContext): string {
  const target = isAbsolute(input) ? resolve(input) : resolve(ctx.projectRoot, input);
  const allowed: string[] = ctx.config.workspace.allowedDirectories ?? [];
  const inside = allowed.some((dir) => {
    const base = resolve(dir);
    return target === base || target.startsWith(base + sep);
  });
  if (!inside) throw new Error(`Folder is outside the configured allowedDirectories: ${target}`);
  return target;
}

function actorOf(ctx: ToolContext): string {
  const principal = ctx.control?.principal as { id?: string } | undefined;
  return principal?.id ?? 'agent';
}

// Single source of truth for API-safe instances (strips the pasted OpenAI
// key): see publicFleetInstance in fleet-manager.
function publicInstance(instance: FleetInstance): FleetInstance {
  return publicFleetInstance(instance);
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

function oauthFromArgs(value: unknown): Partial<FleetOAuthConfig> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const result: Partial<FleetOAuthConfig> = {};
  if (typeof obj.resource === 'string') result.resource = obj.resource;
  if (typeof obj.issuer === 'string') result.issuer = obj.issuer;
  if (Array.isArray(obj.scopes)) result.scopes = obj.scopes.map(String);
  if (typeof obj.readScope === 'string') result.readScope = obj.readScope;
  if (typeof obj.writeScope === 'string') result.writeScope = obj.writeScope;
  if (
    obj.clientRegistration === 'cimd' ||
    obj.clientRegistration === 'dcr' ||
    obj.clientRegistration === 'predefined'
  ) {
    result.clientRegistration = obj.clientRegistration;
  }
  if (typeof obj.jwksUri === 'string') result.jwksUri = obj.jwksUri;
  if (Array.isArray(obj.trustedJwksHosts)) result.trustedJwksHosts = obj.trustedJwksHosts.map(String);
  if (Array.isArray(obj.algorithms)) result.algorithms = obj.algorithms.map(String);
  if (typeof obj.resourceDocumentation === 'string') result.resourceDocumentation = obj.resourceDocumentation;
  return result;
}

const oauthSchema = {
  type: 'object',
  properties: {
    resource: { type: 'string' },
    issuer: { type: 'string' },
    scopes: { type: 'array', items: { type: 'string' } },
    readScope: { type: 'string' },
    writeScope: { type: 'string' },
    clientRegistration: { type: 'string', enum: ['cimd', 'dcr', 'predefined'] },
    jwksUri: { type: 'string' },
    trustedJwksHosts: { type: 'array', items: { type: 'string' } },
    algorithms: { type: 'array', items: { type: 'string' } },
    resourceDocumentation: { type: 'string' },
  },
  additionalProperties: false,
} as const;

export function provisionTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'provision_create',
      description:
        'Provision one governed MCP server for a project folder. Supports none, token, API-key, and OAuth auth; static credentials are returned exactly once.',
      group: 'provision',
      mutates: true,
      risk: 'MEDIUM',
      inputSchema: {
        type: 'object',
        properties: {
          projectPath: { type: 'string' },
          name: { type: 'string' },
          port: { type: 'number' },
          toolsPreset: { type: 'string', enum: [...FLEET_TOOLS_PRESETS] },
          policyMode: { type: 'string', enum: [...FLEET_POLICY_MODES] },
          authMode: { type: 'string', enum: [...FLEET_AUTH_MODES] },
          apiKey: { type: 'string', description: 'Optional operator-provided API key; omit to generate one.' },
          oauth: oauthSchema,
        },
        required: ['projectPath'],
        additionalProperties: false,
      },
      handler: async (args, ctx) =>
        guard(() => {
          const projectPath = resolveFolder(String(args.projectPath), ctx);
          const created = ctx.container.fleet.create({
            projectPath,
            name: args.name !== undefined ? String(args.name) : undefined,
            port: args.port !== undefined ? Number(args.port) : undefined,
            toolsPreset: args.toolsPreset !== undefined ? String(args.toolsPreset) : undefined,
            policyMode: args.policyMode !== undefined ? String(args.policyMode) : undefined,
            authMode: args.authMode !== undefined ? (String(args.authMode) as FleetAuthMode) : undefined,
            apiKey: args.apiKey !== undefined ? String(args.apiKey) : undefined,
            oauth: oauthFromArgs(args.oauth),
            actor: actorOf(ctx),
          });
          ctx.container.audit.record({
            type: 'provision_event',
            summary: `create ${created.instance.id} (${created.instance.projectPath}:${created.instance.port}, auth=${created.instance.authMode}, preset=${created.instance.toolsPreset}, policy=${created.instance.policyMode})`,
          });
          return {
            ok: true,
            data: {
              ...publicInstance(created.instance),
              ...(created.token ? { token: created.token } : {}),
              ...(created.apiKey ? { apiKey: created.apiKey } : {}),
              credentialNote:
                created.token || created.apiKey
                  ? 'Store this credential now. It is returned exactly once and is absent from Fleet state.'
                  : undefined,
            },
          };
        }),
    }),

    defineTool({
      name: 'provision_list',
      description: 'List provisioned per-folder MCP instances without plaintext credentials.',
      group: 'provision',
      mutates: false,
      risk: 'LOW',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (_args, ctx) =>
        guard(() => ({ ok: true, data: { instances: ctx.container.fleet.list().map(publicInstance) } })),
    }),

    defineTool({
      name: 'provision_status',
      description: 'Show one provisioned instance and its non-secret auth/exposure state.',
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
      description: 'Start a provisioned loopback MCP instance. HIGH risk; policy/approval gated.',
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
          ctx.container.audit.record({ type: 'provision_event', summary: `start ${instance.id}` });
          return { ok: true, data: publicInstance(instance) };
        }),
    }),

    defineTool({
      name: 'provision_stop',
      description: 'Stop a running normal Fleet instance gracefully.',
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
      description: 'Read redacted output from a normal Fleet instance.',
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
          return {
            ok: true,
            data: { id, output: ctx.container.policy.secret.redact(ctx.container.fleet.logs(id)) },
          };
        }),
    }),

    defineTool({
      name: 'provision_destroy',
      description: 'Destroy a stopped Fleet instance and remove its mode-0600 secret config. HIGH risk.',
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
          ctx.container.audit.record({ type: 'provision_event', summary: `destroy ${result.destroyed}` });
          return { ok: true, data: result };
        }),
    }),

    defineTool({
      name: 'provision_health',
      description: 'Probe one normal Fleet instance for state, pid liveness, and HTTP responsiveness.',
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
        guardAsync(async () => ({ ok: true, data: await ctx.container.fleet.health(String(args.id)) })),
    }),

    defineTool({
      name: 'provision_restart',
      description: 'Restart a normal Fleet instance. HIGH risk; policy/approval gated.',
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
          ctx.container.audit.record({ type: 'provision_event', summary: `restart ${instance.id}` });
          return { ok: true, data: publicInstance(instance) };
        }),
    }),

    defineTool({
      name: 'provision_update',
      description: 'Update auto-restart, tools preset, and/or policy mode. Preset/policy apply after restart.',
      group: 'provision',
      mutates: true,
      risk: 'MEDIUM',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          autoRestart: { type: 'boolean' },
          toolsPreset: { type: 'string', enum: [...FLEET_TOOLS_PRESETS] },
          policyMode: { type: 'string', enum: [...FLEET_POLICY_MODES] },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args, ctx) =>
        guard(() => {
          const id = String(args.id);
          if (
            typeof args.autoRestart !== 'boolean' &&
            typeof args.toolsPreset !== 'string' &&
            typeof args.policyMode !== 'string'
          ) {
            throw new Error('Nothing to update: pass autoRestart, toolsPreset, and/or policyMode.');
          }
          if (typeof args.autoRestart === 'boolean') ctx.container.fleet.setAutoRestart(id, args.autoRestart);
          if (typeof args.toolsPreset === 'string') ctx.container.fleet.setToolsPreset(id, args.toolsPreset);
          if (typeof args.policyMode === 'string') ctx.container.fleet.setPolicyMode(id, args.policyMode);
          const instance = ctx.container.fleet.get(id);
          ctx.container.audit.record({ type: 'provision_event', summary: `update ${instance.id}` });
          return { ok: true, data: publicInstance(instance) };
        }),
    }),

    defineTool({
      name: 'provision_set_auth',
      description:
        'Change Fleet authentication mode (none|token|api-key|oauth). Static mode changes issue a new credential exactly once.',
      group: 'provision',
      mutates: true,
      risk: 'HIGH',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          mode: { type: 'string', enum: [...FLEET_AUTH_MODES] },
          apiKey: { type: 'string' },
          oauth: oauthSchema,
        },
        required: ['id', 'mode'],
        additionalProperties: false,
      },
      handler: async (args, ctx) =>
        guard(() => {
          const result = ctx.container.fleet.setAuth(String(args.id), {
            mode: String(args.mode) as FleetAuthMode,
            apiKey: args.apiKey !== undefined ? String(args.apiKey) : undefined,
            oauth: oauthFromArgs(args.oauth),
          });
          ctx.container.audit.record({
            type: 'provision_event',
            summary: `auth ${result.instance.id} -> ${result.instance.authMode}`,
          });
          return {
            ok: true,
            data: {
              ...publicInstance(result.instance),
              ...(result.token ? { token: result.token } : {}),
              ...(result.apiKey ? { apiKey: result.apiKey } : {}),
              restartRequired: result.restartRequired,
            },
          };
        }),
    }),

    defineTool({
      name: 'provision_rotate_token',
      description: 'Rotate bearer token auth and return the new token exactly once. HIGH risk.',
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
          const rotated = ctx.container.fleet.rotateToken(String(args.id));
          ctx.container.audit.record({ type: 'provision_event', summary: `rotate token ${rotated.instance.id}` });
          return {
            ok: true,
            data: { ...publicInstance(rotated.instance), token: rotated.token, restartRequired: rotated.restartRequired },
          };
        }),
    }),

    defineTool({
      name: 'provision_rotate_credential',
      description: 'Rotate the active static bearer token or API key and return the new credential exactly once. HIGH risk.',
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
          const rotated = ctx.container.fleet.rotateCredential(String(args.id));
          ctx.container.audit.record({
            type: 'provision_event',
            summary: `rotate ${rotated.kind} ${rotated.instance.id}`,
          });
          return { ok: true, data: { ...publicInstance(rotated.instance), ...rotated } };
        }),
    }),

    defineTool({
      name: 'provision_openai_tunnel_start',
      description:
        'Start the existing FolderForge OpenAI Secure MCP Tunnel supervisor for a Fleet folder. The API key is read from a named environment variable, or an operator-pasted value stored in the 0600 fleet state (never returned by the API). HIGH risk.',
      group: 'provision',
      mutates: true,
      risk: 'HIGH',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tunnelId: { type: 'string' },
          apiKeyEnv: { type: 'string' },
          apiKey: { type: 'string' },
          oauth: { type: 'boolean' },
        },
        required: ['id', 'tunnelId'],
        additionalProperties: false,
      },
      handler: async (args, ctx) =>
        guard(() => {
          const instance = ctx.container.fleet.startOpenAiTunnel(String(args.id), {
            tunnelId: String(args.tunnelId),
            apiKeyEnv: args.apiKeyEnv !== undefined ? String(args.apiKeyEnv) : undefined,
            apiKey: args.apiKey !== undefined ? String(args.apiKey) : undefined,
            oauth: typeof args.oauth === 'boolean' ? args.oauth : undefined,
          });
          ctx.container.audit.record({
            type: 'provision_event',
            summary: `openai tunnel start ${instance.id} tunnel=${instance.openAiTunnel?.tunnelId ?? 'n/a'}`,
          });
          return { ok: true, data: publicInstance(instance) };
        }),
    }),

    defineTool({
      name: 'provision_openai_tunnel_stop',
      description: 'Stop a Fleet OpenAI Secure MCP Tunnel supervisor gracefully.',
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
          const instance = ctx.container.fleet.stopOpenAiTunnel(String(args.id));
          ctx.container.audit.record({ type: 'provision_event', summary: `openai tunnel stop ${instance.id}` });
          return { ok: true, data: publicInstance(instance) };
        }),
    }),

    defineTool({
      name: 'provision_openai_tunnel_logs',
      description: 'Read redacted output from a Fleet OpenAI tunnel supervisor.',
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
          return {
            ok: true,
            data: { id, output: ctx.container.policy.secret.redact(ctx.container.fleet.openAiTunnelLogs(id)) },
          };
        }),
    }),
  ];
}
