import type { ToolDefinition, ToolPrincipal, ToolResult } from '../core/types.js';
import { defineTool } from './registry.js';

type Ctx = Parameters<ToolDefinition['handler']>[1];

function principal(ctx: Ctx): ToolPrincipal {
  return ctx.control?.principal ?? { id: 'agent:unknown', role: 'agent' };
}

function ok(data: unknown): ToolResult { return { ok: true, data }; }
function fail(error: unknown): ToolResult { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
function runId(args: Record<string, unknown>): string {
  const id = String(args.id ?? '').trim();
  if (!id) throw new Error('id is required.');
  return id;
}

const expertsSchema = { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, role: { type: 'string' }, weight: { type: 'number' }, model: { type: 'string' } }, required: ['id', 'role', 'weight'] } } as const;
const loopInput = {
  type: 'object', properties: {
    title: { type: 'string' }, goal: { type: 'string' },
    acceptanceCriteria: { type: 'array', items: { type: 'string' } }, experts: expertsSchema,
    councilMinVotes: { type: 'number' }, councilThreshold: { type: 'number' }, maxIterations: { type: 'number' }, projectRoot: { type: 'string' },
  }, required: ['title', 'goal', 'acceptanceCriteria'], additionalProperties: false,
} as const;

export function agentLoopTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'agent_loop_create', description: 'Create a durable autonomous coding loop with acceptance criteria, expert roster, council quorum and an iteration limit.', group: 'agent-loop', mutates: true, risk: 'MEDIUM', inputSchema: loopInput,
      handler: async (args, ctx) => { try { return ok(ctx.container.agentLoops.view(ctx.container.agentLoops.create({ title: String(args.title ?? ''), goal: String(args.goal ?? ''), acceptanceCriteria: Array.isArray(args.acceptanceCriteria) ? args.acceptanceCriteria.map(String) : [], ...(Array.isArray(args.experts) ? { experts: args.experts as never[] } : {}), ...(args.councilMinVotes !== undefined ? { councilMinVotes: Number(args.councilMinVotes) } : {}), ...(args.councilThreshold !== undefined ? { councilThreshold: Number(args.councilThreshold) } : {}), ...(args.maxIterations !== undefined ? { maxIterations: Number(args.maxIterations) } : {}), ...(typeof args.projectRoot === 'string' ? { projectRoot: args.projectRoot } : {}) }, principal(ctx)))); } catch (error) { return fail(error); } },
    }),
    defineTool({
      name: 'agent_loop_list', description: 'List durable agent loops visible to the current principal.', group: 'agent-loop', mutates: false, risk: 'LOW', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
      handler: async (args, ctx) => ok({ loops: ctx.container.agentLoops.list(principal(ctx), Number(args.limit ?? 100)) }),
    }),
    defineTool({
      name: 'agent_loop_status', description: 'Read one durable loop, its current phase, council evidence, implementation state and goal gate.', group: 'agent-loop', mutates: false, risk: 'LOW', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async (args, ctx) => { try { const id = runId(args); return ok({ loop: ctx.container.agentLoops.view(ctx.container.agentLoops.get(id, principal(ctx))), runner: ctx.container.agentLoopRunner.status(id) }); } catch (error) { return fail(error); } },
    }),
    defineTool({
      name: 'agent_loop_start', description: 'Start or resume a durable agent loop.', group: 'agent-loop', mutates: true, risk: 'MEDIUM', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async (args, ctx) => { try { return ok({ loop: ctx.container.agentLoops.view(ctx.container.agentLoops.start(runId(args), principal(ctx))) }); } catch (error) { return fail(error); } },
    }),
    defineTool({
      name: 'agent_loop_pause', description: 'Pause a durable agent loop without losing its persisted state.', group: 'agent-loop', mutates: true, risk: 'MEDIUM', inputSchema: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id'] },
      handler: async (args, ctx) => { try { return ok({ loop: ctx.container.agentLoops.view(ctx.container.agentLoops.pause(runId(args), principal(ctx), typeof args.reason === 'string' ? args.reason : undefined)) }); } catch (error) { return fail(error); } },
    }),
    defineTool({
      name: 'agent_loop_resume', description: 'Resume a paused durable agent loop.', group: 'agent-loop', mutates: true, risk: 'MEDIUM', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async (args, ctx) => { try { return ok({ loop: ctx.container.agentLoops.view(ctx.container.agentLoops.start(runId(args), principal(ctx))) }); } catch (error) { return fail(error); } },
    }),
    defineTool({
      name: 'agent_loop_cancel', description: 'Cancel a non-terminal durable agent loop.', group: 'agent-loop', mutates: true, risk: 'HIGH', inputSchema: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id'] },
      handler: async (args, ctx) => { try { return ok({ loop: ctx.container.agentLoops.view(ctx.container.agentLoops.cancel(runId(args), principal(ctx), typeof args.reason === 'string' ? args.reason : undefined)) }); } catch (error) { return fail(error); } },
    }),
    defineTool({
      name: 'agent_loop_propose', description: 'Submit an independent expert discovery or council proposal to a running loop.', group: 'agent-loop', mutates: true, risk: 'MEDIUM', inputSchema: { type: 'object', properties: { id: { type: 'string' }, expertId: { type: 'string' }, phase: { type: 'string', enum: ['discovery', 'council'] }, summary: { type: 'string' }, plan: { type: 'array', items: { type: 'string' } }, risks: { type: 'array', items: { type: 'string' } }, evidence: { type: 'array', items: { type: 'string' } } }, required: ['id', 'expertId', 'summary'] },
      handler: async (args, ctx) => { try { return ok({ loop: ctx.container.agentLoops.view(ctx.container.agentLoops.submitProposal(runId(args), { expertId: String(args.expertId), ...(args.phase === 'discovery' || args.phase === 'council' ? { phase: args.phase } : {}), summary: String(args.summary), ...(Array.isArray(args.plan) ? { plan: args.plan.map(String) } : {}), ...(Array.isArray(args.risks) ? { risks: args.risks.map(String) } : {}), ...(Array.isArray(args.evidence) ? { evidence: args.evidence.map(String) } : {}) }, principal(ctx))) }); } catch (error) { return fail(error); } },
    }),
    defineTool({
      name: 'agent_loop_vote', description: 'Cast or replace one expert vote for a current iteration proposal.', group: 'agent-loop', mutates: true, risk: 'MEDIUM', inputSchema: { type: 'object', properties: { id: { type: 'string' }, expertId: { type: 'string' }, proposalId: { type: 'string' }, score: { type: 'number', minimum: 0, maximum: 1 }, approve: { type: 'boolean' }, rationale: { type: 'string' } }, required: ['id', 'expertId', 'proposalId', 'score', 'approve'] },
      handler: async (args, ctx) => { try { return ok({ loop: ctx.container.agentLoops.view(ctx.container.agentLoops.submitVote(runId(args), { expertId: String(args.expertId), proposalId: String(args.proposalId), score: Number(args.score), approve: args.approve === true, ...(args.rationale !== undefined ? { rationale: String(args.rationale) } : {}) }, principal(ctx))) }); } catch (error) { return fail(error); } },
    }),
    defineTool({
      name: 'agent_loop_decide', description: 'Run the weighted council quorum and select the highest-consensus proposal.', group: 'agent-loop', mutates: true, risk: 'MEDIUM', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async (args, ctx) => { try { return ok({ loop: ctx.container.agentLoops.view(ctx.container.agentLoops.decide(runId(args), principal(ctx))) }); } catch (error) { return fail(error); } },
    }),
    defineTool({
      name: 'agent_loop_implementation', description: 'Record implementation progress, changed paths or a blocker for the selected council proposal.', group: 'agent-loop', mutates: true, risk: 'MEDIUM', inputSchema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['running', 'completed', 'blocked'] }, summary: { type: 'string' }, changedPaths: { type: 'array', items: { type: 'string' } } }, required: ['id', 'status', 'summary'] },
      handler: async (args, ctx) => { try { const status = args.status === 'completed' || args.status === 'blocked' ? args.status : 'running'; return ok({ loop: ctx.container.agentLoops.view(ctx.container.agentLoops.recordImplementation(runId(args), { status, summary: String(args.summary), ...(Array.isArray(args.changedPaths) ? { changedPaths: args.changedPaths.map(String) } : {}) }, principal(ctx))) }); } catch (error) { return fail(error); } },
    }),
    defineTool({
      name: 'agent_loop_verify', description: 'Submit verification checks and acceptance evidence; failure starts the next iteration until maxIterations.', group: 'agent-loop', mutates: true, risk: 'MEDIUM', inputSchema: { type: 'object', properties: { id: { type: 'string' }, passed: { type: 'boolean' }, criteria: { type: 'array', items: { type: 'object' } }, checks: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } }, required: ['id', 'passed', 'criteria'] },
      handler: async (args, ctx) => { try { const criteria = Array.isArray(args.criteria) ? args.criteria.flatMap((item) => { if (!item || typeof item !== 'object') return []; const value = item as Record<string, unknown>; return [{ name: String(value.name ?? ''), passed: value.passed === true, ...(value.evidence !== undefined ? { evidence: String(value.evidence) } : {}) }]; }) : []; return ok({ loop: ctx.container.agentLoops.view(ctx.container.agentLoops.recordVerification(runId(args), { passed: args.passed === true, criteria, ...(Array.isArray(args.checks) ? { checks: args.checks.map(String) } : {}), ...(args.notes !== undefined ? { notes: String(args.notes) } : {}) }, principal(ctx))) }); } catch (error) { return fail(error); } },
    }),
    defineTool({
      name: 'agent_loop_events', description: 'Read durable agent-loop events after a sequence number for polling or live progress views.', group: 'agent-loop', mutates: false, risk: 'LOW', inputSchema: { type: 'object', properties: { id: { type: 'string' }, after: { type: 'number' }, limit: { type: 'number' } }, required: ['id'], additionalProperties: false },
      handler: async (args, ctx) => { try { const id = runId(args); return ok(ctx.container.agentLoops.eventsSince(id, Number(args.after ?? 0), Number(args.limit ?? 100), principal(ctx))); } catch (error) { return fail(error); } },
    }),
    defineTool({
      name: 'agent_loop_run',
      description: 'Start an autonomous discovery, expert council, governed implementation workflow and verification loop in the background. It persists progress and stops only at the goal gate, max-iteration failure, approval pause or an explicit blocker.', group: 'agent-loop', mutates: true, risk: 'MEDIUM', inputSchema: { type: 'object', properties: { id: { type: 'string' }, implementationWorkflowId: { type: 'string' }, verificationTimeoutMs: { type: 'number' }, idempotencyKey: { type: 'string', maxLength: 256 } }, required: ['id'], additionalProperties: false },
      handler: async (args, ctx) => { try {
        const id = runId(args);
        const actor = principal(ctx);
        if (typeof args.idempotencyKey === 'string') ctx.container.agentLoops.claimRunInvocation(id, args.idempotencyKey, actor);
        const status = ctx.container.agentLoopRunner.start(id, actor, { ...(typeof args.implementationWorkflowId === 'string' ? { workflowId: args.implementationWorkflowId } : {}), ...(args.verificationTimeoutMs !== undefined ? { verificationTimeoutMs: Number(args.verificationTimeoutMs) } : {}) }, ctx.control);
        const loop = ctx.container.agentLoops.view(ctx.container.agentLoops.get(id, principal(ctx)));
        return ok({ accepted: true, runner: status, loop });
      } catch (error) { return fail(error); } },
    }),
    defineTool({
      name: 'agent_loop_report', description: 'Return a bounded report for a loop suitable for a remote Codex worker or Mission Control.', group: 'agent-loop', mutates: false, risk: 'LOW', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async (args, ctx) => { try { const id = runId(args); const loop = ctx.container.agentLoops.view(ctx.container.agentLoops.get(id, principal(ctx))); return ok({ id: loop.id, title: loop.title, state: loop.state, phase: loop.phase, iteration: loop.iteration, maxIterations: loop.maxIterations, goal: loop.goal, acceptanceCriteria: loop.acceptanceCriteria, goalGate: loop.goalGate, proposals: loop.currentIterationProposals, votes: loop.currentIterationVotes, decision: loop.decision, implementation: loop.implementation, verification: loop.verification, runner: ctx.container.agentLoopRunner.status(id) }); } catch (error) { return fail(error); } },
    }),
  ];
}
