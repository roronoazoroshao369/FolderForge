import { PathPolicy } from './path-policy.js';
import { CommandPolicy } from './command-policy.js';
import { SecretPolicy } from './secret-policy.js';
import { ApprovalEngine } from './approvals.js';
import { RISK_ORDER } from './risk.js';
import { PolicyDeniedError, ApprovalRequiredError } from '../core/errors.js';
import { resolve } from 'node:path';
import { PolicyAsCode } from './policy-as-code.js';
function normalizePrincipal(requester) {
    return typeof requester === 'string'
        ? { id: requester, role: 'agent' }
        : requester;
}
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
    asCode;
    mode;
    requireApproval;
    constructor(config) {
        this.config = config;
        this.path = new PathPolicy(config.workspace.allowedDirectories, config.workspace.deniedGlobs);
        this.command = new CommandPolicy(config.policy.blockedCommands);
        this.secret = new SecretPolicy(config.secretScan);
        this.asCode = new PolicyAsCode(config.workspace.defaultProject, config.policy.files ?? []);
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
            policyAsCode: this.asCode.describe(),
        };
    }
    /**
     * Evaluate whether a tool call may proceed.
     * @param toolName name of the tool
     * @param risk computed risk for this specific call
     * @param mutates whether the call mutates state
     * @param args original args (recorded on approval requests)
     */
    evaluate(toolName, risk, mutates, args, requester = 'agent:unknown', options = {}) {
        const principal = normalizePrincipal(requester);
        // Baseline hard-deny boundaries are evaluated before project policy. Policy
        // files are intentionally unable to weaken either rule.
        if (risk === 'CRITICAL' && this.mode !== 'danger') {
            return { kind: 'deny', risk, reason: `CRITICAL action blocked in ${this.mode} mode.` };
        }
        if (this.mode === 'readonly' && mutates && !options.bypassReadonly) {
            return { kind: 'deny', risk, reason: 'Workspace is in readonly mode; mutations are blocked.' };
        }
        const policyRule = this.asCode.evaluate({
            tool: toolName,
            risk,
            mutates,
            mode: this.mode,
            principal,
        });
        if (policyRule?.effect === 'deny') {
            return { kind: 'deny', risk, reason: policyRule.reason };
        }
        let needsApproval = false;
        let approvalReason = '';
        if (risk === 'CRITICAL') {
            needsApproval = !this.config.policy.allowCriticalInDanger;
            approvalReason = 'CRITICAL action requires explicit approval.';
        }
        else {
            const baselineApproval = this.requireApproval.has(toolName) || RISK_ORDER[risk] >= RISK_ORDER.HIGH;
            // Danger mode preserves the historical bypass for baseline non-CRITICAL
            // gates. An explicit policy-as-code approval rule below still wins.
            needsApproval = baselineApproval && this.mode !== 'danger';
            approvalReason = `${toolName} (${risk}) requires approval.`;
        }
        if (policyRule?.effect === 'approval') {
            needsApproval = true;
            approvalReason = policyRule.reason;
        }
        if (!needsApproval)
            return { kind: 'allow', risk };
        if (this.approvals.isSessionAllowed(toolName, principal) ||
            this.approvals.consumeOnce(toolName, args, principal)) {
            return { kind: 'allow', risk };
        }
        return this.toApproval(toolName, risk, args, approvalReason, principal);
    }
    toApproval(toolName, risk, args, reason, requester) {
        const req = this.approvals.create(toolName, args, risk, reason, requester);
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
    explain(toolName, risk, mutates, _args = {}, requester = 'agent:unknown') {
        const principal = normalizePrincipal(requester);
        const factors = [];
        if (risk === 'CRITICAL' && this.mode !== 'danger') {
            factors.push('risk is CRITICAL', `mode is ${this.mode}`);
            return {
                decision: 'deny',
                risk,
                reason: `CRITICAL action blocked in ${this.mode} mode.`,
                mode: this.mode,
                mutates,
                factors,
            };
        }
        if (this.mode === 'readonly' && mutates) {
            factors.push('mode is readonly and the tool mutates state');
            return {
                decision: 'deny',
                risk,
                reason: 'Workspace is in readonly mode; mutations are blocked.',
                mode: this.mode,
                mutates,
                factors,
            };
        }
        const policyRule = this.asCode.evaluate({
            tool: toolName,
            risk,
            mutates,
            mode: this.mode,
            principal,
        });
        if (policyRule) {
            factors.push(`matched policy rule ${policyRule.ruleId}`, `policy effect is ${policyRule.effect}`);
        }
        if (policyRule?.effect === 'deny') {
            return {
                decision: 'deny',
                risk,
                reason: policyRule.reason,
                mode: this.mode,
                mutates,
                factors,
            };
        }
        let needsApproval = false;
        let reason = `${toolName} (${risk}) is allowed.`;
        if (risk === 'CRITICAL') {
            factors.push('risk is CRITICAL');
            needsApproval = !this.config.policy.allowCriticalInDanger;
            reason = needsApproval
                ? 'CRITICAL action requires explicit approval.'
                : 'CRITICAL action is allowed by the danger-mode autonomous-agent escape hatch.';
            if (!needsApproval)
                factors.push('allowCriticalInDanger is enabled');
        }
        else {
            const onApprovalList = this.requireApproval.has(toolName);
            const highRisk = RISK_ORDER[risk] >= RISK_ORDER.HIGH;
            if (onApprovalList)
                factors.push('tool is in requireApproval list');
            if (highRisk)
                factors.push(`risk is ${risk} (>= HIGH)`);
            const baselineApproval = onApprovalList || highRisk;
            needsApproval = baselineApproval && this.mode !== 'danger';
            if (needsApproval)
                reason = `${toolName} (${risk}) requires approval.`;
            else if (baselineApproval) {
                reason = `${toolName} (${risk}) is allowed in danger mode.`;
                factors.push('danger mode bypasses the baseline non-CRITICAL approval gate');
            }
            else {
                factors.push(`risk is ${risk} and allowed in ${this.mode} mode`);
            }
        }
        if (policyRule?.effect === 'approval') {
            needsApproval = true;
            reason = policyRule.reason;
        }
        if (needsApproval && this.approvals.isSessionAllowed(toolName, principal)) {
            factors.push('a principal-bound session approval is already active');
            return {
                decision: 'allow',
                risk,
                reason: `${toolName} is allowed for this principal session.`,
                mode: this.mode,
                mutates,
                factors,
            };
        }
        return {
            decision: needsApproval ? 'approval' : 'allow',
            risk,
            reason,
            mode: this.mode,
            mutates,
            factors,
        };
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
