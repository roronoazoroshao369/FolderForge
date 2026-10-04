import { execa } from 'execa';
import { defineTool } from './registry.js';
import type { ToolDefinition } from '../core/types.js';
import { SHELL_EXEC_OUTPUT_SCHEMA } from './output-schemas.js';
import { shellCommandArgs, shellSpawnOptions } from '../core/shell.js';
import { armTreeKillTimeout } from '../core/process-tree.js';
import { buildSandboxedShellLaunch, removeSandboxContainer } from '../sandbox/launcher.js';
import type { ChildProcess } from 'node:child_process';

export function terminalTools(): ToolDefinition[] {
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
      outputSchema: SHELL_EXEC_OUTPUT_SCHEMA,
      handler: async (args, ctx) => {
        const command = String(args.command);
        const cls = ctx.container.policy.command.classify(command);
        const effectiveRisk = cls.risk === 'CRITICAL' ? 'CRITICAL' : 'HIGH';
        if (cls.blockedReason) {
          return { ok: false, error: `Blocked destructive command: ${cls.blockedReason}` };
        }
        const cwd = args.cwd
          ? ctx.container.policy.path.resolveSafe(String(args.cwd), ctx.projectRoot)
          : ctx.projectRoot;
        const timeout = Number(args.timeoutMs ?? ctx.config.terminal.defaultTimeoutMs);
        const maxBytes = ctx.config.terminal.maxOutputBytes;

        const started = Date.now();
        try {
          const launch = buildSandboxedShellLaunch(
            ctx.config.terminal.sandbox,
            ctx.config.terminal.shell,
            ctx.projectRoot,
            cwd,
            command,
          );
          const processMode = launch.sandboxMode === 'process';
          const child = execa(
            launch.command,
            processMode ? shellCommandArgs(ctx.config.terminal.shell, command) : launch.args,
            {
              cwd: launch.cwd,
              reject: false,
              all: false,
              maxBuffer: maxBytes * 4,
              // Detached on POSIX so a timeout can reap the whole process
              // group, not just the direct shell child (proposal 008).
              ...(process.platform !== 'win32' ? { detached: true as const } : {}),
              ...(processMode ? shellSpawnOptions(ctx.config.terminal.shell) : {}),
            }
          );
          // A natural timeout must reap the whole tree: execa's own timeout
          // only reaches the direct shell child, leaving orphaned grandchildren
          // holding the stdio pipes and hanging this await past the budget.
          const treeTimeout = armTreeKillTimeout(child as unknown as ChildProcess, timeout);
          const sub = await child.finally(() => treeTimeout.dispose());
          // Killing the `docker run` client leaves the container running (R11).
          if (launch.containerName && (treeTimeout.timedOut || sub.exitCode === undefined)) {
            await removeSandboxContainer(launch.sandboxMode, launch.containerName);
          }
          const redact = (s: string) =>
            ctx.container.policy.secret.redact((s ?? '').slice(0, maxBytes));
          const data = {
            // execa reports `undefined` when the child is terminated by a signal
            // (e.g. SIGTERM/SIGKILL) rather than exiting normally. The declared
            // output schema requires `exitCode`, and an undefined value is dropped
            // during JSON serialization, which made structuredContent fail client
            // side validation. Normalize to null, which the schema permits.
            exitCode: sub.exitCode ?? null,
            stdout: redact(sub.stdout),
            stderr: redact(sub.stderr),
            durationMs: Date.now() - started,
            risk: effectiveRisk,
          };
          return sub.exitCode === 0
            ? { ok: true, data }
            : {
                ok: false,
                error: `Command exited with code ${sub.exitCode ?? 'unknown'}.`,
                data,
              };
        } catch (err) {
          return { ok: false, error: `Execution failed: ${String(err)}` };
        }
      },
    }),
  ];
}
