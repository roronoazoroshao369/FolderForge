import { resolve } from 'node:path';
import type { ToolDefinition } from '../core/types.js';
import { defineTool } from './registry.js';

export function isolationTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'isolation_list',
      description: 'List managed Git worktree task isolations and their lifecycle state.',
      group: 'workspace',
      mutates: false,
      risk: 'LOW',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (_args, ctx) => ({
        ok: true,
        data: { ...ctx.container.isolation.describe(), isolations: ctx.container.isolation.list() },
      }),
    }),
    defineTool({
      name: 'isolation_create',
      description:
        'Create a task branch in a managed Git worktree without modifying or stashing the user working tree.',
      group: 'workspace',
      mutates: true,
      risk: 'MEDIUM',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', minLength: 1, maxLength: 64 },
          baseRef: { type: 'string', default: 'HEAD' },
        },
        required: ['taskId'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const sourceRoot = resolve(ctx.config.workspace.defaultProject);
        if (resolve(ctx.projectRoot) !== sourceRoot) {
          return {
            ok: false,
            error: 'Create isolation from the configured source repository, not from an existing task worktree.',
          };
        }
        const isolation = ctx.container.isolation.create(
          String(args.taskId),
          String(args.baseRef ?? 'HEAD'),
        );
        return { ok: true, data: { isolation } };
      },
    }),
    defineTool({
      name: 'isolation_status',
      description: 'Inspect changed, untracked, and conflicted paths in a managed task worktree.',
      group: 'workspace',
      mutates: false,
      risk: 'LOW',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => ({
        ok: true,
        data: ctx.container.isolation.status(String(args.id)),
      }),
    }),
    defineTool({
      name: 'isolation_diff',
      description: 'Return the binary-safe tracked diff and untracked path inventory for review.',
      group: 'workspace',
      mutates: false,
      risk: 'LOW',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const result = ctx.container.isolation.diff(String(args.id));
        return {
          ok: true,
          data: result,
          ...(result.diff ? { diff: result.diff } : {}),
        };
      },
    }),
    defineTool({
      name: 'isolation_apply',
      description:
        'Apply a reviewed task worktree diff to an unchanged clean source workspace; fails closed on drift or conflict.',
      group: 'workspace',
      audience: 'admin',
      mutates: true,
      risk: 'HIGH',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => ({
        ok: true,
        data: ctx.container.isolation.apply(String(args.id)),
      }),
    }),
    defineTool({
      name: 'isolation_rollback',
      description:
        'Rollback an exactly unchanged applied source change set using the pre-mutation journal and integrity-checked reverse patch.',
      group: 'workspace',
      audience: 'admin',
      mutates: true,
      risk: 'HIGH',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => ({
        ok: true,
        data: ctx.container.isolation.rollback(String(args.id)),
      }),
    }),
    defineTool({
      name: 'isolation_discard',
      description: 'Remove a managed task worktree and task branch after explicit operator action; applied changes must be rolled back first.',
      group: 'workspace',
      audience: 'admin',
      mutates: true,
      risk: 'HIGH',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => ({
        ok: true,
        data: { isolation: ctx.container.isolation.discard(String(args.id)) },
      }),
    }),
  ];
}
