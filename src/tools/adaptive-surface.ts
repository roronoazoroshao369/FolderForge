/**
 * Adaptive tool surface (the webcodex `adaptive_runtime` pattern, applied to
 * FolderForge's native registry).
 *
 * Under `--tools-preset adaptive`, `tools/list` advertises only a small,
 * high-frequency typed coding core (file read/write/edit, search, shell +
 * process lifecycle, git basics, test/lint/build) plus two meta tools:
 *
 *  - `call_runtime_tool` — the gateway to every other registered agent tool.
 *    Its `classifyCall` delegates to the TARGET tool's own classification
 *    (including dynamic re-classification such as shell_exec's minimum HIGH),
 *    so the single governance pipeline — OAuth scope gate, workspace capsule,
 *    policy evaluate, approval, rate limit, audit — is keyed exactly as a
 *    direct call to that target. The handler then invokes the target's
 *    handler with the same context: one pipeline, no nested dispatch, no
 *    bypass. Unknown names, admin-only tools, and the gateway pair itself
 *    are refused.
 *
 *  - `tool_manifest` — describes one tool: description, input schema,
 *    annotations, group, risk/mutates, output-schema presence, and routing
 *    (`availability`: `direct` when listed, `gateway` when reachable only via
 *    `call_runtime_tool`, `unavailable` otherwise).
 */

import type { ToolDefinition, ToolResult } from '../core/types.js';
import { defineTool, type ToolRegistry } from './registry.js';

export const ADAPTIVE_PRESET = 'adaptive';

export const GATEWAY_CALL_TOOL = 'call_runtime_tool';
export const GATEWAY_MANIFEST_TOOL = 'tool_manifest';

/**
 * High-frequency coding core advertised directly on the adaptive surface.
 * Everything else registered remains reachable through the gateway.
 */
export const ADAPTIVE_CORE_TOOLS: readonly string[] = [
  // Workspace recovery/diagnosis (kept so a client can always self-check).
  'workspace_status',
  'workspace_health',
  'workspace_activate',
  // Files.
  'file_read',
  'file_read_many',
  'file_write',
  'file_edit_block',
  'list_directory',
  // Search.
  'search_text',
  'search_files',
  // Shell + managed processes.
  'shell_exec',
  'process_start',
  'process_read',
  'process_tail',
  'process_stop',
  'process_list',
  // Git basics.
  'git_status',
  'git_diff',
  'git_log',
  'git_add',
  'git_commit',
  'git_branch',
  'git_checkout',
  // Verification loop.
  'run_test',
  'run_lint',
  'run_typecheck',
  'run_build',
];

/** The complete adaptive surface: typed core + the gateway pair. */
export const ADAPTIVE_SURFACE_TOOLS: readonly string[] = [
  ...ADAPTIVE_CORE_TOOLS,
  GATEWAY_CALL_TOOL,
  GATEWAY_MANIFEST_TOOL,
];

export type ToolAvailability = 'direct' | 'gateway' | 'unavailable';

/** Resolve how one tool is reachable from the current surface. */
export function toolAvailability(registry: ToolRegistry, name: string): ToolAvailability {
  const tool = registry.get(name);
  if (!tool || tool.audience !== 'agent') return 'unavailable';
  const visible = registry.listAgentActive().some((entry) => entry.name === name);
  return visible ? 'direct' : 'gateway';
}

/** Arguments object passed through to the gateway target. */
function targetArguments(args: Record<string, unknown>): Record<string, unknown> {
  const value = args.arguments;
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A gateway target must be a registered, agent-facing tool — never the gateway
 * pair itself (recursion) and never an admin-only tool.
 */
function acceptableTarget(registry: ToolRegistry, name: string): ToolDefinition | undefined {
  if (!name || name === GATEWAY_CALL_TOOL || name === GATEWAY_MANIFEST_TOOL) return undefined;
  const tool = registry.get(name);
  if (!tool || tool.audience !== 'agent') return undefined;
  return tool;
}

/** Build the `call_runtime_tool` + `tool_manifest` pair bound to a registry. */
export function buildGatewayTools(registry: ToolRegistry): ToolDefinition[] {
  const callTool = defineTool({
    name: GATEWAY_CALL_TOOL,
    description:
      'Gateway to FolderForge tools not listed directly on the adaptive surface. ' +
      `Call ${GATEWAY_MANIFEST_TOOL} with a tool name first to read its exact input ` +
      'schema, annotations, and routing. The call is governed exactly like a direct ' +
      'call: it is re-classified to the target tool before policy/approval/audit, ' +
      'so there is no governance bypass. Unknown, admin-only, and gateway-tool ' +
      'targets are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: `Target tool name (inspect it first with ${GATEWAY_MANIFEST_TOOL}).`,
        },
        arguments: {
          type: 'object',
          description: "Arguments for the target tool, matching its inputSchema. Defaults to {}.",
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    group: 'gateway',
    // Static envelope is read-only so scope-filtered listings keep the gateway
    // visible to read-only OAuth principals (every CONCRETE call is still
    // re-classified to the target's real contract by classifyCall below — the
    // call path remains the authoritative gate). Same dispatcher pattern as
    // `<adapter>__call_tool`.
    mutates: false,
    risk: 'MEDIUM',
    classifyCall: (args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      const target = acceptableTarget(registry, name);
      if (!target) {
        // Refusal happens in the handler with a precise message; keep the
        // conservative envelope for the policy pass.
        return { name: GATEWAY_CALL_TOOL, risk: 'MEDIUM', mutates: true, governanceArgs: {} };
      }
      const targetArgs = targetArguments(args);
      // Delegate to the target's own classification (including dynamic ones
      // such as shell_exec's per-command minimum HIGH), so policy, OAuth scope
      // checks, capsules, rate limits, and audit are keyed exactly as a direct
      // call to that target.
      return (
        registry.classifyCall(target.name, targetArgs) ?? {
          name: target.name,
          risk: target.risk,
          mutates: target.mutates,
          governanceArgs: targetArgs,
        }
      );
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const name = typeof args.name === 'string' ? args.name : '';
      const target = acceptableTarget(registry, name);
      if (!target) {
        return {
          ok: false,
          error:
            `${GATEWAY_CALL_TOOL}: unknown, admin-only, or gateway tool: ` +
            `${name || '(missing "name")'}. Use ${GATEWAY_MANIFEST_TOOL} to inspect callable tools.`,
        };
      }
      // Governance already ran once with the target's own classification (see
      // classifyCall above); invoke the target handler with the same context.
      return target.handler(targetArguments(args), ctx);
    },
  });

  const manifestTool = defineTool({
    name: GATEWAY_MANIFEST_TOOL,
    description:
      'Describe one FolderForge tool: description, input schema, annotations, ' +
      'group, risk/mutates, output-schema presence, and current routing ' +
      "(`availability`: 'direct' when listed, 'gateway' when callable only via " +
      `${GATEWAY_CALL_TOOL}, 'unavailable' otherwise). Describes invocation ` +
      'routing, not authorization. Accepts "names" (array, max 50) to describe ' +
      'several tools in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name to describe.' },
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Batch mode: describe several tools in one call (max 50).',
        },
      },
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        availability: { type: 'string', enum: ['direct', 'gateway', 'unavailable'] },
      },
      required: ['name', 'availability'],
    },
    group: 'gateway',
    mutates: false,
    risk: 'LOW',
    handler: async (args): Promise<ToolResult> => {
      const describeOne = (raw: unknown) => {
        const name = typeof raw === 'string' ? raw.trim() : '';
        const availability = name ? toolAvailability(registry, name) : 'unavailable';
        const tool = name ? registry.get(name) : undefined;
        if (!tool || availability === 'unavailable') {
          return { name, availability: 'unavailable' as ToolAvailability };
        }
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
          group: tool.group,
          risk: tool.risk,
          mutates: tool.mutates,
          availability,
          ...(availability === 'gateway' ? { gatewayTool: GATEWAY_CALL_TOOL } : {}),
          hasOutputSchema: tool.outputSchema !== undefined,
        };
      };
      if (Array.isArray(args.names)) {
        return { ok: true, data: { manifests: args.names.slice(0, 50).map(describeOne) } };
      }
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (!name) {
        return { ok: false, error: `${GATEWAY_MANIFEST_TOOL}: "name" or "names" is required.` };
      }
      return { ok: true, data: describeOne(name) };
    },
  });

  return [callTool, manifestTool];
}
