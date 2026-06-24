import { PathPolicy } from './path-policy.js';
import { CommandPolicy } from './command-policy.js';
import { SecretPolicy } from './secret-policy.js';
import { ApprovalEngine } from './approvals.js';
import { RISK_ORDER } from './risk.js';
import { PolicyDeniedError, ApprovalRequiredError } from '../core/errors.js';
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
        this.secret = new SecretPolicy();
        this.approvals = new ApprovalEngine();
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
    evaluate(toolName, risk, mutates, args) {
        // CRITICAL is denied in every mode except an explicit danger-mode approval.
        if (risk === 'CRITICAL') {
            if (this.mode !== 'danger') {
                return { kind: 'deny', risk, reason: `CRITICAL action blocked in ${this.mode} mode.` };
            }
            return this.toApproval(toolName, risk, args, 'CRITICAL action requires explicit approval.');
        }
        // readonly: any mutation is denied.
        if (this.mode === 'readonly' && mutates) {
            return { kind: 'deny', risk, reason: 'Workspace is in readonly mode; mutations are blocked.' };
        }
        // Explicit approval list or HIGH risk -> approval.
        const needsApproval = this.requireApproval.has(toolName) || RISK_ORDER[risk] >= RISK_ORDER.HIGH;
        if (needsApproval) {
            if (this.approvals.isSessionAllowed(toolName)) {
                return { kind: 'allow', risk };
            }
            return this.toApproval(toolName, risk, args, `${toolName} (${risk}) requires approval.`);
        }
        // MEDIUM allowed in safe/dev/danger; audited by caller.
        return { kind: 'allow', risk };
    }
    toApproval(toolName, risk, args, reason) {
        const req = this.approvals.create(toolName, args, risk, reason);
        return { kind: 'approval', risk, approvalId: req.id, reason };
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
