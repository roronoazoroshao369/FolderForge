import type { FolderForgeConfig, PolicyMode, RiskLevel } from '../core/types.js';
import { PathPolicy } from './path-policy.js';
import { CommandPolicy } from './command-policy.js';
import { SecretPolicy } from './secret-policy.js';
import { ApprovalEngine } from './approvals.js';
import { RISK_ORDER } from './risk.js';
import { PolicyDeniedError, ApprovalRequiredError } from '../core/errors.js';
import { resolve } from 'node:path';

export type Decision =
  | { kind: 'allow'; risk: RiskLevel }
  | { kind: 'deny'; risk: RiskLevel; reason: string }
  | { kind: 'approval'; risk: RiskLevel; approvalId: string; reason: string };

/**
 * The PolicyEngine ties together path, command, secret policies, the risk
 * model, the policy mode, and the approval queue into a single decision point.
 */
export class PolicyEngine {
  readonly path: PathPolicy;
  readonly command: CommandPolicy;
  readonly secret: SecretPolicy;
  readonly approvals: ApprovalEngine;
  private mode: PolicyMode;
  private requireApproval: Set<string>;

  constructor(private config: FolderForgeConfig) {
    this.path = new PathPolicy(config.workspace.allowedDirectories, config.workspace.deniedGlobs);
    this.command = new CommandPolicy(config.policy.blockedCommands);
    this.secret = new SecretPolicy(config.secretScan);
    // Persist approvals under the project's .folderforge dir so pending and
    // resolved requests survive restarts. Falls back to in-memory if unset.
    const persistPath =
      process.env.FOLDERFORGE_APPROVALS_PATH ||
      (config.workspace.defaultProject
        ? resolve(config.workspace.defaultProject, '.folderforge', 'approvals.jsonl')
        : undefined);
    this.approvals = new ApprovalEngine({
      ...(persistPath ? { persistPath } : {}),
      sanitizeArgs: (args) => this.secret.redactValue(args) as Record<string, unknown>,
    });
    this.mode = config.policy.defaultMode;
    this.requireApproval = new Set(config.policy.requireApproval);
  }

  getMode(): PolicyMode {
    return this.mode;
  }

  setMode(mode: PolicyMode): void {
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
  evaluate(
    toolName: string,
    risk: RiskLevel,
    mutates: boolean,
    args: Record<string, unknown>
  ): Decision {
    // CRITICAL is denied in every mode except an explicit danger-mode approval.
    if (risk === 'CRITICAL') {
      if (this.mode !== 'danger') {
        return { kind: 'deny', risk, reason: `CRITICAL action blocked in ${this.mode} mode.` };
      }
      // A session-scoped approval (pre-granted via the dashboard/approval tools)
      // lets the tool through without re-prompting on every call.
      if (
        this.approvals.isSessionAllowed(toolName) ||
        this.approvals.consumeOnce(toolName, args)
      ) {
        return { kind: 'allow', risk };
      }
      return this.toApproval(toolName, risk, args, 'CRITICAL action requires explicit approval.');
    }

    // readonly: any mutation is denied.
    if (this.mode === 'readonly' && mutates) {
      return { kind: 'deny', risk, reason: 'Workspace is in readonly mode; mutations are blocked.' };
    }

    // Explicit approval list or HIGH risk -> approval.
    const needsApproval =
      this.requireApproval.has(toolName) || RISK_ORDER[risk] >= RISK_ORDER.HIGH;

    if (needsApproval) {
      // danger mode intentionally bypasses approval gating for non-CRITICAL
      // actions: the operator has opted into an "anything goes" mode.
      if (this.mode === 'danger') {
        return { kind: 'allow', risk };
      }
      if (
        this.approvals.isSessionAllowed(toolName) ||
        this.approvals.consumeOnce(toolName, args)
      ) {
        return { kind: 'allow', risk };
      }
      return this.toApproval(toolName, risk, args, `${toolName} (${risk}) requires approval.`);
    }

    // MEDIUM allowed in safe/dev/danger; audited by caller.
    return { kind: 'allow', risk };
  }

  private toApproval(
    toolName: string,
    risk: RiskLevel,
    args: Record<string, unknown>,
    reason: string
  ): Decision {
    const req = this.approvals.create(toolName, args, risk, reason);
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
  explain(
    toolName: string,
    risk: RiskLevel,
    mutates: boolean,
    args: Record<string, unknown> = {}
  ): {
    decision: 'allow' | 'deny' | 'approval';
    risk: RiskLevel;
    reason: string;
    mode: PolicyMode;
    mutates: boolean;
    factors: string[];
  } {
    const factors: string[] = [];
    let decision: 'allow' | 'deny' | 'approval';
    let reason: string;

    if (risk === 'CRITICAL') {
      factors.push('risk is CRITICAL');
      if (this.mode !== 'danger') {
        decision = 'deny';
        reason = `CRITICAL action blocked in ${this.mode} mode.`;
      } else {
        decision = 'approval';
        reason = 'CRITICAL action requires explicit approval.';
        factors.push('mode is danger (CRITICAL allowed only via approval)');
      }
    } else if (this.mode === 'readonly' && mutates) {
      factors.push('mode is readonly and the tool mutates state');
      decision = 'deny';
      reason = 'Workspace is in readonly mode; mutations are blocked.';
    } else {
      const onApprovalList = this.requireApproval.has(toolName);
      const highRisk = RISK_ORDER[risk] >= RISK_ORDER.HIGH;
      if (onApprovalList) factors.push(`tool is in requireApproval list`);
      if (highRisk) factors.push(`risk is ${risk} (>= HIGH)`);

      if (onApprovalList || highRisk) {
        if (this.approvals.isSessionAllowed(toolName)) {
          factors.push('a session-scoped approval is already active for this tool');
          decision = 'allow';
          reason = `${toolName} is allowed for this session.`;
        } else {
          decision = 'approval';
          reason = `${toolName} (${risk}) requires approval.`;
        }
      } else {
        factors.push(`risk is ${risk} and allowed in ${this.mode} mode`);
        decision = 'allow';
        reason = `${toolName} (${risk}) is allowed.`;
      }
    }

    return { decision, risk, reason, mode: this.mode, mutates, factors };
  }

  /** Convenience: throws unless the decision is allow. */
  enforce(decision: Decision): void {
    if (decision.kind === 'deny') throw new PolicyDeniedError(decision.reason);
    if (decision.kind === 'approval') {
      throw new ApprovalRequiredError(decision.reason, decision.approvalId);
    }
  }
}
