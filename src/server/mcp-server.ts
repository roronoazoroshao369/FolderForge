import { createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  CancelTaskRequestSchema,
  GetPromptRequestSchema,
  GetTaskPayloadRequestSchema,
  GetTaskRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListTasksRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  RELATED_TASK_META_KEY,
  type CallToolResult,
  type Task,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type {
  ToolResult,
  ToolCallControl,
  ToolDefinition,
  ElicitRequestParams,
  ElicitResult,
  ToolPrincipal,
} from '../core/types.js';
import { logger } from '../core/logger.js';
import type { Container } from '../runtime/container.js';
import { buildBearerChallenge } from './auth/oauth.js';
import { McpPromptCatalog } from './mcp-prompts.js';
import { McpResourceCatalog, McpResourceSubscriptions } from './mcp-resources.js';
import { GATEWAY_CALL_TOOL } from '../tools/adaptive-surface.js';
import { TASK_PRESETS } from '../tools/task-presets.js';

const MAX_MUTATION_REPLAY_ENTRIES = 256;

interface MutationReplayEntry {
  fingerprint: string;
  operationId: string;
  promise: Promise<ToolResult>;
  settled: boolean;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)])
    );
  }
  return value === undefined ? '[undefined]' : value;
}

function mutationFingerprint(name: string, args: Record<string, unknown>): string {
  return createHash('sha256')
    .update(name)
    .update('\0')
    .update(JSON.stringify(canonicalValue(args)))
    .digest('hex');
}

function mutationOperationId(
  principal: ToolPrincipal,
  requestId: string,
  fingerprint: string
): string {
  return `op_${createHash('sha256')
    .update(principal.id)
    .update('\0')
    .update(principal.sessionId ?? 'stateless')
    .update('\0')
    .update(requestId)
    .update('\0')
    .update(fingerprint)
    .digest('hex')
    .slice(0, 24)}`;
}

export interface McpServerInfo {
  name: string;
  version: string;
  /**
   * Workspace roots (absolute dirs) the server operates within. Surfaced to the
   * client through the server `instructions` string (roadmap P5). Mirrors the
   * policy `allowedDirectories`.
   */
  roots?: string[];
  /** Authenticated identity for this agent-facing MCP connection. */
  principal?: ToolPrincipal;
  /**
   * Adaptive-surface option: for OAuth principals, hide tools whose required
   * scopes are absent from `tools/list` (mirrors webcodex scope-filtered
   * listing). The call path remains the authoritative gate; the listing is a
   * routing hint. Default false: other presets keep their existing surface.
   */
  hideScopeInsufficientTools?: boolean;
  /** Shared runtime state for resources, prompts, and durable MCP tasks. */
  container?: Container;
}

/**
 * Build an MCP {@link Server} backed by the FolderForge {@link ToolRegistry}.
 *
 * The server always exposes governed tools. When a shared {@link Container} is
 * supplied, it also exposes bounded resources, reusable prompts, subscriptions,
 * and principal-bound MCP tasks. Every task-augmented tool call still delegates
 * to {@link ToolRegistry.callAgent}; the task layer is orchestration and durable
 * evidence, not a policy bypass.
 *
 * `tools/list` additionally advertises, when present:
 *  - `outputSchema`  (MCP structured tool output, 2025-06-18)
 *  - `annotations`   (readOnly/destructive/idempotent hints, derived from
 *                     the frozen mutates/risk contract in defineTool)
 *
 * Transport binding (stdio / http) is handled separately in `server/transports/*`.
 */
export function createMcpServer(registry: ToolRegistry, info: McpServerInfo): Server {
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
  const principal: ToolPrincipal = info.principal ?? { id: 'agent:mcp', role: 'agent' };
  const hideScopeInsufficient = info.hideScopeInsufficientTools === true;
  const advancedProtocol = info.container !== undefined;
  const mutationReplay = new Map<string, MutationReplayEntry>();
  const pruneMutationReplay = (): void => {
    while (mutationReplay.size > MAX_MUTATION_REPLAY_ENTRIES) {
      const settled = [...mutationReplay.entries()].find(([, entry]) => entry.settled);
      if (!settled) return;
      mutationReplay.delete(settled[0]);
    }
  };
  const listChangedRegistry = registry as ToolRegistry & {
    onListChanged?: (listener: () => void) => () => void;
  };
  const supportsToolListChanged = typeof listChangedRegistry.onListChanged === 'function';
  const server = new Server(
    { name: info.name, version: info.version },
    {
      capabilities: {
        tools: supportsToolListChanged ? { listChanged: true } : {},
        ...(advancedProtocol
          ? {
              resources: { subscribe: true, listChanged: false },
              prompts: { listChanged: false },
              tasks: {
                list: {},
                cancel: {},
                requests: { tools: { call: {} } },
              },
            }
          : {}),
      },
      instructions:
        'FolderForge: local development control plane. All tools run through a ' +
        'policy + audit pipeline; tool annotations (readOnlyHint/destructiveHint) ' +
        'are hints only. Resources expose bounded live state, prompts encode ' +
        'governed engineering workflows, and task-augmented tool calls remain ' +
        'principal-bound and use the same policy pipeline.' +
        rootsLine,
    }
  );

  const prompts = advancedProtocol ? new McpPromptCatalog() : undefined;
  const resources = info.container
    ? new McpResourceCatalog(info.container, info.container.mcpTasks, principal)
    : undefined;
  const subscriptions = resources
    ? new McpResourceSubscriptions(server, resources)
    : undefined;
  const disposeToolListChanged =
    listChangedRegistry.onListChanged?.(() => {
      void server.sendToolListChanged().catch((error: unknown) => {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'Failed to notify MCP client that the tool list changed',
        );
      });
    }) ?? (() => undefined);
  const notifyTask = async (task: Task): Promise<void> => {
    await server.notification({
      method: 'notifications/tasks/status',
      params: task,
    });
  };

  if (resources && prompts && info.container) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      assertScope(principal, false);
      return { resources: resources.list() };
    });
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      assertScope(principal, false);
      return resources.read(request.params.uri);
    });
    server.setRequestHandler(SubscribeRequestSchema, async (request) => {
      assertScope(principal, false);
      await subscriptions?.subscribe(request.params.uri);
      return {};
    });
    server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
      assertScope(principal, false);
      subscriptions?.unsubscribe(request.params.uri);
      return {};
    });
    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      assertScope(principal, false);
      return { prompts: prompts.list() };
    });
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      assertScope(principal, false);
      return prompts.get(request.params.name, request.params.arguments ?? {});
    });
    server.setRequestHandler(GetTaskRequestSchema, async (request) => {
      assertScope(principal, false);
      return info.container!.mcpTasks.get(request.params.taskId, principal);
    });
    server.setRequestHandler(ListTasksRequestSchema, async (request) => {
      assertScope(principal, false);
      return info.container!.mcpTasks.list(principal, request.params?.cursor);
    });
    server.setRequestHandler(CancelTaskRequestSchema, async (request) => {
      assertScope(principal, true);
      return info.container!.mcpTasks.cancel(request.params.taskId, principal, notifyTask);
    });
    server.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => {
      assertScope(principal, false);
      const stored = info.container!.mcpTasks.result(request.params.taskId, principal);
      const result = toCallToolResult(stored.result, stored.hasOutputSchema);
      return {
        ...result,
        _meta: {
          ...(result._meta ?? {}),
          [RELATED_TASK_META_KEY]: { taskId: request.params.taskId },
        },
      };
    });
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Adaptive surface: for OAuth principals, hide tools whose required scopes
    // are absent (webcodex-style scope-filtered listing). The call path stays
    // the authoritative gate; the listing is a routing hint. Scope-hiding also
    // follows the ACTIVE surface: routing to `adaptive` at runtime via
    // workspace_route enables it even when the server started on another
    // preset (the gateway pair only ever appears on the adaptive surface).
    const activeTools = registry.listAgentActive();
    // The runtime-routed adaptive surface is exactly TASK_PRESETS.adaptive. An
    // unrouted (reset) listing legitimately contains every registered tool —
    // including the gateway pair — and must NOT flip scope-hiding on, so the
    // whole active set must fit the adaptive name list, not just contain it.
    const adaptiveSurfaceNames = new Set<string>(TASK_PRESETS['adaptive'] ?? []);
    const adaptiveActive =
      activeTools.some((t) => t.name === GATEWAY_CALL_TOOL) &&
      activeTools.every((t) => adaptiveSurfaceNames.has(t.name));
    const listedTools =
      (hideScopeInsufficient || adaptiveActive) && principal.authMode === 'oauth'
        ? activeTools.filter((t) => hasRequiredScopes(t, principal))
        : activeTools;
    const tools: Tool[] = listedTools.map((t) => {
      const tool: Tool = {
        name: t.name,
        description: t.description,
        inputSchema: toJsonSchema(t.inputSchema),
      };
      // Advertise structured output schema (MCP outputSchema) when a tool
      // declares one. Clients use it to validate `structuredContent`.
      if (t.outputSchema) {
        (tool as Tool & { outputSchema?: unknown }).outputSchema = toJsonSchema(
          t.outputSchema
        );
      }
      // Advertise behaviour hints. Derived from mutates/risk in defineTool;
      // hints only - never a security boundary.
      if (t.annotations) {
        tool.annotations = t.annotations;
      }
      if (advancedProtocol) {
        tool.execution = { taskSupport: 'optional' };
      }
      if (info.principal?.authMode === 'oauth') {
        const scopes = t.mutates
          ? [info.principal.readScope, info.principal.writeScope].filter(
              (scope): scope is string => Boolean(scope)
            )
          : [info.principal.readScope].filter((scope): scope is string => Boolean(scope));
        const securitySchemes: Array<{ type: 'oauth2'; scopes: string[] }> = [
          { type: 'oauth2', scopes },
        ];
        const extended = tool as Tool & {
          securitySchemes?: Array<{ type: 'oauth2'; scopes: string[] }>;
          _meta?: Record<string, unknown>;
        };
        extended.securitySchemes = securitySchemes;
        extended._meta = { ...(extended._meta ?? {}), securitySchemes };
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
    const elicit: ToolCallControl['elicitInput'] = server.getClientCapabilities()
      ?.elicitation
      ? async (params: ElicitRequestParams): Promise<ElicitResult> => {
          const r = await server.elicitInput(
            params as Parameters<typeof server.elicitInput>[0]
          );
          const action = r.action as ElicitResult['action'];
          return r.content !== undefined ? { action, content: r.content } : { action };
        }
      : undefined;

    // P4 - progress: only emit when the client opted in by sending a
    // progressToken in the request _meta. Mirrors the SDK contract.
    const reportProgress: ToolCallControl['reportProgress'] =
      progressToken === undefined
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
    const control: ToolCallControl = {
      principal,
      // P6 - cancellation: the SDK aborts `extra.signal` on a notifications/
      // cancelled for this request id. Handlers long-poll against it the same
      // way ProcessManager.readUntil waits on its own waiters.
      signal: extra.signal,
      ...(reportProgress !== undefined ? { reportProgress } : {}),
      ...(elicit !== undefined ? { elicitInput: elicit } : {}),
    };

    const tool = registry.get(name);
    const callArgs = (args ?? {}) as Record<string, unknown>;
    const classification = registry.classifyCall(name, callArgs);
    const oauthPrincipal = info.principal;
    if (tool && oauthPrincipal?.authMode === 'oauth') {
      const effectiveMutates = classification?.mutates ?? tool.mutates;
      const requiredScopes = effectiveMutates
        ? [oauthPrincipal.readScope, oauthPrincipal.writeScope].filter(
            (scope): scope is string => Boolean(scope)
          )
        : [oauthPrincipal.readScope].filter((scope): scope is string => Boolean(scope));
      const hasScopes = requiredScopes.every((scope) =>
        (oauthPrincipal.scopes ?? []).includes(scope)
      );
      if (!hasScopes && oauthPrincipal.resourceMetadataUrl) {
        const challenge = buildBearerChallenge({
          resourceMetadataUrl: oauthPrincipal.resourceMetadataUrl,
          scopes: requiredScopes,
          error: 'insufficient_scope',
          errorDescription: `Tool ${name} requires scope${requiredScopes.length === 1 ? '' : 's'} ${requiredScopes.join(' ')}`,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Authentication scope required before tool execution: ${requiredScopes.join(' ')}`,
            },
          ],
          isError: true,
          _meta: { 'mcp/www_authenticate': [challenge] },
        };
      }
    }

    if (request.params.task && info.container) {
      const task = await info.container.mcpTasks.createToolTask({
        registry,
        principal,
        tool: name,
        args: callArgs,
        ...(request.params.task.ttl !== undefined
          ? { ttl: request.params.task.ttl }
          : {}),
        notify: notifyTask,
      });
      return { task };
    }

    const effectiveMutates = classification?.mutates ?? tool?.mutates ?? false;
    if (!effectiveMutates) {
      const result = await registry.callAgent(name, callArgs, control);
      return toCallToolResult(result, Boolean(tool?.outputSchema));
    }

    const requestKey = `${typeof extra.requestId}:${String(extra.requestId)}`;
    const fingerprint = mutationFingerprint(name, callArgs);
    const existing = mutationReplay.get(requestKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return toCallToolResult(
          {
            ok: false,
            operationId: existing.operationId,
            execution: 'not_started',
            error:
              'MCP_REQUEST_ID_CONFLICT: this request id was already used for a different mutating call in the current session.',
          },
          Boolean(tool?.outputSchema)
        );
      }
      const original = await existing.promise;
      const replayOperationId = original.operationId ?? existing.operationId;
      const replayed: ToolResult = {
        ...original,
        operationId: replayOperationId,
        execution:
          original.execution === 'executed'
            ? 'replayed'
            : (original.execution ?? 'replayed'),
      };
      try {
        info.container?.audit.record(
          {
            type: 'tool_replay',
            tool: name,
            ok: replayed.ok,
            summary: 'duplicate mutating request returned from session replay ledger',
            detail: {
              operationId: replayOperationId,
              requestId: requestKey,
              requesterId: principal.id,
              ...(principal.sessionId ? { sessionId: principal.sessionId } : {}),
            },
          },
          { required: false }
        );
      } catch (error) {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'Failed to record mutation replay evidence'
        );
      }
      return toCallToolResult(replayed, Boolean(tool?.outputSchema));
    }

    const operationId = mutationOperationId(principal, requestKey, fingerprint);
    const executionControl: ToolCallControl = { ...control, operationId };
    const promise = registry.callAgent(name, callArgs, executionControl);
    const entry: MutationReplayEntry = {
      fingerprint,
      operationId,
      promise,
      settled: false,
    };
    mutationReplay.set(requestKey, entry);
    void promise
      .finally(() => {
        entry.settled = true;
        pruneMutationReplay();
      })
      .catch(() => undefined);
    pruneMutationReplay();
    const result = await promise;
    return toCallToolResult(result, Boolean(tool?.outputSchema));
  });

  server.onclose = () => {
    disposeToolListChanged();
    subscriptions?.dispose();
  };
  server.onerror = (err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'MCP server error');
  };

  return server;
}

/** True when the OAuth principal holds every scope the tool requires. */
function hasRequiredScopes(tool: ToolDefinition, principal: ToolPrincipal): boolean {
  const required = tool.mutates
    ? [principal.readScope, principal.writeScope]
    : [principal.readScope];
  return required
    .filter((scope): scope is string => Boolean(scope))
    .every((scope) => (principal.scopes ?? []).includes(scope));
}

function assertScope(principal: ToolPrincipal, mutates: boolean): void {
  if (principal.authMode !== 'oauth') return;
  const required = mutates
    ? [principal.readScope, principal.writeScope]
    : [principal.readScope];
  const scopes = required.filter((scope): scope is string => Boolean(scope));
  if (scopes.length !== required.length) {
    throw new Error('OAuth principal is missing FolderForge scope policy context.');
  }
  const missing = scopes.filter((scope) => !(principal.scopes ?? []).includes(scope));
  if (missing.length > 0) {
    throw new Error(`OAuth scope required: ${missing.join(' ')}`);
  }
}

/**
 * Tool input schemas are stored as plain JSON-schema objects. The MCP SDK
 * requires the top-level `type` to be `"object"`; normalize defensively.
 */
function toJsonSchema(schema: Record<string, unknown>): Tool['inputSchema'] {
  const base = schema && typeof schema === 'object' ? schema : {};
  return { type: 'object', ...base } as Tool['inputSchema'];
}

/**
 * Convert a FolderForge {@link ToolResult} into an MCP `tools/call` result.
 *
 * Exported for unit testing of the structuredContent mirroring contract.
 */
export function toCallToolResult(result: ToolResult, hasOutputSchema = false): CallToolResult {
  const richContent = result.content ?? [];

  if (!result.ok) {
    const text = result.approvalId
      ? `${result.error ?? 'Approval required'}\n(approvalId=${result.approvalId})`
      : result.error ?? 'Tool call failed';
    const content: CallToolResult['content'] = [{ type: 'text', text }];
    const displayData = withoutPromotedContent(result.data, richContent.length > 0);
    if (
      displayData !== undefined ||
      result.diff !== undefined ||
      result.operationId !== undefined ||
      result.execution !== undefined
    ) {
      content.push({
        type: 'text',
        text: JSON.stringify(
          {
            ...(displayData !== undefined ? { data: displayData } : {}),
            ...(result.diff !== undefined ? { diff: result.diff } : {}),
            ...(result.operationId !== undefined ? { operationId: result.operationId } : {}),
            ...(result.execution !== undefined ? { execution: result.execution } : {}),
          },
          null,
          2
        ),
      });
    }
    appendRichContent(content, richContent);
    const out: CallToolResult = { content, isError: true };
    if (hasOutputSchema && result.data !== undefined && result.data !== null) {
      (out as CallToolResult & { structuredContent?: Record<string, unknown> }).structuredContent =
        result.data as Record<string, unknown>;
    }
    return out;
  }

  const payload: Record<string, unknown> = {};
  const displayData = withoutPromotedContent(result.data, richContent.length > 0);
  if (displayData !== undefined) payload.data = displayData;
  if (result.diff !== undefined) payload.diff = result.diff;
  if (result.operationId !== undefined) payload.operationId = result.operationId;
  if (result.execution !== undefined) payload.execution = result.execution;

  const text =
    result.diff &&
    displayData === undefined &&
    result.operationId === undefined &&
    result.execution === undefined
      ? result.diff
      : JSON.stringify(Object.keys(payload).length ? payload : { ok: true }, null, 2);

  // The text block always leads for backwards compatibility. Rich MCP blocks
  // follow it so vision-capable clients receive images directly instead of a
  // JSON-escaped base64 string nested inside `data.content`.
  const content: CallToolResult['content'] = [{ type: 'text', text }];
  appendRichContent(content, richContent);

  const out: CallToolResult = { content };

  // When a tool declares an outputSchema, also return machine-readable
  // structuredContent so spec-aware clients can consume typed output without
  // re-parsing the text block (MCP 2025-06-18 structured tool output).
  if (hasOutputSchema && result.data !== undefined && result.data !== null) {
    (out as CallToolResult & { structuredContent?: Record<string, unknown> }).structuredContent =
      result.data as Record<string, unknown>;
  }

  return out;
}

function withoutPromotedContent(data: unknown, promoted: boolean): unknown {
  if (!promoted || typeof data !== 'object' || data === null || Array.isArray(data)) return data;
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.content)) return data;

  const clone = { ...record };
  delete clone.content;
  return Object.keys(clone).length > 0 ? clone : undefined;
}

function appendRichContent(
  target: CallToolResult['content'],
  blocks: NonNullable<ToolResult['content']>
): void {
  for (const block of blocks) {
    if (block.kind === 'text') {
      target.push({ type: 'text', text: block.text });
    } else if (block.kind === 'image') {
      target.push({ type: 'image', data: block.data, mimeType: block.mimeType });
    } else if (block.kind === 'resource') {
      target.push({
        type: 'resource',
        resource: {
          uri: block.uri,
          text: block.text,
          ...(block.mimeType ? { mimeType: block.mimeType } : {}),
          ...(block.title ? { title: block.title } : {}),
        },
      } as CallToolResult['content'][number]);
    } else if (block.kind === 'resource_link') {
      target.push({
        type: 'resource_link',
        uri: block.uri,
        ...(block.name ? { name: block.name } : {}),
        ...(block.title ? { title: block.title } : {}),
        ...(block.description ? { description: block.description } : {}),
        ...(block.mimeType ? { mimeType: block.mimeType } : {}),
      } as CallToolResult['content'][number]);
    }
  }
}
