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
export function deriveAnnotations(name, mutates, risk, override) {
    const destructive = mutates && RISK_ORDER[risk] >= RISK_ORDER.HIGH;
    const annotations = {
        title: titleCase(name),
        readOnlyHint: !mutates,
        destructiveHint: destructive,
        idempotentHint: !mutates,
        openWorldHint: false,
        ...override,
    };
    return annotations;
}
function titleCase(name) {
    return name
        .split("_")
        .map((p) => (p ? (p[0] ?? "").toUpperCase() + p.slice(1) : p))
        .join(" ");
}
/**
 * Helper to declare a tool with sensible defaults.
 */
export function defineTool(def) {
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
        annotations: deriveAnnotations(def.name, def.mutates, risk, def.annotations),
        handler: def.handler,
    };
}
/**
 * Central registry. Holds every tool, computes the curated active subset,
 * and wraps each call with policy evaluation + audit.
 */
export class ToolRegistry {
    container;
    tools = new Map();
    activeSet = null;
    constructor(container) {
        this.container = container;
    }
    register(tool) {
        this.tools.set(tool.name, tool);
    }
    registerAll(tools) {
        for (const t of tools)
            this.register(t);
    }
    /** Remove registered tools matching a predicate and hide them from routing. */
    unregisterWhere(predicate) {
        const removed = [];
        for (const [name, tool] of this.tools) {
            if (!predicate(tool))
                continue;
            this.tools.delete(name);
            this.activeSet?.delete(name);
            removed.push(name);
        }
        return removed;
    }
    /** Make newly registered tools visible when a routed subset is active. */
    activate(names) {
        if (!this.activeSet)
            return;
        for (const name of names)
            this.activeSet.add(name);
    }
    get(name) {
        return this.tools.get(name);
    }
    /** Restrict the visible tool set (routing). Pass null to show all. */
    setActive(names) {
        this.activeSet = names ? new Set(names) : null;
    }
    listActive() {
        const all = [...this.tools.values()];
        if (!this.activeSet)
            return all;
        return all.filter((t) => this.activeSet.has(t.name));
    }
    /** Tools visible to an agent-facing MCP client. Admin tools never cross this boundary. */
    listAgentActive() {
        return this.listActive().filter((tool) => tool.audience === "agent");
    }
    listAll() {
        return [...this.tools.values()];
    }
    /** Invoke a tool through the agent plane, never with admin authority. */
    async callAgent(name, rawArgs, control) {
        const principal = {
            ...(control?.principal ?? {}),
            id: control?.principal?.id ?? "agent:unknown",
            role: "agent",
        };
        return this.call(name, rawArgs, { ...control, principal });
    }
    /** Execute a tool through the policy + audit pipeline. */
    async call(name, rawArgs, control) {
        const tool = this.tools.get(name);
        if (!tool) {
            return { ok: false, error: `Unknown tool: ${name}` };
        }
        if (tool.audience === "admin" && control?.principal?.role !== "admin") {
            return { ok: false, error: `Admin-only tool: ${name}` };
        }
        const principal = control?.principal;
        if (principal?.authMode === "oauth") {
            const requiredScopes = tool.mutates
                ? [principal.readScope, principal.writeScope]
                : [principal.readScope];
            const presentScopes = requiredScopes.filter((scope) => Boolean(scope));
            if (presentScopes.length !== requiredScopes.length) {
                return {
                    ok: false,
                    error: "OAuth principal is missing scope policy context",
                };
            }
            const missing = presentScopes.filter((scope) => !(principal.scopes ?? []).includes(scope));
            if (missing.length > 0) {
                return {
                    ok: false,
                    error: `OAuth scope required before tool execution: ${missing.join(" ")}`,
                };
            }
        }
        const args = rawArgs ?? {};
        // Determine per-call risk (shell can be re-classified by the handler later,
        // but we evaluate the base risk here too).
        let risk = tool.risk;
        let mutates = tool.mutates;
        if (name === "shell_exec" && typeof args.command === "string") {
            const cls = this.container.policy.command.classify(args.command);
            risk = cls.risk;
        }
        else if (name === "patch_transaction") {
            const action = String(args.action ?? "preview");
            if (action === "preview" || action === "status") {
                risk = "LOW";
                mutates = false;
            }
            else {
                risk = args.force === true ? "HIGH" : "MEDIUM";
                mutates = true;
            }
        }
        else if (name === "project_verify") {
            if (args.dryRun === true) {
                risk = "LOW";
                mutates = false;
            }
            else {
                // Test/lint/typecheck scripts are executable project code even when no
                // build step is requested. Keep all real verification runs governed as
                // MEDIUM; only a non-executing dry run is safe in readonly mode.
                risk = "MEDIUM";
                mutates = true;
            }
        }
        return this.runPipeline({ name, risk, mutates, handler: tool.handler }, args, control);
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
    async callDynamic(descriptor, rawArgs, control) {
        return this.runPipeline(descriptor, rawArgs ?? {}, control);
    }
    /**
     * The shared governance pipeline: cancellation check -> audit -> policy
     * evaluate -> approval/elicitation -> rate-limit -> handler -> audit result.
     * Both native `call` and facade `callDynamic` funnel through here so there is
     * exactly one governance path and a facade can never bypass it.
     */
    async runPipeline(descriptor, args, control) {
        const { name, risk, mutates } = descriptor;
        const started = Date.now();
        // P6 - cancellation: if the client already cancelled before we start (or
        // cancels during the synchronous policy/rate-limit checks below), refuse
        // early instead of doing work the caller no longer wants.
        if (control?.signal?.aborted) {
            return { ok: false, error: "Tool call cancelled before execution." };
        }
        const requesterId = control?.principal?.id ?? "agent:unknown";
        this.container.audit.record({
            type: "tool_call",
            tool: name,
            risk,
            summary: summarizeArgs(name, args, (value) => this.container.policy.secret.redactValue(value)),
            detail: {
                requesterId,
                authMode: control?.principal?.authMode ?? "none",
                ...(control?.principal?.oauthClientId
                    ? { oauthClientId: control.principal.oauthClientId }
                    : {}),
            },
        });
        const decision = this.container.policy.evaluate(name, risk, mutates, args, requesterId);
        if (decision.kind === "deny") {
            this.container.audit.record({
                type: "policy_deny",
                tool: name,
                risk,
                summary: decision.reason,
            });
            return { ok: false, error: `Denied: ${decision.reason}` };
        }
        if (decision.kind === "approval") {
            this.container.audit.record({
                type: "approval_request",
                tool: name,
                risk,
                summary: decision.reason,
                detail: { approvalId: decision.approvalId },
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
            const result = await descriptor.handler(args, {
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
            });
            return result;
        }
        catch (err) {
            const message = err instanceof ApprovalRequiredError
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
            });
            return { ok: false, error: message };
        }
    }
}
function boundSummaryValue(value, depth = 0) {
    if (depth >= 3)
        return "[TRUNCATED]";
    if (typeof value === "string")
        return value.slice(0, 256);
    if (Array.isArray(value))
        return value.slice(0, 4).map((item) => boundSummaryValue(item, depth + 1));
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .slice(0, 8)
            .map(([key, child]) => [key, boundSummaryValue(child, depth + 1)]));
    }
    return value;
}
function summarizeArgs(name, args, redact) {
    const keys = Object.keys(args);
    if (keys.length === 0)
        return name;
    const preview = Object.fromEntries(keys.slice(0, 4).map((key) => [key, boundSummaryValue(args[key])]));
    const safeArgs = redact(preview);
    return keys
        .slice(0, 4)
        .map((key) => {
        const value = safeArgs[key];
        const serialized = typeof value === "string" ? value : JSON.stringify(value);
        return `${key}=${String(serialized).slice(0, 60)}`;
    })
        .join(" ");
}
