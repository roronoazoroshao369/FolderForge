import type {
  ToolDefinition,
  ToolResult,
  ToolCallControl,
  RiskLevel,
  ToolAnnotations,
  ToolAudience,
  ToolPrincipal,
  ToolCallClassification,
} from "../core/types.js";
import type { Container } from "../core/container.js";
import { TOOL_RISK, RISK_ORDER } from "../policy/risk.js";
import { ApprovalRequiredError, PolicyDeniedError } from "../core/errors.js";
import { logger } from "../core/logger.js";

/**
 * Derive MCP tool annotations from the existing `mutates` / `risk` contract.
 *
 * This is intentionally a pure mapping so annotations stay in lock-step with
 * the frozen schema and never need to be hand-maintained:
 *   - `mutates === false`        => readOnlyHint: true
 *   - risk HIGH or CRITICAL      => destructiveHint: true (mutating only)
 *   - read-only tools            => idempotentHint: true
 * `openWorldHint` is opt-in per tool (e.g. web/http/browser) since most tools
 * act only on the local workspace; callers may pass an override.
 */
export function deriveAnnotations(
  name: string,
  mutates: boolean,
  risk: RiskLevel,
  override?: Partial<ToolAnnotations>,
): ToolAnnotations {
  const destructive = mutates && RISK_ORDER[risk] >= RISK_ORDER.HIGH;
  const annotations: ToolAnnotations = {
    title: titleCase(name),
    readOnlyHint: !mutates,
    destructiveHint: destructive,
    idempotentHint: !mutates,
    openWorldHint: false,
    ...override,
  };
  return annotations;
}

function titleCase(name: string): string {
  return name
    .split("_")
    .map((p) => (p ? (p[0] ?? "").toUpperCase() + p.slice(1) : p))
    .join(" ");
}

/**
 * Helper to declare a tool with sensible defaults.
 */
export function defineTool(def: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  group: string;
  mutates: boolean;
  risk?: RiskLevel;
  audience?: ToolAudience;
  outputSchema?: Record<string, unknown>;
  /** Per-tool annotation overrides (e.g. openWorldHint for web tools). */
  annotations?: Partial<ToolAnnotations>;
  /** Optional dynamic classification resolved before OAuth and governance. */
  classifyCall?: ToolDefinition["classifyCall"];
  handler: ToolDefinition["handler"];
}): ToolDefinition {
  const risk = def.risk ?? TOOL_RISK[def.name] ?? "MEDIUM";
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    ...(def.outputSchema !== undefined
      ? { outputSchema: def.outputSchema }
      : {}),
    group: def.group,
    audience: def.audience ?? "agent",
    mutates: def.mutates,
    risk,
    annotations: deriveAnnotations(
      def.name,
      def.mutates,
      risk,
      def.annotations,
    ),
    ...(def.classifyCall !== undefined
      ? { classifyCall: def.classifyCall }
      : {}),
    handler: def.handler,
  };
}

/**
 * Central registry. Holds every tool, computes the curated active subset,
 * and wraps each call with policy evaluation + audit.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private activeSet: Set<string> | null = null;

  constructor(private container: Container) {}

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: ToolDefinition[]): void {
    for (const t of tools) this.register(t);
  }

  /** Remove registered tools matching a predicate and hide them from routing. */
  unregisterWhere(predicate: (tool: ToolDefinition) => boolean): string[] {
    const removed: string[] = [];
    for (const [name, tool] of this.tools) {
      if (!predicate(tool)) continue;
      this.tools.delete(name);
      this.activeSet?.delete(name);
      removed.push(name);
    }
    return removed;
  }

  /** Make newly registered tools visible when a routed subset is active. */
  activate(names: string[]): void {
    if (!this.activeSet) return;
    for (const name of names) this.activeSet.add(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Restrict the visible tool set (routing). Pass null to show all. */
  setActive(names: string[] | null): void {
    this.activeSet = names ? new Set(names) : null;
  }

  listActive(): ToolDefinition[] {
    const all = [...this.tools.values()];
    if (!this.activeSet) return all;
    return all.filter((t) => this.activeSet!.has(t.name));
  }

  /** Tools visible to an agent-facing MCP client. Admin tools never cross this boundary. */
  listAgentActive(): ToolDefinition[] {
    return this.listActive().filter((tool) => tool.audience === "agent");
  }

  listAll(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Invoke a tool through the agent plane, never with admin authority. */
  async callAgent(
    name: string,
    rawArgs: Record<string, unknown>,
    control?: ToolCallControl,
  ): Promise<ToolResult> {
    const principal: ToolPrincipal = {
      ...(control?.principal ?? {}),
      id: control?.principal?.id ?? "agent:unknown",
      role: "agent",
    };
    return this.call(name, rawArgs, { ...control, principal });
  }

  /** Resolve the effective identity/risk/mutation contract for one invocation. */
  classifyCall(
    name: string,
    rawArgs: Record<string, unknown>,
  ): ToolCallClassification | undefined {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    const args = rawArgs ?? {};

    let classification: ToolCallClassification = {
      name,
      risk: tool.risk,
      mutates: tool.mutates,
      governanceArgs: args,
    };

    if (name === "shell_exec" && typeof args.command === "string") {
      classification.risk = this.container.policy.command.classify(
        args.command,
      ).risk;
    } else if (name === "patch_transaction") {
      const action = String(args.action ?? "preview");
      classification =
        action === "preview" || action === "status"
          ? { name, risk: "LOW", mutates: false, governanceArgs: args }
          : {
              name,
              risk: args.force === true ? "HIGH" : "MEDIUM",
              mutates: true,
              governanceArgs: args,
            };
    } else if (name === "project_verify") {
      classification =
        args.dryRun === true
          ? { name, risk: "LOW", mutates: false, governanceArgs: args }
          : { name, risk: "MEDIUM", mutates: true, governanceArgs: args };
    }

    if (tool.classifyCall) {
      const dynamic = tool.classifyCall(args);
      classification = {
        ...dynamic,
        governanceArgs: dynamic.governanceArgs ?? args,
      };
    }
    return classification;
  }

  /** Execute a tool through one policy + audit pipeline. */
  async call(
    name: string,
    rawArgs: Record<string, unknown>,
    control?: ToolCallControl,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `Unknown tool: ${name}` };
    }
    if (tool.audience === "admin" && control?.principal?.role !== "admin") {
      return { ok: false, error: `Admin-only tool: ${name}` };
    }

    const args = rawArgs ?? {};
    const classification = this.classifyCall(name, args)!;
    const principal = control?.principal;
    if (principal?.authMode === "oauth") {
      const requiredScopes = classification.mutates
        ? [principal.readScope, principal.writeScope]
        : [principal.readScope];
      const presentScopes = requiredScopes.filter((scope): scope is string =>
        Boolean(scope),
      );
      if (presentScopes.length !== requiredScopes.length) {
        return {
          ok: false,
          error: "OAuth principal is missing scope policy context",
        };
      }
      const missing = presentScopes.filter(
        (scope) => !(principal.scopes ?? []).includes(scope),
      );
      if (missing.length > 0) {
        return {
          ok: false,
          error: `OAuth scope required before tool execution: ${missing.join(" ")}`,
        };
      }
    }

    return this.runPipeline(
      {
        name: classification.name,
        risk: classification.risk,
        mutates: classification.mutates,
        handler: tool.handler,
      },
      classification.governanceArgs ?? args,
      control,
      args,
    );
  }

  /**
   * Run an ad-hoc operation through the same governance pipeline as {@link call},
   * keyed on a caller-supplied identity/risk/mutation classification.
   *
   * Dispatcher tools should normally prefer `ToolDefinition.classifyCall`, which
   * resolves their effective contract before OAuth and avoids a nested pipeline.
   * This lower-level entry point remains available for internal operations that
   * are not represented by a registered public tool.
   */
  async callDynamic(
    descriptor: {
      name: string;
      risk: RiskLevel;
      mutates: boolean;
      handler: ToolDefinition["handler"];
    },
    rawArgs: Record<string, unknown>,
    control?: ToolCallControl,
  ): Promise<ToolResult> {
    return this.runPipeline(descriptor, rawArgs ?? {}, control);
  }

  /**
   * The shared governance pipeline: cancellation check -> audit -> policy
   * evaluate -> approval -> rate-limit -> handler -> audit result. Registered
   * tools, dynamically classified dispatchers, and internal ad-hoc operations
   * all converge here exactly once per logical operation.
   */
  private async runPipeline(
    descriptor: {
      name: string;
      risk: RiskLevel;
      mutates: boolean;
      handler: ToolDefinition["handler"];
    },
    governanceArgs: Record<string, unknown>,
    control?: ToolCallControl,
    handlerArgs: Record<string, unknown> = governanceArgs,
  ): Promise<ToolResult> {
    const { name, risk, mutates } = descriptor;
    const started = Date.now();

    // P6 - cancellation: if the client already cancelled before we start (or
    // cancels during the synchronous policy/rate-limit checks below), refuse
    // early instead of doing work the caller no longer wants.
    if (control?.signal?.aborted) {
      return { ok: false, error: "Tool call cancelled before execution." };
    }

    const principal = control?.principal ?? { id: "agent:unknown", role: "agent" as const };
    const identityDetail = principalAuditDetail(principal);
    this.container.audit.record({
      type: "tool_call",
      tool: name,
      risk,
      summary: summarizeArgs(name, governanceArgs, (value) =>
        this.container.policy.secret.redactValue(value),
      ),
      detail: identityDetail,
    });
    const decision = this.container.policy.evaluate(
      name,
      risk,
      mutates,
      governanceArgs,
      principal,
    );
    if (decision.kind === "deny") {
      this.container.audit.record({
        type: "policy_deny",
        tool: name,
        risk,
        summary: decision.reason,
        detail: identityDetail,
      });
      return { ok: false, error: `Denied: ${decision.reason}` };
    }
    if (decision.kind === "approval") {
      this.container.audit.record({
        type: "approval_request",
        tool: name,
        risk,
        summary: decision.reason,
        detail: { ...identityDetail, approvalId: decision.approvalId },
      });

      // Agent-facing protocol controls may report or render the request, but they
      // cannot resolve it. Resolution is confined to the authenticated admin plane.
      return {
        ok: false,
        approvalId: decision.approvalId,
        error: `Approval required (${risk}). Resolve in the dashboard admin plane. id=${decision.approvalId}`,
      };
    }

    // Rate limit / quota: applied only to calls that policy would actually
    // run. Denied or approval-gated calls never consume quota.
    const rl = this.container.rateLimiter.hit(name);
    if (!rl.allowed) {
      this.container.audit.record({
        type: "rate_limited",
        tool: name,
        risk,
        summary: rl.reason ?? "rate limited",
        detail: {
          ...identityDetail,
          retryAfterMs: rl.retryAfterMs,
          windowCount: rl.windowCount,
          dailyCount: rl.dailyCount,
        },
      });
      return {
        ok: false,
        error: `${rl.reason} Retry in ~${Math.ceil((rl.retryAfterMs ?? 0) / 1000)}s.`,
      };
    }

    try {
      const result = await descriptor.handler(handlerArgs, {
        config: this.container.config,
        projectRoot: this.container.projectRoot(),
        ...(control !== undefined ? { control } : {}),
        container: this.container,
      });
      this.container.audit.record({
        type: result.ok ? "tool_result" : "tool_error",
        tool: name,
        risk,
        ok: result.ok,
        durationMs: Date.now() - started,
        summary: result.ok ? "ok" : (result.error ?? "error"),
        detail: identityDetail,
      });
      return result;
    } catch (err) {
      const message =
        err instanceof ApprovalRequiredError
          ? `Approval required: ${err.message} (id=${err.approvalId})`
          : err instanceof PolicyDeniedError
            ? `Denied: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
      logger.error({ tool: name, err: message }, "tool error");
      this.container.audit.record({
        type: "tool_error",
        tool: name,
        risk,
        ok: false,
        durationMs: Date.now() - started,
        summary: message,
        detail: identityDetail,
      });
      return { ok: false, error: message };
    }
  }
}

function principalAuditDetail(principal: ToolPrincipal): Record<string, unknown> {
  return {
    requesterId: principal.id,
    role: principal.role,
    roles: principal.roles ?? [principal.role],
    authMode: principal.authMode ?? "none",
    ...(principal.organizationId ? { organizationId: principal.organizationId } : {}),
    ...(principal.teamIds?.length ? { teamIds: principal.teamIds } : {}),
    ...(principal.projectId ? { projectId: principal.projectId } : {}),
    ...(principal.sessionId ? { sessionId: principal.sessionId } : {}),
    ...(principal.oauthClientId ? { oauthClientId: principal.oauthClientId } : {}),
  };
}

function boundSummaryValue(value: unknown, depth = 0): unknown {
  if (depth >= 3) return "[TRUNCATED]";
  if (typeof value === "string") return value.slice(0, 256);
  if (Array.isArray(value))
    return value.slice(0, 4).map((item) => boundSummaryValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 8)
        .map(([key, child]) => [key, boundSummaryValue(child, depth + 1)]),
    );
  }
  return value;
}

function summarizeArgs(
  name: string,
  args: Record<string, unknown>,
  redact: (value: unknown) => unknown,
): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return name;
  const preview = Object.fromEntries(
    keys.slice(0, 4).map((key) => [key, boundSummaryValue(args[key])]),
  );
  const safeArgs = redact(preview) as Record<string, unknown>;
  return keys
    .slice(0, 4)
    .map((key) => {
      const value = safeArgs[key];
      const serialized =
        typeof value === "string" ? value : JSON.stringify(value);
      return `${key}=${String(serialized).slice(0, 60)}`;
    })
    .join(" ");
}
