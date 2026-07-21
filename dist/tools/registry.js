import { TOOL_RISK, RISK_ORDER } from "../policy/risk.js";
import { ApprovalRequiredError, AuditUnavailableError, PolicyDeniedError, } from "../core/errors.js";
import { logger } from "../core/logger.js";
import { randomUUID } from "node:crypto";
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
        ...(def.classifyCall !== undefined
            ? { classifyCall: def.classifyCall }
            : {}),
        handler: def.handler,
    };
}
const SENSITIVE_ACTIVE_ARG_KEY = /(secret|token|password|authorization|cookie|credential|api.?key)/i;
function activeArgKey(key) {
    if (SENSITIVE_ACTIVE_ARG_KEY.test(key))
        return '[sensitive-key]';
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key))
        return '[nonstandard-key]';
    return key;
}
/**
 * Central registry. Holds every tool, computes the curated active subset,
 * and wraps each call with policy evaluation + audit.
 */
export class ToolRegistry {
    container;
    tools = new Map();
    activeSet = null;
    listChangedListeners = new Set();
    activeCalls = new Map();
    constructor(container) {
        this.container = container;
    }
    /** Subscribe to changes in the agent-visible MCP tool catalog. */
    onListChanged(listener) {
        this.listChangedListeners.add(listener);
        return () => this.listChangedListeners.delete(listener);
    }
    register(tool) {
        const before = this.agentSurfaceSnapshot();
        this.tools.set(tool.name, tool);
        this.emitListChangedIfNeeded(before);
    }
    registerAll(tools) {
        const before = this.agentSurfaceSnapshot();
        for (const tool of tools)
            this.tools.set(tool.name, tool);
        this.emitListChangedIfNeeded(before);
    }
    /** Remove registered tools matching a predicate and hide them from routing. */
    unregisterWhere(predicate) {
        const before = this.agentSurfaceSnapshot();
        const removed = [];
        for (const [name, tool] of this.tools) {
            if (!predicate(tool))
                continue;
            this.tools.delete(name);
            this.activeSet?.delete(name);
            removed.push(name);
        }
        this.emitListChangedIfNeeded(before);
        return removed;
    }
    /**
     * Atomically replace a logical tool group and emit at most one catalog change.
     * When routing is active, replacement tools inherit visibility if any removed
     * tool was visible, unless `activate` is supplied explicitly.
     */
    replaceWhere(predicate, replacements, activate) {
        const before = this.agentSurfaceSnapshot();
        const removed = [];
        let removedVisible = false;
        for (const [name, tool] of this.tools) {
            if (!predicate(tool))
                continue;
            removedVisible ||= this.activeSet === null || this.activeSet.has(name);
            this.tools.delete(name);
            this.activeSet?.delete(name);
            removed.push(name);
        }
        for (const tool of replacements)
            this.tools.set(tool.name, tool);
        if (this.activeSet && (activate ?? removedVisible)) {
            for (const tool of replacements)
                this.activeSet.add(tool.name);
        }
        this.emitListChangedIfNeeded(before);
        return removed;
    }
    /** Make newly registered tools visible when a routed subset is active. */
    activate(names) {
        if (!this.activeSet)
            return;
        const before = this.agentSurfaceSnapshot();
        for (const name of names)
            this.activeSet.add(name);
        this.emitListChangedIfNeeded(before);
    }
    get(name) {
        return this.tools.get(name);
    }
    /** Restrict the visible tool set (routing). Pass null to show all. */
    setActive(names) {
        const before = this.agentSurfaceSnapshot();
        this.activeSet = names ? new Set(names) : null;
        this.emitListChangedIfNeeded(before);
    }
    agentSurfaceSnapshot() {
        return JSON.stringify(this.listAgentActive()
            .map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            annotations: tool.annotations,
        }))
            .sort((left, right) => left.name.localeCompare(right.name)));
    }
    emitListChangedIfNeeded(before) {
        if (before === this.agentSurfaceSnapshot())
            return;
        for (const listener of this.listChangedListeners) {
            try {
                listener();
            }
            catch (error) {
                logger.warn({ err: error instanceof Error ? error.message : String(error) }, "Tool list change listener failed");
            }
        }
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
    /** Redacted active invocation inventory for Mission Control. */
    listActiveCalls() {
        return [...this.activeCalls.values()]
            .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
            .map((call) => ({ ...call, argKeys: [...call.argKeys] }));
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
    /** Resolve the effective identity/risk/mutation contract for one invocation. */
    classifyCall(name, rawArgs) {
        const tool = this.tools.get(name);
        if (!tool)
            return undefined;
        const args = rawArgs ?? {};
        let classification = {
            name,
            risk: tool.risk,
            mutates: tool.mutates,
            governanceArgs: args,
        };
        if (name === "shell_exec" && typeof args.command === "string") {
            classification.risk = this.container.policy.command.classify(args.command).risk;
        }
        else if (name === "patch_transaction") {
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
        }
        else if (name === "project_verify") {
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
    async call(name, rawArgs, control) {
        const tool = this.tools.get(name);
        if (!tool) {
            return { ok: false, error: `Unknown tool: ${name}` };
        }
        if (tool.audience === "admin" && control?.principal?.role !== "admin") {
            return { ok: false, error: `Admin-only tool: ${name}` };
        }
        const args = rawArgs ?? {};
        const classification = this.classifyCall(name, args);
        const principal = control?.principal;
        if (principal?.authMode === "oauth") {
            const requiredScopes = classification.mutates
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
        return this.runPipeline({
            name: classification.name,
            group: tool.group,
            risk: classification.risk,
            mutates: classification.mutates,
            handler: tool.handler,
        }, classification.governanceArgs ?? args, control, args);
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
    async callDynamic(descriptor, rawArgs, control) {
        return this.runPipeline(descriptor, rawArgs ?? {}, control);
    }
    /**
     * The shared governance pipeline: cancellation check -> audit -> policy
     * evaluate -> approval -> rate-limit -> handler -> audit result. Registered
     * tools, dynamically classified dispatchers, and internal ad-hoc operations
     * all converge here exactly once per logical operation.
     */
    async runPipeline(descriptor, governanceArgs, control, handlerArgs = governanceArgs) {
        const { name, risk, mutates } = descriptor;
        const started = Date.now();
        // P6 - cancellation: if the client already cancelled before we start (or
        // cancels during the synchronous policy/rate-limit checks below), refuse
        // early instead of doing work the caller no longer wants.
        if (control?.signal?.aborted) {
            return { ok: false, error: "Tool call cancelled before execution." };
        }
        const principal = control?.principal ?? {
            id: "agent:unknown",
            role: "agent",
        };
        const capsuleDecision = this.container.capsules
            ? this.container.capsules.check(principal, this.container.projectRoot(), { name, group: descriptor.group ?? "dynamic", risk, mutates, args: governanceArgs })
            : { kind: "allow" };
        const approvalPrincipal = capsuleDecision.capsule
            ? {
                ...principal,
                capsuleId: capsuleDecision.capsule.id,
                ...(capsuleDecision.capsule.taskId
                    ? { taskId: capsuleDecision.capsule.taskId }
                    : {}),
            }
            : principal;
        const containmentBypass = this.container.missionControl?.allowsContainmentAction(name, approvalPrincipal) ?? false;
        const identityDetail = {
            ...principalAuditDetail(approvalPrincipal),
            ...(containmentBypass ? { containmentAction: true } : {}),
        };
        const activeCallId = `call_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
        this.activeCalls.set(activeCallId, {
            id: activeCallId,
            tool: name,
            group: descriptor.group ?? "dynamic",
            risk,
            mutates,
            principalId: principal.id,
            role: principal.role,
            projectRoot: this.container.projectRoot(),
            startedAt: new Date(started).toISOString(),
            argKeys: Object.keys(governanceArgs).slice(0, 32).map(activeArgKey),
            ...(principal.sessionId ? { sessionId: principal.sessionId } : {}),
            ...(principal.oauthClientId ? { clientId: principal.oauthClientId } : {}),
            ...(capsuleDecision.capsule ? { capsuleId: capsuleDecision.capsule.id } : {}),
            ...(approvalPrincipal.taskId ? { taskId: approvalPrincipal.taskId } : {}),
            ...(containmentBypass ? { containmentAction: true } : {}),
        });
        const auditRequired = this.container.audit.requiresDurability?.({ risk, principal }) ?? false;
        const recordAudit = (event) => {
            this.container.audit.record(event, { required: auditRequired });
        };
        let executionStarted = false;
        try {
            recordAudit({
                type: "tool_call",
                tool: name,
                risk,
                summary: summarizeArgs(name, governanceArgs, (value) => this.container.policy.secret.redactValue(value)),
                detail: identityDetail,
            });
            if (capsuleDecision.kind === "deny") {
                const reason = `Workspace Capsule denied the call: ${capsuleDecision.reason ?? "not permitted"}`;
                recordAudit({
                    type: "policy_deny",
                    tool: name,
                    risk,
                    summary: reason,
                    detail: identityDetail,
                });
                return { ok: false, error: `Denied: ${reason}` };
            }
            const decision = this.container.policy.evaluate(name, risk, mutates, governanceArgs, approvalPrincipal, { bypassReadonly: containmentBypass });
            if (decision.kind === "deny") {
                recordAudit({
                    type: "policy_deny",
                    tool: name,
                    risk,
                    summary: decision.reason,
                    detail: identityDetail,
                });
                return { ok: false, error: `Denied: ${decision.reason}` };
            }
            if (decision.kind === "approval") {
                recordAudit({
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
                recordAudit({
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
                if (capsuleDecision.capsule && this.container.capsules) {
                    this.container.capsules.reserve(capsuleDecision.capsule.id, mutates);
                }
                executionStarted = true;
                const result = await descriptor.handler(handlerArgs, {
                    config: this.container.config,
                    projectRoot: this.container.projectRoot(),
                    ...(control !== undefined ? { control } : {}),
                    container: this.container,
                });
                recordAudit({
                    type: result.ok ? "tool_result" : "tool_error",
                    tool: name,
                    risk,
                    ok: result.ok,
                    durationMs: Date.now() - started,
                    summary: result.ok ? "ok" : (result.error ?? "error"),
                    detail: identityDetail,
                });
                return result;
            }
            catch (err) {
                if (err instanceof AuditUnavailableError)
                    throw err;
                const message = err instanceof ApprovalRequiredError
                    ? `Approval required: ${err.message} (id=${err.approvalId})`
                    : err instanceof PolicyDeniedError
                        ? `Denied: ${err.message}`
                        : err instanceof Error
                            ? err.message
                            : String(err);
                logger.error({ tool: name, err: message }, "tool error");
                recordAudit({
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
        catch (err) {
            if (!(err instanceof AuditUnavailableError))
                throw err;
            logger.error({ tool: name, risk, executionStarted, code: err.code }, "Required audit storage unavailable");
            if (executionStarted) {
                return {
                    ok: false,
                    error: "AUDIT_OUTCOME_UNCERTAIN: Tool execution completed or may have partially completed, but terminal audit evidence could not be persisted. Do not retry automatically.",
                };
            }
            return { ok: false, error: `${err.code}: ${err.message}` };
        }
        finally {
            this.activeCalls.delete(activeCallId);
        }
    }
}
function principalAuditDetail(principal) {
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
        ...(principal.capsuleId ? { capsuleId: principal.capsuleId } : {}),
        ...(principal.taskId ? { taskId: principal.taskId } : {}),
    };
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
