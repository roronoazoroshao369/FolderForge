import { defineTool } from './registry.js';
export function memoryTools() {
    return [
        defineTool({
            name: 'memory_list',
            description: 'List project memory files.',
            group: 'memory',
            mutates: false,
            inputSchema: { type: 'object', properties: {} },
            handler: async (_a, ctx) => ({ ok: true, data: { memories: ctx.container.workspace.getMemory().list() } }),
        }),
        defineTool({
            name: 'memory_read',
            description: 'Read a project memory file by name.',
            group: 'memory',
            mutates: false,
            inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
            handler: async (args, ctx) => ({
                ok: true,
                data: { content: ctx.container.workspace.getMemory().read(String(args.name)) },
            }),
        }),
        defineTool({
            name: 'memory_write',
            description: 'Create or overwrite a project memory file.',
            group: 'memory',
            mutates: true,
            inputSchema: {
                type: 'object',
                properties: { name: { type: 'string' }, content: { type: 'string' } },
                required: ['name', 'content'],
            },
            handler: async (args, ctx) => {
                const path = ctx.container.workspace.getMemory().write(String(args.name), String(args.content));
                return { ok: true, data: { path } };
            },
        }),
        defineTool({
            name: 'memory_update',
            description: 'Append content to an existing project memory file.',
            group: 'memory',
            mutates: true,
            inputSchema: {
                type: 'object',
                properties: { name: { type: 'string' }, append: { type: 'string' } },
                required: ['name', 'append'],
            },
            handler: async (args, ctx) => {
                const path = ctx.container.workspace.getMemory().update(String(args.name), String(args.append));
                return { ok: true, data: { path } };
            },
        }),
    ];
}
