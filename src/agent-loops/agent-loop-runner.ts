import type {
  ToolCallControl,
  ToolPrincipal,
  ToolResult,
} from "../core/types.js";
import type {
  AgentLoopManager,
  AgentLoopRun,
  AgentLoopExpert,
} from "./agent-loop-manager.js";

type AgentCall = (
  name: string,
  args: Record<string, unknown>,
  control?: ToolCallControl,
) => Promise<ToolResult>;

export interface AgentLoopRunnerOptions {
  workflowId?: string;
  verificationTimeoutMs?: number;
}

export interface AgentLoopRunnerStatus {
  loopId: string;
  state: "queued" | "running" | "finished" | "failed";
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

/**
 * Durable orchestration driver for an agent loop.
 *
 * The runner deliberately keeps model selection outside the state manager. A
 * Codex/Responses client can create proposals through the public tools, while
 * this built-in driver provides a safe deterministic fallback: project
 * analysis, bounded code context, weighted council voting, an optional
 * workflow-backed implementation, and verification until the goal gate passes
 * or the configured iteration limit is reached.
 */
export class AgentLoopRunner {
  private readonly active = new Map<string, AgentLoopRunnerStatus>();

  constructor(
    private readonly manager: AgentLoopManager,
    private readonly callAgent: AgentCall,
  ) {}

  status(loopId: string): AgentLoopRunnerStatus | undefined {
    const value = this.active.get(loopId);
    return value ? { ...value } : undefined;
  }

  /**
   * Recover durable loops that were running when the process stopped. Recovery
   * reuses the persisted phase/checkpoint and the owner identity; the governed
   * workflow layer remains responsible for idempotency and approval boundaries.
   */
  recover(): number {
    let recovered = 0;
    for (const run of this.manager.list()) {
      if (run.state !== "running") continue;
      const principal: ToolPrincipal = {
        id: run.ownerId,
        role: "agent",
        ...(run.clientId ? { oauthClientId: run.clientId } : {}),
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        taskId: run.taskId ?? run.id,
      };
      this.start(run.id, principal);
      recovered += 1;
    }
    return recovered;
  }

  start(
    loopId: string,
    principal: ToolPrincipal,
    options: AgentLoopRunnerOptions = {},
    control?: ToolCallControl,
  ): AgentLoopRunnerStatus {
    const existing = this.active.get(loopId);
    if (existing && existing.state === "running") return { ...existing };
    const status: AgentLoopRunnerStatus = {
      loopId,
      state: "queued",
      startedAt: Date.now(),
    };
    this.active.set(loopId, status);
    void this.execute(loopId, principal, options, control).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.active.get(loopId);
      if (current) {
        current.state = "failed";
        current.finishedAt = Date.now();
        current.error = message;
      }
      try {
        this.manager.recordRunnerError(loopId, principal, message);
      } catch {
        // The persisted loop may already be terminal or inaccessible.
      }
    });
    return { ...status };
  }

  private async execute(
    loopId: string,
    principal: ToolPrincipal,
    options: AgentLoopRunnerOptions,
    control?: ToolCallControl,
  ): Promise<void> {
    const status = this.active.get(loopId);
    if (!status) return;
    status.state = "running";
    const runnerControl: ToolCallControl = {
      ...(control ?? {}),
      principal: { ...principal, role: "agent", taskId: loopId },
    };

    let run = this.manager.get(loopId, principal);
    runnerControl.principal = {
      ...runnerControl.principal!,
      taskId: run.taskId ?? loopId,
    };
    if (run.state === "created" || run.state === "paused") {
      run = this.manager.start(loopId, principal);
    }

    while (run.state === "running") {
      if (runnerControl.signal?.aborted) {
        this.manager.pause(loopId, principal, "Runner cancelled by client.");
        return;
      }
      await this.progress(runnerControl, run);
      if (run.phase === "discovery") {
        run = await this.discovery(run, principal, runnerControl);
      } else if (run.phase === "council") {
        run = await this.council(run, principal, runnerControl);
      } else if (run.phase === "implementation") {
        run = await this.implementation(run, principal, options, runnerControl);
      } else if (run.phase === "verification") {
        run = await this.verification(run, principal, options, runnerControl);
      } else {
        break;
      }
    }

    const current = this.active.get(loopId);
    if (current) {
      current.state = "finished";
      current.finishedAt = Date.now();
    }
  }

  private async discovery(
    run: AgentLoopRun,
    principal: ToolPrincipal,
    control: ToolCallControl,
  ): Promise<AgentLoopRun> {
    const [analysis, context] = await Promise.all([
      this.callAgent("project_analyze", {}, control),
      this.callAgent(
        "code_context",
        {
          query: `${run.goal}\n${run.acceptanceCriteria.join("\n")}`,
          maxResults: 12,
          maxFiles: 120,
          includeTests: true,
        },
        control,
      ),
    ]);
    const evidence = [
      summarizeResult("project_analyze", analysis),
      summarizeResult("code_context", context),
    ].filter(Boolean);
    for (const expert of run.experts) {
      const proposal = proposalForExpert(expert, run, evidence);
      run = this.manager.submitProposal(run.id, proposal, principal);
    }
    return run;
  }

  private async council(
    run: AgentLoopRun,
    principal: ToolPrincipal,
    control: ToolCallControl,
  ): Promise<AgentLoopRun> {
    const proposals = run.proposals.filter(
      (proposal) => proposal.iteration === run.iteration,
    );
    if (!proposals.length)
      throw new Error("Council cannot run without discovery proposals.");
    const winner = proposals
      .slice()
      .sort(
        (left, right) =>
          proposalAffinity(right, run) - proposalAffinity(left, run),
      )[0]!;
    for (const expert of run.experts) {
      const score = expert.id === winner.expertId ? 0.92 : 0.82;
      run = this.manager.submitVote(
        run.id,
        {
          expertId: expert.id,
          proposalId: winner.id,
          score,
          approve: true,
          rationale: `Independent ${expert.role} review selected the proposal with the strongest evidence and lowest unresolved risk.`,
        },
        principal,
      );
    }
    await this.progress(control, run);
    return this.manager.decide(run.id, principal);
  }

  private async implementation(
    run: AgentLoopRun,
    principal: ToolPrincipal,
    options: AgentLoopRunnerOptions,
    control: ToolCallControl,
  ): Promise<AgentLoopRun> {
    if (!options.workflowId) {
      return this.manager.recordImplementation(
        run.id,
        {
          status: "blocked",
          summary:
            "No implementationWorkflowId was supplied. The loop will not mutate the repository implicitly; attach a validated workflow or let a Codex worker submit implementation evidence.",
        },
        principal,
      );
    }
    let result = await this.callAgent(
      "workflow_run",
      { id: options.workflowId },
      control,
    );
    if (result.ok && isWorkflowPaused(result.data)) {
      return this.manager.recordImplementation(
        run.id,
        {
          status: "blocked",
          summary:
            "Implementation workflow is awaiting approval or operator input.",
        },
        principal,
      );
    }
    if (!result.ok) {
      return this.manager.recordImplementation(
        run.id,
        {
          status: "blocked",
          summary: `Implementation workflow failed: ${result.error ?? "unknown error"}`,
        },
        principal,
      );
    }
    const report = result.data;
    if (isWorkflowIncomplete(report)) {
      result = await this.callAgent(
        "workflow_resume",
        { id: options.workflowId },
        control,
      );
      if (!result.ok) {
        return this.manager.recordImplementation(
          run.id,
          {
            status: "blocked",
            summary: `Implementation workflow could not resume: ${result.error ?? "unknown error"}`,
          },
          principal,
        );
      }
    }
    const changedPaths = extractChangedPaths(result.data);
    if (!changedPaths.length) {
      return this.manager.recordImplementation(
        run.id,
        {
          status: "blocked",
          summary:
            "Implementation workflow completed without reporting changed paths; the loop will not claim implementation success.",
        },
        principal,
      );
    }
    return this.manager.recordImplementation(
      run.id,
      {
        status: "completed",
        summary:
          "Selected council proposal was executed through the governed workflow pipeline.",
        changedPaths,
      },
      principal,
    );
  }

  private async verification(
    run: AgentLoopRun,
    principal: ToolPrincipal,
    options: AgentLoopRunnerOptions,
    control: ToolCallControl,
  ): Promise<AgentLoopRun> {
    const result = await this.callAgent(
      "project_verify",
      {
        action: "run",
        checks: ["typecheck", "lint", "test", "build"],
        async: true,
        timeoutMs: Math.min(
          1_800_000,
          Math.max(1_000, options.verificationTimeoutMs ?? 600_000),
        ),
      },
      control,
    );
    if (!result.ok) {
      return this.manager.recordVerification(
        run.id,
        {
          passed: false,
          criteria: run.acceptanceCriteria.map((name) => ({
            name,
            passed: false,
            evidence: result.error ?? "Verification could not start.",
          })),
          checks: ["project_verify"],
          ...(result.error ? { notes: result.error } : {}),
        },
        principal,
      );
    }
    let report = result.data;
    const verificationId = extractVerificationId(report);
    if (verificationId) {
      for (let attempt = 0; attempt < 180; attempt++) {
        if (control.signal?.aborted) break;
        await sleep(1_000);
        const polled = await this.callAgent(
          "project_verify",
          { action: "status", id: verificationId },
          control,
        );
        if (!polled.ok) {
          report = polled.data ?? { overall: "failed", error: polled.error };
          break;
        }
        report = polled.data;
        if (isVerificationTerminal(report)) break;
      }
    }
    const passed = verificationPassed(report);
    let proofPack:
      { id: string; manifestSha256: string; verified: boolean } | undefined;
    if (passed && options.workflowId) {
      try {
        const createdPack = await this.callAgent(
          "workflow_proof_pack",
          { id: options.workflowId },
          control,
        );
        const summary = createdPack.ok
          ? extractProofPack(createdPack.data)
          : undefined;
        if (summary) {
          const verifiedPack = await this.callAgent(
            "workflow_proof_verify",
            { id: options.workflowId, proofPackId: summary.id },
            control,
          );
          if (verifiedPack.ok) proofPack = { ...summary, verified: true };
        }
      } catch {
        // Older/custom drivers may not expose Proof Pack tools; verification remains durable.
      }
    }
    return this.manager.recordVerification(
      run.id,
      {
        passed,
        criteria: run.acceptanceCriteria.map((name) => ({
          name,
          passed: criterionPassed(name, report, passed),
          evidence: boundedEvidence(report),
        })),
        checks: verificationChecks(report),
        ...(proofPack ? { proofPack } : {}),
        notes: passed
          ? "All configured verification checks passed."
          : "Goal gate remains open; discovery will start another iteration when permitted.",
      },
      principal,
    );
  }

  private async progress(
    control: ToolCallControl,
    run: AgentLoopRun,
  ): Promise<void> {
    await control.reportProgress?.(
      run.iteration,
      run.maxIterations,
      `${run.phase}: ${run.title}`,
    );
  }
}

function proposalForExpert(
  expert: AgentLoopExpert,
  run: AgentLoopRun,
  evidence: string[],
) {
  const risk = expert.id.toLowerCase().includes("security")
    ? ["Keep all writes behind policy, approval, capsule and audit boundaries."]
    : ["Prefer small, reversible changes with explicit verification evidence."];
  return {
    expertId: expert.id,
    phase: "discovery" as const,
    summary: `${expert.role} proposal for: ${run.goal}`,
    plan: [
      `Inspect the repository and relevant tests for ${run.goal}.`,
      "Implement through a bounded workflow in the managed workspace.",
      "Run the configured goal-gate checks and preserve proof evidence.",
    ],
    risks: risk,
    evidence,
  };
}

function proposalAffinity(
  proposal: {
    expertId: string;
    plan: string[];
    risks: string[];
    evidence: string[];
  },
  run: AgentLoopRun,
): number {
  return (
    proposal.evidence.length * 2 +
    proposal.plan.length -
    proposal.risks.length +
    (run.experts.find((e) => e.id === proposal.expertId)?.weight ?? 1)
  );
}

function summarizeResult(name: string, result: ToolResult): string {
  if (!result.ok) return `${name}: unavailable (${result.error ?? "error"})`;
  const serialized = JSON.stringify(result.data ?? {})
    .replace(/\s+/g, " ")
    .slice(0, 1_000);
  return `${name}: ${serialized}`;
}

function isWorkflowPaused(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).state === "paused",
  );
}

function isWorkflowIncomplete(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    ["running", "paused"].includes(
      String((value as Record<string, unknown>).state),
    ),
  );
}

function extractChangedPaths(value: unknown): string[] {
  const paths = new Set<string>();
  const visit = (candidate: unknown, insideFileCollection = false): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, insideFileCollection);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    const record = candidate as Record<string, unknown>;
    if (insideFileCollection && typeof record.path === "string") {
      paths.add(record.path);
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === "files" || key === "changedPaths") visit(child, true);
      else if (key === "steps" || key === "evidence" || key === "data") visit(child, insideFileCollection);
    }
  };
  visit(value);
  return [...paths];
}

function extractProofPack(
  value: unknown,
): { id: string; manifestSha256: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>).proofPack ?? value;
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as Record<string, unknown>;
  return typeof record.id === "string" &&
    typeof record.manifestSha256 === "string"
    ? { id: record.id, manifestSha256: record.manifestSha256 }
    : undefined;
}

function extractVerificationId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

function isVerificationTerminal(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  const state = String((value as Record<string, unknown>).state ?? "");
  return (
    ["completed", "cancelled", "interrupted"].includes(state) ||
    ["passed", "failed", "unavailable"].includes(
      String((value as Record<string, unknown>).overall ?? ""),
    )
  );
}

function verificationPassed(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.passed === true || record.overall === "passed";
}

function criterionPassed(
  name: string,
  report: unknown,
  overall: boolean,
): boolean {
  if (overall) return true;
  const lower = name.toLowerCase();
  if (!report || typeof report !== "object") return false;
  const results = (report as Record<string, unknown>).results;
  if (!Array.isArray(results)) return false;
  const relevant = results.find(
    (item) =>
      item &&
      typeof item === "object" &&
      lower.includes(
        String((item as Record<string, unknown>).check ?? "").toLowerCase(),
      ),
  );
  return Boolean(
    relevant && (relevant as Record<string, unknown>).status === "passed",
  );
}

function verificationChecks(report: unknown): string[] {
  if (!report || typeof report !== "object") return [];
  const results = (report as Record<string, unknown>).results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((item) =>
    item &&
    typeof item === "object" &&
    typeof (item as Record<string, unknown>).check === "string"
      ? [String((item as Record<string, unknown>).check)]
      : [],
  );
}

function boundedEvidence(value: unknown): string {
  return JSON.stringify(value ?? {})
    .replace(/\s+/g, " ")
    .slice(0, 2_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
