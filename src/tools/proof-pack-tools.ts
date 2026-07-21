import type { AuditEvent } from '../audit/event-types.js';
import type { ToolDefinition, ToolPrincipal } from '../core/types.js';
import { defineTool } from './registry.js';

function principal(ctx: Parameters<ToolDefinition['handler']>[1]): ToolPrincipal {
  return ctx.control?.principal ?? { id: 'agent:unknown', role: 'agent' };
}

function fail(error: unknown) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function taskAuditEvents(raw: string, taskId: string): AuditEvent[] {
  if (!raw.trim()) return [];
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event?: AuditEvent })
    .map((envelope) => envelope.event)
    .filter((event): event is AuditEvent => Boolean(event))
    .filter((event) => event.detail?.taskId === taskId)
    .slice(-2_000);
}

export function proofPackTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'workflow_proof_pack',
      description:
        'Create an immutable, secret-redacted Proof Pack for a terminal owned workflow with per-file and manifest integrity hashes.',
      group: 'workflow',
      mutates: true,
      risk: 'MEDIUM',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      outputSchema: { type: 'object', additionalProperties: true },
      handler: async (args, ctx) => {
        try {
          const owner = principal(ctx);
          const run = ctx.container.workflows.get(String(args.id ?? ''), owner);
          const auditVerification = ctx.container.audit.verify();
          if (!auditVerification.ok) {
            return { ok: false, error: 'Audit chain integrity must pass before Proof Pack creation.' };
          }
          const isolation = run.task.isolationId
            ? ctx.container.isolation.get(run.task.isolationId)
            : undefined;
          if (run.task.isolationId && !isolation) {
            return {
              ok: false,
              error: `Workflow isolation evidence is missing: ${run.task.isolationId}`,
            };
          }
          const pack = ctx.container.proofPacks.create({
            run,
            approvals: ctx.container.policy.approvals.all(),
            auditEvents: taskAuditEvents(ctx.container.audit.exportRaw(), run.id),
            auditVerification,
            ...(isolation ? { isolation } : {}),
          });
          let attached = false;
          try {
            ctx.container.workflows.addProofPack(
              run.id,
              {
                id: pack.id,
                manifestSha256: pack.manifestSha256,
                createdAt: pack.createdAt,
              },
              owner,
            );
            attached = true;
            ctx.container.audit.record({
              type: 'task_event',
              tool: 'workflow_proof_pack',
              risk: 'MEDIUM',
              ok: true,
              summary: `proof_pack_created:${pack.id}`,
              detail: {
                requesterId: owner.id,
                taskId: run.id,
                proofPackId: pack.id,
                manifestSha256: pack.manifestSha256,
              },
            });
            return { ok: true, data: { proofPack: pack } };
          } catch (error) {
            let cleanupError: unknown;
            try {
              if (attached) {
                ctx.container.workflows.removeProofPack(run.id, pack.id, owner);
              }
              ctx.container.proofPacks.remove(pack.id);
            } catch (cleanupFailure) {
              cleanupError = cleanupFailure;
            }
            if (cleanupError) {
              throw new Error(
                `Proof Pack creation failed and cleanup was incomplete: ${error instanceof Error ? error.message : String(error)}; cleanup=${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
              );
            }
            throw error;
          }
        } catch (error) {
          return fail(error);
        }
      },
    }),
    defineTool({
      name: 'workflow_proof_verify',
      description: 'Verify every file hash and manifest hash for an owned workflow Proof Pack.',
      group: 'workflow',
      mutates: false,
      risk: 'LOW',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, proofPackId: { type: 'string' } },
        required: ['id', 'proofPackId'],
        additionalProperties: false,
      },
      outputSchema: { type: 'object', additionalProperties: true },
      handler: async (args, ctx) => {
        try {
          const run = ctx.container.workflows.get(String(args.id ?? ''), principal(ctx));
          const proofPackId = String(args.proofPackId ?? '');
          if (!run.proofPacks.some((item: { id: string }) => item.id === proofPackId)) {
            return { ok: false, error: `Proof Pack is not attached to workflow ${run.id}.` };
          }
          return {
            ok: true,
            data: { proofPack: ctx.container.proofPacks.verify(proofPackId), verified: true },
          };
        } catch (error) {
          return fail(error);
        }
      },
    }),
    defineTool({
      name: 'workflow_proof_list',
      description: 'List integrity-verified Proof Packs attached to an owned workflow.',
      group: 'workflow',
      mutates: false,
      risk: 'LOW',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      outputSchema: { type: 'object', additionalProperties: true },
      handler: async (args, ctx) => {
        try {
          const run = ctx.container.workflows.get(String(args.id ?? ''), principal(ctx));
          const packs = run.proofPacks.map((item: { id: string }) => ctx.container.proofPacks.verify(item.id));
          return { ok: true, data: { workflowId: run.id, proofPacks: packs } };
        } catch (error) {
          return fail(error);
        }
      },
    }),
  ];
}
