import type {
  ToolDefinition,
  ToolResult,
  ToolCallControl,
  RiskLevel,
  ToolAnnotations,
} from '../core/types.js';
import type { Container } from '../core/container.js';
import { TOOL_RISK, RISK_ORDER } from '../policy/risk.js';
import { ApprovalRequiredError, PolicyDeniedError } from '../core/errors.js';
import { logger } from '../core/logger.js';

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
  override?: Partial<ToolAnnotations>
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
    .split('_')
    .map((p) => (p ? (p[0] ?? '').toUpperCase() + p.slice(1) : p))
    .join(' ');
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
  outputSchema?: Record<string, unknown>;
  /** Per-tool annotation overrides (e.g. openWorldHint for web tools). */
  annotations?: Partial<ToolAnnotations>;
  handler: ToolDefinition['handler'];
}): ToolDefinition {
  const risk = def.risk ?? TOOL_RISK[def.name] ?? 'MEDIUM';
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    ...(def.outputSchema !== undefined ? { outputSchema: def.outputSchema } : {}),
    group: def.group,
    mutates: def.mutates,
    risk,
    annotations: deriveAnnotations(def.name, def.mutates, risk, def.annotations),
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

  listAll(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Execute a tool through the policy + audit pipeline. */
  async call(
    name: string,
    rawArgs: Record<string, unknown>,
    control?: ToolCallControl
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `Unknown tool: ${name}` };
    }
    const args = rawArgs ?? {};

    // Determine per-call risk (shell can be re-classified by the handler later,
    // but we evaluate the base risk here too).
    let risk = tool.risk;
    let mutates = tool.mutates;
    if (name === 'shell_exec' && typeof args.command === 'string') {
      const cls = this.container.policy.command.classify(args.command);
      risk = cls.risk;
    } else if (name === 'patch_transaction') {
      const action = String(args.action ?? 'preview');
      if (action === 'preview' || action === 'status') {
        risk = 'LOW';
        mutates = false;
      } else {
        risk = args.force === true ? 'HIGH' : 'MEDIUM';
        mutates = true;
      }
    } else if (name === 'project_verify') {
      if (args.dryRun === true) {
        risk = 'LOW';
        mutates = false;
      } else {
        // Test/lint/typecheck scripts are executable project code even when no
        // build step is requested. Keep all real verification runs governed as
        // MEDIUM; only a non-executing dry run is safe in readonly mode.
        risk = 'MEDIUM';
        mutates = true;
      }
    }

    return this.runPipeline(
      { name, risk, mutates, handler: tool.handler },
      args,
      control
    );
  }

  /**
   * Run an ad-hoc tool through the identical governance pipeline as {@link call},
   * keyed on a caller-supplied identity/risk/mutation classification.
   *
   * This is the governance re-entry point for facade sub-ops (see
   * docs/mcp-facade.md, Step 5). A facade `<adapter>__call_tool` handler must NOT
   * forward straight to the child; instead it resolves the sub-op's own
   * risk/mutates and calls this method with a synthetic name
   * (`<adapter>__call_tool:<subtool>`) so policy mode, approval/elicitation,
   * rate-limit, and audit all fire per sub-op and the audit trail records the
   * real sub-tool - never a single bland dispatcher line.
   */
  async callDynamic(
    descriptor: {
      name: string;
      risk: RiskLevel;
      mutates: boolean;
      handler: ToolDefinition['handler'];
    },
    rawArgs: Record<string, unknown>,
    control?: ToolCallControl
  ): Promise<ToolResult> {
    return this.runPipeline(descriptor, rawArgs ?? {}, control);
  }

  /**
   * The shared governance pipeline: cancellation check -> audit -> policy
   * evaluate -> approval/elicitation -> rate-limit -> handler -> audit result.
   * Both native `call` and facade `callDynamic` funnel through here so there is
   * exactly one governance path and a facade can never bypass it.
   */
  private async runPipeline(
    descriptor: {
      name: string;
      risk: RiskLevel;
      mutates: boolean;
      handler: ToolDefinition['handler'];
    },
    args: Record<string, unknown>,
    control?: ToolCallControl
  ): Promise<ToolResult> {
    const { name, risk, mutates } = descriptor;
    const started = Date.now();

    // P6 - cancellation: if the client already cancelled before we start (or
    // cancels during the synchronous policy/rate-limit checks below), refuse
    // early instead of doing work the caller no longer wants.
    if (control?.signal?.aborted) {
      return { ok: false, error: 'Tool call cancelled before execution.' };
    }

    this.container.audit.record({
      type: 'tool_call',
      tool: name,
      risk,
      summary: summarizeArgs(name, args),
    });

    const decision = this.container.policy.evaluate(name, risk, mutates, args);
    if (decision.kind === 'deny') {
      this.container.audit.record({ type: 'policy_deny', tool: name, risk, summary: decision.reason });
      return { ok: false, error: `Denied: ${decision.reason}` };
    }
    if (decision.kind === 'approval') {
      this.container.audit.record({
        type: 'approval_request',
        tool: name,
        risk,
        summary: decision.reason,
        detail: { approvalId: decision.approvalId },
      });

      // Interactive approval (MCP elicitation): when the connected client
      // advertised the `elicitation` capability, ask the user to Approve/Deny
      // right in the chat instead of forcing them to the dashboard. On accept we
      // resolve the pending request and fall through to run the tool; on
      // decline/cancel we deny it and return. Clients without elicitation see
      // `control.elicitInput === undefined` and fall back to the dashboard flow
      // (unchanged behaviour), so this is purely additive.
      if (control?.elicitInput) {
        let elicited: { action: string; content?: Record<string, unknown> };
        try {
          elicited = await control.elicitInput({
            message:
              `Approve "${name}" (${risk})?\n${decision.reason}\n` +
              `Args: ${summarizeArgs(name, args)}\n` +
              `Choose "session" to allow this tool for the rest of the session.`,
            requestedSchema: {
              type: 'object',
              properties: {
                approve: {
                  type: 'boolean',
                  description: 'Allow this action to run.',
                },
                scope: {
                  type: 'string',
                  enum: ['once', 'session'],
                  description:
                    'once = this call only; session = remember for this session.',
                },
              },
              required: ['approve'],
            },
          });
        } catch (err) {
          logger.warn(
            { tool: name, err: String(err) },
            'Elicitation failed; falling back to dashboard approval'
          );
          return {
            ok: false,
            approvalId: decision.approvalId,
            error: `Approval required (${risk}). Resolve in the dashboard or via approval tools. id=${decision.approvalId}`,
          };
        }

        const approved =
          elicited.action === 'accept' && elicited.content?.approve === true;
        if (!approved) {
          this.container.policy.approvals.deny(decision.approvalId);
          this.container.audit.record({
            type: 'approval_resolved',
            tool: name,
            risk,
            summary: `denied via elicitation (${elicited.action})`,
            detail: { approvalId: decision.approvalId },
          });
          return {
            ok: false,
            error: `"${name}" was not approved (${elicited.action}).`,
          };
        }

        const scope = elicited.content?.scope === 'session' ? 'session' : 'once';
        this.container.policy.approvals.approve(decision.approvalId, scope);
        this.container.audit.record({
          type: 'approval_resolved',
          tool: name,
          risk,
          summary: `approved via elicitation (${scope})`,
          detail: { approvalId: decision.approvalId },
        });
        // Fall through to rate-limit + execute below.
      } else {
        // No interactive capability: keep the dashboard/approval-tool flow.
        return {
          ok: false,
          approvalId: decision.approvalId,
          error: `Approval required (${risk}). Resolve in the dashboard or via approval tools. id=${decision.approvalId}`,
        };
      }
    }

    // Rate limit / quota: applied only to calls that policy would actually
    // run. Denied or approval-gated calls never consume quota.
    const rl = this.container.rateLimiter.hit(name);
    if (!rl.allowed) {
      this.container.audit.record({
        type: 'rate_limited',
        tool: name,
        risk,
        summary: rl.reason ?? 'rate limited',
        detail: { retryAfterMs: rl.retryAfterMs, windowCount: rl.windowCount, dailyCount: rl.dailyCount },
      });
      return {
        ok: false,
        error: `${rl.reason} Retry in ~${Math.ceil((rl.retryAfterMs ?? 0) / 1000)}s.`,
      };
    }

    try {
      const result = await descriptor.handler(args, {
        config: this.container.config,
        projectRoot: this.container.projectRoot(),
        ...(control !== undefined ? { control } : {}),
        container: this.container,
      });
      this.container.audit.record({
        type: result.ok ? 'tool_result' : 'tool_error',
        tool: name,
        risk,
        ok: result.ok,
        durationMs: Date.now() - started,
        summary: result.ok ? 'ok' : result.error ?? 'error',
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
      logger.error({ tool: name, err: message }, 'tool error');
      this.container.audit.record({
        type: 'tool_error',
        tool: name,
        risk,
        ok: false,
        durationMs: Date.now() - started,
        summary: message,
      });
      return { ok: false, error: message };
    }
  }
}

function summarizeArgs(name: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return name;
  const parts = keys.slice(0, 4).map((k) => {
    const v = args[k];
    const s = typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v);
    return `${k}=${s}`;
  });
  return parts.join(' ');
}
