import type { ToolDefinition, ToolPrincipal } from '../core/types.js';
import { defineTool } from './registry.js';

export function capsuleTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'capsule_status',
      description:
        'Inspect the server-enforced Workspace Capsule bound to this principal/session and the current enforcement summary.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: {
          enforcement: { type: 'string', enum: ['optional', 'remote', 'all'] },
          total: { type: 'integer' },
          active: { type: 'integer' },
          expired: { type: 'integer' },
          revoked: { type: 'integer' },
          capsule: { type: ['object', 'null'] },
        },
        required: ['enforcement', 'total', 'active', 'expired', 'revoked', 'capsule'],
      },
      group: 'workspace',
      mutates: false,
      risk: 'LOW',
      handler: async (_args, ctx) => {
        const principal: ToolPrincipal = ctx.control?.principal ?? {
          id: 'agent:unknown',
          role: 'agent',
        };
        return {
          ok: true,
          data: {
            ...ctx.container.capsules.describe(),
            capsule: ctx.container.capsules.matching(principal, ctx.projectRoot) ?? null,
          },
        };
      },
    }),
  ];
}
