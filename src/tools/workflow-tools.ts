import type { ToolCallControl, ToolDefinition, ToolResult } from '../core/types.js';
import type { ApprovalState } from '../policy/approvals.js';
import {
  checkWorkflowExpectation,
  resolveWorkflowValue,
  validateWorkflowDefinition,
  workflowEvidence,
  type WorkflowRun,
  type WorkflowStepDefinition,
} from '../workflows/workflow-manager.js';
import { defineTool } from './registry.js';

const runSchema = { type: 'object', additionalProperties: true } as const;

function fail(error: unknown): ToolResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function redactedArgs(args: Record<string, unknown>, redact: (text: string) => string): Record<string, unknown> {
  try {
    return JSON.parse(redact(JSON.stringify(args))) as Record<string, unknown>;
  } catch {
    return { redacted: true };
  }
}

function definitionStep(run: WorkflowRun, id: string): WorkflowStepDefinition {
  const step = run.definition.steps.find((item) => item.id === id);
  if (!step) throw new Error(`Workflow definition step missing: ${id}`);
  return step;
}

function approvalState(run: WorkflowRun, ctx: Parameters<ToolDefinition['handler']>[1]): ApprovalState | undefined {
  const waiting = run.steps.find((step) => step.state === 'awaiting_approval');
  if (!waiting?.approvalId) return undefined;
  return ctx.container.policy.approvals.get(waiting.approvalId)?.state;
}

async function executeWorkflow(
  run: WorkflowRun,
  ctx: Parameters<ToolDefinition['handler']>[1],
  control?: ToolCallControl
): Promise<ToolResult> {
  const manager = ctx.container.workflows;
  if (run.state === 'completed') return { ok: true, data: manager.report(run) };
  if (run.state === 'cancelled' || run.state === 'failed') {
    return { ok: false, error: `Workflow ${run.id} is ${run.state}.`, data: manager.report(run) };
  }

  const waiting = run.steps.find((step) => step.state === 'awaiting_approval');
  if (waiting) {
    const state = approvalState(run, ctx);
    if (!state || state === 'pending') {
      run.state = 'paused';
      run.pauseReason = `Awaiting approval ${waiting.approvalId} for ${waiting.tool}.`;
      manager.save(run);
      return { ok: true, data: manager.report(run) };
    }
    if (state === 'denied' || state === 'expired') {
      waiting.state = 'failed';
      waiting.completedAt = Date.now();
      waiting.note = `Approval ${state}.`;
      run.state = 'failed';
      run.failure = waiting.note;
      run.completedAt = Date.now();
      manager.save(run);
      return { ok: false, error: run.failure, data: manager.report(run) };
    }
    waiting.state = 'pending';
    delete waiting.approvalId;
    delete run.pauseReason;
  }

  run.state = 'running';
  run.startedAt ??= Date.now();
  manager.save(run);

  while (true) {
    if (control?.signal?.aborted) {
      run.state = 'paused';
      run.pauseReason = 'Execution cancelled by client; resume will continue from the next unfinished step.';
      manager.save(run);
      return { ok: true, data: manager.report(run) };
    }
    if (manager.get(run.id).state === 'cancelled') {
      return { ok: false, error: `Workflow ${run.id} was cancelled.`, data: manager.report(manager.get(run.id)) };
    }

    for (const step of run.steps.filter((item) => item.state === 'pending')) {
      const def = definitionStep(run, step.id);
      const deps = def.dependsOn ?? [];
      const failedDep = deps.find((id) => {
        const dep = run.steps.find((item) => item.id === id);
        return dep?.state === 'failed' || dep?.state === 'skipped';
      });
      if (failedDep) {
        step.state = 'skipped';
        step.completedAt = Date.now();
        step.note = `Skipped because dependency ${failedDep} did not succeed.`;
      }
    }

    const unfinished = run.steps.filter((step) => ['pending', 'running', 'awaiting_approval'].includes(step.state));
    if (unfinished.length === 0) {
      const failed = run.steps.find((step) => step.state === 'failed');
      run.state = failed ? 'failed' : 'completed';
      if (failed?.note) run.failure = failed.note;
      else delete run.failure;
      run.completedAt = Date.now();
      delete run.currentStepId;
      manager.save(run);
      return failed
        ? { ok: false, error: run.failure ?? 'Workflow failed.', data: manager.report(run) }
        : { ok: true, data: manager.report(run) };
    }

    const step = run.steps.find((candidate) => {
      if (candidate.state !== 'pending') return false;
      const deps = definitionStep(run, candidate.id).dependsOn ?? [];
      return deps.every((id) => run.steps.find((item) => item.id === id)?.state === 'succeeded');
    });
    if (!step) {
      run.state = 'failed';
      run.failure = 'Workflow cannot make progress; dependencies are unresolved.';
      run.completedAt = Date.now();
      manager.save(run);
      return { ok: false, error: run.failure, data: manager.report(run) };
    }

    const def = definitionStep(run, step.id);
    let args: Record<string, unknown>;
    try {
      const resolved = resolveWorkflowValue(def.args ?? {}, run);
      if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
        throw new Error(`Resolved args for ${step.id} are not an object.`);
      }
      args = resolved as Record<string, unknown>;
    } catch (error) {
      step.state = 'failed';
      step.completedAt = Date.now();
      step.note = error instanceof Error ? error.message : String(error);
      run.state = 'failed';
      run.failure = step.note ?? `Step ${step.id} failed.`;
      run.completedAt = Date.now();
      manager.save(run);
      return { ok: false, error: run.failure, data: manager.report(run) };
    }

    step.state = 'running';
    step.attempts++;
    step.startedAt = Date.now();
    step.resolvedArgs = redactedArgs(args, (text) => ctx.container.policy.secret.redact(text));
    run.currentStepId = step.id;
    manager.save(run);
    await control?.reportProgress?.(
      run.steps.filter((item) => ['succeeded', 'skipped'].includes(item.state)).length,
      run.steps.length,
      `${step.role}: ${step.tool}`
    );

    const result = await ctx.container.registry.call(step.tool, args, control);
    const evidence = workflowEvidence(result, (text) => ctx.container.policy.secret.redact(text));
    step.evidence = evidence;
    step.completedAt = Date.now();

    if (result.approvalId) {
      step.state = 'awaiting_approval';
      step.approvalId = result.approvalId;
      step.note = result.error ?? 'Approval required.';
      run.state = 'paused';
      run.pauseReason = `Awaiting approval ${result.approvalId} for ${step.tool}.`;
      manager.save(run);
      return { ok: true, data: manager.report(run) };
    }

    const expectation = checkWorkflowExpectation(def.expect, evidence);
    if (result.ok && expectation.passed) {
      step.state = 'succeeded';
      delete step.note;
      manager.save(run);
      continue;
    }

    step.state = 'failed';
    step.note = expectation.reason ?? result.error ?? `${step.tool} failed.`;
    manager.save(run);
    if (def.continueOnError) continue;
    run.state = 'failed';
    run.failure = step.note ?? `${step.tool} failed.`;
    run.completedAt = Date.now();
    manager.save(run);
    return { ok: false, error: run.failure, data: manager.report(run) };
  }
}

export function workflowTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'workflow_create',
      description: 'Validate and persist a deterministic, role-scoped workflow definition. Recursive workflow tool calls and detected secrets are rejected.',
      group: 'workflow', mutates: true, risk: 'MEDIUM',
      inputSchema: { type: 'object', properties: { definition: { type: 'object', additionalProperties: true } }, required: ['definition'] },
      outputSchema: runSchema,
      handler: async (args, ctx) => {
        try {
          const serialized = JSON.stringify(args.definition ?? {});
          const findings = ctx.container.policy.secret.scan(serialized);
          if (findings.length) return { ok: false, error: `Workflow definition contains ${findings.length} possible secret(s); use governed env/file references instead.` };
          const available = new Set<string>(
            ctx.container.registry.listAll().map((tool: ToolDefinition) => tool.name)
          );
          const definition = validateWorkflowDefinition(args.definition, available);
          const run = ctx.container.workflows.create(definition);
          return { ok: true, data: ctx.container.workflows.report(run) };
        } catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'workflow_run',
      description: 'Execute a created workflow through the normal tool policy/audit pipeline until completion, failure, cancellation, or approval pause.',
      group: 'workflow', mutates: true, risk: 'MEDIUM',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: runSchema,
      handler: async (args, ctx) => {
        try {
          const run = ctx.container.workflows.get(String(args.id ?? ''));
          if (run.state !== 'created') return { ok: false, error: `workflow_run requires created state; current=${run.state}.`, data: ctx.container.workflows.report(run) };
          return executeWorkflow(run, ctx, ctx.control);
        } catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'workflow_resume',
      description: 'Resume a paused workflow without replaying successful steps. Approved one-shot child calls are consumed exactly once.',
      group: 'workflow', mutates: true, risk: 'MEDIUM',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: runSchema,
      handler: async (args, ctx) => {
        try {
          const run = ctx.container.workflows.get(String(args.id ?? ''));
          if (run.state !== 'paused') return { ok: false, error: `workflow_resume requires paused state; current=${run.state}.`, data: ctx.container.workflows.report(run) };
          return executeWorkflow(run, ctx, ctx.control);
        } catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'workflow_status',
      description: 'Read one persisted workflow checkpoint and its bounded/redacted step evidence.',
      group: 'workflow', mutates: false, risk: 'LOW',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: runSchema,
      handler: async (args, ctx) => {
        try { return { ok: true, data: ctx.container.workflows.view(ctx.container.workflows.get(String(args.id ?? ''))) }; }
        catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'workflow_list',
      description: 'List recent persisted workflow runs without exposing raw unredacted definitions.',
      group: 'workflow', mutates: false, risk: 'LOW',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } } },
      outputSchema: { type: 'object', properties: { runs: { type: 'array', items: runSchema } }, required: ['runs'] },
      handler: async (args, ctx) => ({ ok: true, data: { runs: ctx.container.workflows.list(Number(args.limit ?? 50)) } }),
    }),
    defineTool({
      name: 'workflow_cancel',
      description: 'Cancel a non-terminal persisted workflow. A running executor observes the checkpoint before starting another step.',
      group: 'workflow', mutates: true, risk: 'MEDIUM',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: runSchema,
      handler: async (args, ctx) => {
        try { return { ok: true, data: ctx.container.workflows.report(ctx.container.workflows.cancel(String(args.id ?? ''))) }; }
        catch (error) { return fail(error); }
      },
    }),
    defineTool({
      name: 'workflow_report',
      description: 'Return a reproducible workflow report with role scopes, step states, bounded evidence, duration, and resumability.',
      group: 'workflow', mutates: false, risk: 'LOW',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: runSchema,
      handler: async (args, ctx) => {
        try { return { ok: true, data: ctx.container.workflows.report(ctx.container.workflows.get(String(args.id ?? ''))) }; }
        catch (error) { return fail(error); }
      },
    }),
  ];
}
