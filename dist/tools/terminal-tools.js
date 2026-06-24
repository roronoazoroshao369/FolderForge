import { execa } from 'execa';
import { defineTool } from './registry.js';
export function terminalTools() {
    return [
        defineTool({
            name: 'shell_exec',
            description: 'Run a single shell command in the workspace with timeout, blocklist, and output limits.',
            group: 'terminal',
            mutates: true,
            inputSchema: {
                type: 'object',
                properties: {
                    command: { type: 'string' },
                    cwd: { type: 'string' },
                    timeoutMs: { type: 'number' },
                },
                required: ['command'],
            },
            handler: async (args, ctx) => {
                const command = String(args.command);
                const cls = ctx.container.policy.command.classify(command);
                if (cls.risk === 'CRITICAL' && ctx.container.policy.getMode() !== 'danger') {
                    return { ok: false, error: `Blocked destructive command: ${cls.blockedReason ?? command}` };
                }
                const cwd = args.cwd
                    ? ctx.container.policy.path.resolveSafe(String(args.cwd), ctx.projectRoot)
                    : ctx.projectRoot;
                const timeout = Number(args.timeoutMs ?? ctx.config.terminal.defaultTimeoutMs);
                const maxBytes = ctx.config.terminal.maxOutputBytes;
                const started = Date.now();
                try {
                    const sub = await execa(ctx.config.terminal.shell, ['-lc', command], {
                        cwd,
                        timeout,
                        reject: false,
                        all: false,
                        maxBuffer: maxBytes * 4,
                    });
                    const redact = (s) => ctx.container.policy.secret.redact((s ?? '').slice(0, maxBytes));
                    return {
                        ok: sub.exitCode === 0,
                        data: {
                            exitCode: sub.exitCode,
                            stdout: redact(sub.stdout),
                            stderr: redact(sub.stderr),
                            durationMs: Date.now() - started,
                            risk: cls.risk,
                        },
                    };
                }
                catch (err) {
                    return { ok: false, error: `Execution failed: ${String(err)}` };
                }
            },
        }),
    ];
}
