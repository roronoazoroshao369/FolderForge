import { execa } from 'execa';
import { defineTool } from './registry.js';
import { detectCommands } from '../workspace/project-detector.js';
import { parseErrors } from './error-parser.js';
async function runScript(ctx, key) {
    const cmds = detectCommands(ctx.projectRoot);
    const command = cmds.scripts[key];
    if (!command)
        return { ok: false, error: `No ${key} command detected for this project.` };
    const sub = await execa(ctx.config.terminal.shell, ['-lc', command], {
        cwd: ctx.projectRoot,
        timeout: ctx.config.terminal.defaultTimeoutMs,
        reject: false,
        maxBuffer: ctx.config.terminal.maxOutputBytes * 4,
    });
    const max = ctx.config.terminal.maxOutputBytes;
    const stdout = ctx.container.policy.secret.redact((sub.stdout ?? '').slice(0, max));
    const stderr = ctx.container.policy.secret.redact((sub.stderr ?? '').slice(0, max));
    const errors = parseErrors(stdout + '\n' + stderr);
    return {
        ok: sub.exitCode === 0,
        data: { command, exitCode: sub.exitCode, stdout, stderr, errors },
    };
}
export function buildTools() {
    return [
        defineTool({
            name: 'project_detect_commands',
            description: 'Detect package manager and dev/test/build/lint commands from project manifests.',
            group: 'build',
            mutates: false,
            inputSchema: { type: 'object', properties: {} },
            handler: async (_a, ctx) => ({ ok: true, data: detectCommands(ctx.projectRoot) }),
        }),
        defineTool({
            name: 'run_test',
            description: 'Run the project test suite and parse failures.',
            group: 'build',
            mutates: false,
            inputSchema: { type: 'object', properties: {} },
            handler: async (_a, ctx) => runScript(ctx, 'test'),
        }),
        defineTool({
            name: 'run_lint',
            description: 'Run the project linter.',
            group: 'build',
            mutates: false,
            inputSchema: { type: 'object', properties: {} },
            handler: async (_a, ctx) => runScript(ctx, 'lint'),
        }),
        defineTool({
            name: 'run_typecheck',
            description: 'Run the project type checker.',
            group: 'build',
            mutates: false,
            inputSchema: { type: 'object', properties: {} },
            handler: async (_a, ctx) => runScript(ctx, 'typecheck'),
        }),
        defineTool({
            name: 'run_build',
            description: 'Run the project build.',
            group: 'build',
            mutates: true,
            inputSchema: { type: 'object', properties: {} },
            handler: async (_a, ctx) => runScript(ctx, 'build'),
        }),
        defineTool({
            name: 'parse_errors',
            description: 'Parse a build/test output string into structured errors.',
            group: 'build',
            mutates: false,
            inputSchema: { type: 'object', properties: { output: { type: 'string' } }, required: ['output'] },
            handler: async (args) => ({ ok: true, data: { errors: parseErrors(String(args.output)) } }),
        }),
    ];
}
