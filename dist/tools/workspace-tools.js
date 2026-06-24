import { existsSync } from 'node:fs';
import { defineTool } from './registry.js';
import { detectCommands } from '../workspace/project-detector.js';
import { onboardProject } from '../workspace/onboarding.js';
import { TASK_PRESETS } from './index.js';
export function workspaceTools() {
    return [
        defineTool({
            name: 'workspace_activate',
            description: 'Activate a local project as the active workspace.',
            group: 'workspace',
            mutates: true,
            inputSchema: {
                type: 'object',
                properties: { path: { type: 'string', description: 'Absolute path to the project folder.' } },
                required: ['path'],
            },
            handler: async (args, ctx) => {
                const info = ctx.container.workspace.activate(String(args.path));
                ctx.container.audit.record({ type: 'workspace_activate', summary: info.projectRoot });
                return { ok: true, data: info };
            },
        }),
        defineTool({
            name: 'workspace_status',
            description: 'Return the active workspace, policy mode, allowed directories, and enabled adapters.',
            group: 'workspace',
            mutates: false,
            inputSchema: { type: 'object', properties: {} },
            handler: async (_args, ctx) => {
                const active = ctx.container.workspace.getActive();
                return {
                    ok: true,
                    data: {
                        active: Boolean(active),
                        project: active,
                        mode: ctx.container.policy.getMode(),
                        allowedDirectories: ctx.config.workspace.allowedDirectories,
                        adapters: ctx.container.adapters.status(),
                    },
                };
            },
        }),
        defineTool({
            name: 'workspace_onboard',
            description: 'Scan the project and generate memory files (overview, commands, conventions, testing).',
            group: 'workspace',
            mutates: true,
            inputSchema: { type: 'object', properties: {} },
            handler: async (_args, ctx) => {
                const root = ctx.container.workspace.requireActive().projectRoot;
                const memory = ctx.container.workspace.getMemory();
                const result = onboardProject(root, memory);
                return { ok: true, data: result };
            },
        }),
        defineTool({
            name: 'workspace_health',
            description: 'Run health checks: folder, git, package manager, adapters, detected commands, policy.',
            group: 'workspace',
            mutates: false,
            inputSchema: { type: 'object', properties: {} },
            handler: async (_args, ctx) => {
                const active = ctx.container.workspace.getActive();
                const root = active?.projectRoot ?? ctx.projectRoot;
                const cmds = active ? detectCommands(root) : { packageManager: null, scripts: {} };
                const serena = await ctx.container.adapters.health('serena').catch(() => ({ enabled: false, ready: false }));
                const playwright = await ctx.container.adapters
                    .health('playwright')
                    .catch(() => ({ enabled: false, ready: false }));
                return {
                    ok: true,
                    data: {
                        folderExists: existsSync(root),
                        gitRepo: active?.git ?? false,
                        packageManager: cmds.packageManager,
                        commandsDetected: Object.keys(cmds.scripts),
                        adapters: { serena, playwright },
                        policyLoaded: true,
                        mode: ctx.container.policy.getMode(),
                    },
                };
            },
        }),
        defineTool({
            name: 'workspace_route',
            description: 'Switch the visible tool set to a task preset (explore, run_ui, fix_tests) ' +
                'or pass reset=true / preset="all" to expose every tool again.',
            group: 'workspace',
            mutates: false,
            inputSchema: {
                type: 'object',
                properties: {
                    preset: {
                        type: 'string',
                        description: 'Preset name: explore | run_ui | fix_tests | all',
                        enum: [...Object.keys(TASK_PRESETS), 'all'],
                    },
                    reset: { type: 'boolean', description: 'Expose every tool again (same as preset=all).' },
                },
            },
            handler: async (args, ctx) => {
                const registry = ctx.container.registry;
                if (!registry) {
                    return { ok: false, error: 'Tool registry is not available for routing.' };
                }
                const presets = Object.keys(TASK_PRESETS);
                const reset = args.reset === true || args.preset === 'all';
                if (reset) {
                    registry.setActive(null);
                    ctx.container.audit.record({ type: 'workspace_route', summary: 'all' });
                    return {
                        ok: true,
                        data: { preset: 'all', active: registry.listActive().map((t) => t.name) },
                    };
                }
                const preset = args.preset === undefined ? undefined : String(args.preset);
                if (!preset) {
                    return {
                        ok: true,
                        data: { presets, hint: 'Pass preset=<name> to focus the tool set, or reset=true to show all.' },
                    };
                }
                if (!presets.includes(preset)) {
                    return { ok: false, error: `Unknown preset "${preset}". Available: ${presets.join(', ')}, all.` };
                }
                registry.setActive(TASK_PRESETS[preset]);
                ctx.container.audit.record({ type: 'workspace_route', summary: preset });
                return {
                    ok: true,
                    data: { preset, active: registry.listActive().map((t) => t.name) },
                };
            },
        }),
    ];
}
