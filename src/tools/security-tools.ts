import { defineTool } from './registry.js';
import type { ToolDefinition, PolicyMode } from '../core/types.js';
import { readFileSync } from 'node:fs';

export function securityTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'policy_get',
      description: 'Return the current policy: mode, approval rules, blocked commands, allowed dirs.',
      group: 'security',
      mutates: false,
      inputSchema: { type: 'object', properties: {} },
      handler: async (_a, ctx) => ({ ok: true, data: ctx.container.policy.describe() }),
    }),
    defineTool({
      name: 'policy_explain',
      description:
        'Dry-run a tool call and explain the policy decision (allow | deny | approval) ' +
        'and why, without executing the tool or creating an approval request.',
      group: 'security',
      mutates: false,
      inputSchema: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'Name of the tool to evaluate.' },
          args: { type: 'object', description: 'Args the call would use (used for risk classification).' },
        },
        required: ['tool'],
      },
      handler: async (args, ctx) => {
        const toolName = String(args.tool);
        const callArgs = (args.args as Record<string, unknown> | undefined) ?? {};
        const registry = ctx.container.registry;
        const def = registry?.get(toolName);
        if (!def) {
          return { ok: false, error: `Unknown tool: ${toolName}` };
        }

        // Use the registry's exact pre-execution classification so explain stays
        // truthful for shell commands, dry-run agent tools, and facade sub-ops.
        const classification = registry.classifyCall(toolName, callArgs);
        if (!classification) {
          return { ok: false, error: `Unable to classify tool: ${toolName}` };
        }
        const governanceArgs = classification.governanceArgs ?? callArgs;
        const explanation = ctx.container.policy.explain(
          classification.name,
          classification.risk,
          classification.mutates,
          governanceArgs
        );
        return {
          ok: true,
          data: {
            tool: toolName,
            effectiveTool: classification.name,
            ...explanation,
          },
        };
      },
    }),
    defineTool({
      name: 'policy_set_mode',
      description: 'Admin plane only: set the policy mode to readonly, safe, dev, or danger.',
      group: 'security',
      audience: 'admin',
      mutates: true,
      inputSchema: {
        type: 'object',
        properties: { mode: { type: 'string', enum: ['readonly', 'safe', 'dev', 'danger'] } },
        required: ['mode'],
      },
      handler: async (args, ctx) => {
        const mode = String(args.mode) as PolicyMode;
        if (!['readonly', 'safe', 'dev', 'danger'].includes(mode)) {
          return { ok: false, error: `Invalid mode: ${mode}` };
        }
        ctx.container.policy.setMode(mode);
        return { ok: true, data: { mode } };
      },
    }),
    defineTool({
      name: 'audit_recent',
      description: 'Return recent audit events.',
      group: 'security',
      mutates: false,
      inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
      handler: async (args, ctx) => ({ ok: true, data: { events: ctx.container.audit.recent(Number(args.limit ?? 50)) } }),
    }),
    defineTool({
      name: 'audit_export',
      description: 'Return the path and contents of the JSONL audit log.',
      group: 'security',
      mutates: false,
      inputSchema: { type: 'object', properties: {} },
      handler: async (_a, ctx) => ({
        ok: true,
        data: { path: ctx.container.audit.exportPath(), jsonl: ctx.container.audit.exportRaw() },
      }),
    }),
    defineTool({
      name: 'approval_status',
      description: 'Check the status of an approval request, or list pending ones.',
      group: 'security',
      mutates: false,
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      handler: async (args, ctx) => {
        if (args.id) {
          const req = ctx.container.policy.approvals.get(String(args.id));
          return req ? { ok: true, data: req } : { ok: false, error: 'Approval not found.' };
        }
        return { ok: true, data: { pending: ctx.container.policy.approvals.pending() } };
      },
    }),
    defineTool({
      name: 'approval_approve',
      description:
        'Admin plane only: approve a pending request by id with once or session scope.',
      group: 'security',
      audience: 'admin',
      mutates: true,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Approval request id (e.g. appr_xxxxxxxx).' },
          scope: { type: 'string', enum: ['once', 'session'], description: 'Approval scope (default: once).' },
        },
        required: ['id'],
      },
      handler: async (args, ctx) => {
        const id = String(args.id);
        const scope = args.scope === 'session' ? 'session' : 'once';
        const existing = ctx.container.policy.approvals.get(id);
        if (!existing) return { ok: false, error: `Approval not found: ${id}` };
        if (existing.state !== 'pending') {
          return { ok: false, error: `Approval ${id} is already ${existing.state}.` };
        }
        const approverId = ctx.control?.principal?.id ?? 'admin:unknown';
        const req = ctx.container.policy.approvals.approve(id, scope, approverId);
        ctx.container.audit.record({
          type: 'approval_resolved',
          summary: `approve ${id} (${scope})`,
          detail: { approvalId: id, approverId },
        });
        return { ok: true, data: req };
      },
    }),
    defineTool({
      name: 'approval_deny',
      description: 'Admin plane only: deny a pending approval request by id.',
      group: 'security',
      audience: 'admin',
      mutates: true,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Approval request id (e.g. appr_xxxxxxxx).' } },
        required: ['id'],
      },
      handler: async (args, ctx) => {
        const id = String(args.id);
        const existing = ctx.container.policy.approvals.get(id);
        if (!existing) return { ok: false, error: `Approval not found: ${id}` };
        if (existing.state !== 'pending') {
          return { ok: false, error: `Approval ${id} is already ${existing.state}.` };
        }
        const approverId = ctx.control?.principal?.id ?? 'admin:unknown';
        const req = ctx.container.policy.approvals.deny(id, approverId);
        ctx.container.audit.record({
          type: 'approval_resolved',
          summary: `deny ${id}`,
          detail: { approvalId: id, approverId },
        });
        return { ok: true, data: req };
      },
    }),
    defineTool({
      name: 'approval_request',
      description: 'Create a manual approval request for a tool action.',
      group: 'security',
      mutates: false,
      inputSchema: {
        type: 'object',
        properties: { tool: { type: 'string' }, reason: { type: 'string' } },
        required: ['tool'],
      },
      handler: async (args, ctx) => {
        const requesterId = ctx.control?.principal?.id ?? 'agent:unknown';
        const req = ctx.container.policy.approvals.create(
          String(args.tool),
          {},
          'HIGH',
          String(args.reason ?? 'manual'),
          requesterId
        );
        return { ok: true, data: req };
      },
    }),
    defineTool({
      name: 'policy_ratelimits',
      description:
        'Show per-tool rate-limit usage: configured window/quota and how many ' +
        'calls have been used in the current window and rolling 24h.',
      group: 'security',
      mutates: false,
      inputSchema: { type: 'object', properties: {} },
      handler: async (_a, ctx) => ({
        ok: true,
        data: {
          enabled: ctx.config.rateLimit.enabled,
          default: ctx.config.rateLimit.default,
          usage: ctx.container.rateLimiter.snapshot(),
        },
      }),
    }),
    defineTool({
      name: 'secret_scan',
      description: 'Scan a file or text for potential secrets.',
      group: 'security',
      mutates: false,
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, text: { type: 'string' } },
      },
      handler: async (args, ctx) => {
        let text = String(args.text ?? '');
        if (args.path) {
          const abs = ctx.container.policy.path.resolveSafe(String(args.path), ctx.projectRoot);
          text = readFileSync(abs, 'utf8');
        }
        return { ok: true, data: { findings: ctx.container.policy.secret.scan(text) } };
      },
    }),
  ];
}
