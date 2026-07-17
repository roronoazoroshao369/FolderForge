import { PathPolicy } from './path-policy.js';
import { CommandPolicy } from './command-policy.js';
import { SecretPolicy } from './secret-policy.js';
import { ApprovalEngine } from './approvals.js';
import { RISK_ORDER } from './risk.js';
import { PolicyDeniedError, ApprovalRequiredError } from '../core/errors.js';
import { resolve } from 'node:path';
/**
 * The PolicyEngine ties together path, command, secret policies, the risk
 * model, the policy mode, and the approval queue into a single decision point.
 */
export class PolicyEngine {
    config;
    path;
    command;
    secret;
    approvals;
    mode;
    requireApproval;
    constructor(config) {
        this.config = config;
        this.path = new PathPolicy(config.workspace.allowedDirectories, config.workspace.deniedGlobs);
        this.command = new CommandPolicy(config.policy.blockedCommands);
        this.secret = new SecretPolicy(config.secretScan);
        // Persist approvals under the project's .folderforge dir so pending and
        // resolved requests survive restarts. Falls back to in-memory if unset.
        const persistPath = process.env.FOLDERFORGE_APPROVALS_PATH ||
            (config.workspace.defaultProject
                ? resolve(config.workspace.defaultProject, '.folderforge', 'approvals.jsonl')
                : undefined);
        this.approvals = new ApprovalEngine({
            ...(persistPath ? { persistPath } : {}),
            approvalTtlMs: config.policy.approvalTtlMs,
            sanitizeArgs: (args) => this.secret.redactValue(args),
        });
        this.mode = config.policy.defaultMode;
        this.requireApproval = new Set(config.policy.requireApproval);
    }
    getMode() {
        return this.mode;
    }
    setMode(mode) {
        this.mode = mode;
    }
    describe() {
        return {
            mode: this.mode,
            allowCriticalInDanger: this.config.policy.allowCriticalInDanger,
            requireApproval: [...this.requireApproval],
            blockedCommands: this.config.policy.blockedCommands,
            allowedDirectories: this.config.workspace.allowedDirectories,
            deniedGlobs: this.config.workspace.deniedGlobs,
        };
    }
    /**
     * Evaluate whether a tool call may proceed.
     * @param toolName name of the tool
     * @param risk computed risk for this specific call
     * @param mutates whether the call mutates state
     * @param args original args (recorded on approval requests)
     */
    evaluate(toolName, risk, mutates, args, requesterId = 'agent:unknown') {
        // CRITICAL is denied in every mode except danger. In danger it normally
        // still requires explicit approval, unless the operator enabled the
        // autonomous-agent escape hatch for an isolated environment.
        if (risk === 'CRITICAL') {
            if (this.mode !== 'danger') {
                return { kind: 'deny', risk, reason: `CRITICAL action blocked in ${this.mode} mode.` };
            }
            if (this.config.policy.allowCriticalInDanger) {
                return { kind: 'allow', risk };
            }
            // An admin-approved allowance is bound to the requesting principal.
            if (this.approvals.isSessionAllowed(toolName, requesterId) ||
                this.approvals.consumeOnce(toolName, args, requesterId)) {
                return { kind: 'allow', risk };
            }
            return this.toApproval(toolName, risk, args, 'CRITICAL action requires explicit approval.', requesterId);
        }
        // readonly: any mutation is denied.
        if (this.mode === 'readonly' && mutates) {
            return { kind: 'deny', risk, reason: 'Workspace is in readonly mode; mutations are blocked.' };
        }
        // Explicit approval list or HIGH risk -> approval.
        const needsApproval = this.requireApproval.has(toolName) || RISK_ORDER[risk] >= RISK_ORDER.HIGH;
        if (needsApproval) {
            // danger mode intentionally bypasses approval gating for non-CRITICAL
            // actions: the operator has opted into an "anything goes" mode.
            if (this.mode === 'danger') {
                return { kind: 'allow', risk };
            }
            if (this.approvals.isSessionAllowed(toolName, requesterId) ||
                this.approvals.consumeOnce(toolName, args, requesterId)) {
                return { kind: 'allow', risk };
            }
            return this.toApproval(toolName, risk, args, `${toolName} (${risk}) requires approval.`, requesterId);
        }
        // MEDIUM allowed in safe/dev/danger; audited by caller.
        return { kind: 'allow', risk };
    }
    toApproval(toolName, risk, args, reason, requesterId) {
        const req = this.approvals.create(toolName, args, risk, reason, requesterId);
        return { kind: 'approval', risk, approvalId: req.id, reason };
    }
    /**
     * Dry-run a tool call and explain the decision WITHOUT side effects.
     *
     * Unlike {@link evaluate}, this never creates an approval request, never
     * records audit events, and never mutates session state. It mirrors the same
     * decision logic and returns a structured, human-readable explanation so an
     * agent can reason about whether a call would be allowed, denied, or gated.
     */
    explain(toolName, risk, mutates, args = {}) {
        const factors = [];
        let decision;
        let reason;
        if (risk === 'CRITICAL') {
            factors.push('risk is CRITICAL');
            if (this.mode !== 'danger') {
                decision = 'deny';
                reason = `CRITICAL action blocked in ${this.mode} mode.`;
            }
            else if (this.config.policy.allowCriticalInDanger) {
                decision = 'allow';
                reason = 'CRITICAL action is allowed by the danger-mode autonomous-agent escape hatch.';
                factors.push('mode is danger and allowCriticalInDanger is enabled');
            }
            else {
                decision = 'approval';
                reason = 'CRITICAL action requires explicit approval.';
                factors.push('mode is danger (CRITICAL allowed only via approval)');
            }
        }
        else if (this.mode === 'readonly' && mutates) {
            factors.push('mode is readonly and the tool mutates state');
            decision = 'deny';
            reason = 'Workspace is in readonly mode; mutations are blocked.';
        }
        else {
            const onApprovalList = this.requireApproval.has(toolName);
            const highRisk = RISK_ORDER[risk] >= RISK_ORDER.HIGH;
            if (onApprovalList)
                factors.push(`tool is in requireApproval list`);
            if (highRisk)
                factors.push(`risk is ${risk} (>= HIGH)`);
            if (onApprovalList || highRisk) {
                if (this.mode === 'danger') {
                    factors.push('mode is danger, so non-CRITICAL approval gates are bypassed');
                    decision = 'allow';
                    reason = `${toolName} (${risk}) is allowed in danger mode.`;
                }
                else if (this.approvals.isSessionAllowed(toolName)) {
                    factors.push('a session-scoped approval is already active for this tool');
                    decision = 'allow';
                    reason = `${toolName} is allowed for this session.`;
                }
                else {
                    decision = 'approval';
                    reason = `${toolName} (${risk}) requires approval.`;
                }
            }
            else {
                factors.push(`risk is ${risk} and allowed in ${this.mode} mode`);
                decision = 'allow';
                reason = `${toolName} (${risk}) is allowed.`;
            }
        }
        return { decision, risk, reason, mode: this.mode, mutates, factors };
    }
    /** Convenience: throws unless the decision is allow. */
    enforce(decision) {
        if (decision.kind === 'deny')
            throw new PolicyDeniedError(decision.reason);
        if (decision.kind === 'approval') {
            throw new ApprovalRequiredError(decision.reason, decision.approvalId);
        }
    }
}
