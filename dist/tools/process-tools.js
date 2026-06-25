import { defineTool } from './registry.js';
export function processTools() {
    return [
        defineTool({
            name: 'process_start',
            description: 'Start a long-running process (dev server, watcher) and return a session id.',
            group: 'process',
            mutates: true,
            inputSchema: {
                type: 'object',
                properties: { command: { type: 'string' }, cwd: { type: 'string' } },
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
                const session = ctx.container.processes.start(command, cwd, ctx.config.terminal.shell);
                ctx.container.audit.record({ type: 'process_event', summary: `start ${session.sessionId}: ${command}` });
                return { ok: true, data: session };
            },
        }),
        defineTool({
            name: 'process_read',
            description: 'Read new output from a process session since the last cursor.',
            group: 'process',
            mutates: false,
            inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
            handler: async (args, ctx) => {
                const out = ctx.container.processes.read(String(args.sessionId));
                return { ok: true, data: { ...out, output: ctx.container.policy.secret.redact(out.output) } };
            },
        }),
        defineTool({
            name: 'process_tail',
            description: 'Stream output from a process session: blocks until new output arrives, the ' +
                'process exits, or timeoutMs elapses (default 2000ms). Call repeatedly to ' +
                'follow a long-running command. `done` is true once the process has exited ' +
                'and all output has been drained.',
            group: 'process',
            mutates: false,
            inputSchema: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string' },
                    timeoutMs: { type: 'number', description: 'Max ms to wait for new output (default 2000).' },
                },
                required: ['sessionId'],
            },
            handler: async (args, ctx) => {
                const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 2000), 0), 30000);
                const signal = ctx.control?.signal;
                const out = await ctx.container.processes.readUntil(String(args.sessionId), timeoutMs, signal);
                // P4 - progress: report a tick each tail cycle so a client following a
                // long-running command sees liveness without parsing the buffer. The
                // total is unknown for an open-ended stream, so we omit it and send a
                // status message instead.
                await ctx.control?.reportProgress?.(out.cursor, undefined, out.done ? 'process exited' : `streaming (${out.status})`);
                if (signal?.aborted && !out.done) {
                    return {
                        ok: true,
                        data: {
                            ...out,
                            output: ctx.container.policy.secret.redact(out.output),
                            cancelled: true,
                        },
                    };
                }
                return { ok: true, data: { ...out, output: ctx.container.policy.secret.redact(out.output) } };
            },
        }),
        defineTool({
            name: 'process_write',
            description: 'Send a line of input to a running process session.',
            group: 'process',
            mutates: true,
            inputSchema: {
                type: 'object',
                properties: { sessionId: { type: 'string' }, input: { type: 'string' } },
                required: ['sessionId', 'input'],
            },
            handler: async (args, ctx) => {
                ctx.container.processes.write(String(args.sessionId), String(args.input));
                return { ok: true, data: { sent: true } };
            },
        }),
        defineTool({
            name: 'process_stop',
            description: 'Stop a process session gracefully (SIGTERM).',
            group: 'process',
            mutates: true,
            inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
            handler: async (args, ctx) => {
                const s = ctx.container.processes.stop(String(args.sessionId));
                ctx.container.audit.record({ type: 'process_event', summary: `stop ${s.sessionId}` });
                return { ok: true, data: s };
            },
        }),
        defineTool({
            name: 'process_kill',
            description: 'Force-kill a process session (SIGKILL). HIGH risk; requires approval.',
            group: 'process',
            mutates: true,
            inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
            handler: async (args, ctx) => {
                const id = String(args.sessionId);
                if (!ctx.container.processes.isManaged(id)) {
                    return { ok: false, error: 'Refusing to kill a process not started by FolderForge.' };
                }
                const s = ctx.container.processes.kill(id);
                return { ok: true, data: s };
            },
        }),
        defineTool({
            name: 'process_list',
            description: 'List process sessions managed by FolderForge.',
            group: 'process',
            mutates: false,
            inputSchema: { type: 'object', properties: {} },
            handler: async (_args, ctx) => ({ ok: true, data: { sessions: ctx.container.processes.list() } }),
        }),
    ];
}
