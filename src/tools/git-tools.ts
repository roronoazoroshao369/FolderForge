import { simpleGit, type SimpleGit } from 'simple-git';
import { defineTool } from './registry.js';
import type { ToolDefinition, ToolContext } from '../core/types.js';
import { GIT_STATUS_OUTPUT_SCHEMA } from './output-schemas.js';

function git(ctx: ToolContext): SimpleGit {
  return simpleGit({ baseDir: ctx.projectRoot });
}

export function gitTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'git_status',
      description: 'Show git branch and changed/staged/unstaged files.',
      group: 'git',
      mutates: false,
      inputSchema: { type: 'object', properties: {} },
      outputSchema: GIT_STATUS_OUTPUT_SCHEMA,
      handler: async (_a, ctx) => {
        const s = await git(ctx).status();
        return {
          ok: true,
          data: {
            branch: s.current,
            ahead: s.ahead,
            behind: s.behind,
            staged: s.staged,
            modified: s.modified,
            not_added: s.not_added,
            deleted: s.deleted,
            conflicted: s.conflicted,
            clean: s.isClean(),
          },
        };
      },
    }),

    defineTool({
      name: 'git_diff',
      description: 'Show diff for the working tree, staged changes, or a specific file.',
      group: 'git',
      mutates: false,
      inputSchema: {
        type: 'object',
        properties: { staged: { type: 'boolean' }, file: { type: 'string' } },
      },
      handler: async (args, ctx) => {
        const opts: string[] = [];
        if (args.staged) opts.push('--cached');
        if (args.file) opts.push('--', String(args.file));
        const diff = await git(ctx).diff(opts);
        return { ok: true, data: { diff: ctx.container.policy.secret.redact(diff) } };
      },
    }),

    defineTool({
      name: 'git_log',
      description: 'Show recent commits.',
      group: 'git',
      mutates: false,
      inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
      handler: async (args, ctx) => {
        const log = await git(ctx).log({ maxCount: Number(args.limit ?? 20) });
        return {
          ok: true,
          data: {
            commits: log.all.map((c) => ({ hash: c.hash.slice(0, 8), date: c.date, message: c.message, author: c.author_name })),
          },
        };
      },
    }),

    defineTool({
      name: 'git_branch',
      description: 'List branches or create a new one.',
      group: 'git',
      mutates: false,
      inputSchema: { type: 'object', properties: { create: { type: 'string' } } },
      handler: async (args, ctx) => {
        if (args.create) {
          await git(ctx).checkoutLocalBranch(String(args.create));
          return { ok: true, data: { created: String(args.create) } };
        }
        const b = await git(ctx).branchLocal();
        return { ok: true, data: { current: b.current, branches: b.all } };
      },
    }),

    defineTool({
      name: 'git_checkout',
      description: 'Switch to an existing branch.',
      group: 'git',
      mutates: true,
      inputSchema: { type: 'object', properties: { branch: { type: 'string' } }, required: ['branch'] },
      handler: async (args, ctx) => {
        await git(ctx).checkout(String(args.branch));
        return { ok: true, data: { branch: String(args.branch) } };
      },
    }),

    defineTool({
      name: 'git_add',
      description: 'Stage files for commit. Requires approval in safe mode.',
      group: 'git',
      mutates: true,
      inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] },
      handler: async (args, ctx) => {
        await git(ctx).add(args.files as string[]);
        return { ok: true, data: { staged: args.files } };
      },
    }),

    defineTool({
      name: 'git_commit',
      description: 'Commit staged files. Requires approval.',
      group: 'git',
      mutates: true,
      inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      handler: async (args, ctx) => {
        const res = await git(ctx).commit(String(args.message));
        return { ok: true, data: { commit: res.commit, summary: res.summary } };
      },
    }),

    defineTool({
      name: 'git_push',
      description: 'Push commits. CRITICAL; denied unless danger mode + approval. Force push disabled.',
      group: 'git',
      mutates: true,
      inputSchema: { type: 'object', properties: { remote: { type: 'string' }, branch: { type: 'string' } } },
      handler: async (args, ctx) => {
        const remote = String(args.remote ?? 'origin');
        const branch = args.branch ? String(args.branch) : undefined;

        // P8 - elicitation: pushing is irreversible from the local side
        // (publishes commits to a shared remote). When the client supports
        // interactive input, confirm the exact remote/branch before pushing.
        // Clients without the capability see `elicitInput === undefined` and
        // the push proceeds (policy/approval already gate it upstream).
        if (ctx.control?.elicitInput) {
          const status = await git(ctx).status();
          const target = branch ?? status.current ?? 'current branch';
          const ahead = status.ahead ?? 0;
          const res = await ctx.control.elicitInput({
            message: `Push ${ahead} commit(s) to ${remote}/${target}? This publishes them to the shared remote.`,
            requestedSchema: {
              type: 'object',
              properties: {
                confirm: {
                  type: 'boolean',
                  description: 'Confirm the push.',
                },
              },
              required: ['confirm'],
            },
          });
          if (res.action !== 'accept' || res.content?.confirm !== true) {
            return { ok: false, error: `git_push cancelled by user (${res.action}).` };
          }
        }

        // P4 - progress: report a tick before and after the network call so a
        // client that sent a progressToken sees the long push advance.
        await ctx.control?.reportProgress?.(0, 1, `Pushing to ${remote}...`);
        await git(ctx).push(remote, branch);
        await ctx.control?.reportProgress?.(1, 1, 'Push complete.');
        return { ok: true, data: { pushed: true, remote, branch: branch ?? null } };
      },
    }),

    defineTool({
      name: 'git_reset',
      description: 'Reset staged changes (soft/mixed only). CRITICAL; hard reset disabled.',
      group: 'git',
      mutates: true,
      inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['soft', 'mixed'] } } },
      handler: async (args, ctx) => {
        const mode = String(args.mode ?? 'mixed');
        if (mode === 'hard' && !ctx.config.git.allowResetHard) {
          return { ok: false, error: 'Hard reset is disabled by configuration.' };
        }

        // P8 - elicitation: when the connected client supports it, confirm this
        // destructive reset interactively before touching the index. Clients
        // without the capability see `elicitInput === undefined` and the reset
        // proceeds non-interactively (policy/approval already gate it upstream).
        if (ctx.control?.elicitInput) {
          const status = await git(ctx).status();
          const res = await ctx.control.elicitInput({
            message: `Reset (--${mode}) will unstage ${status.staged.length} file(s) on branch ${status.current}. Continue?`,
            requestedSchema: {
              type: 'object',
              properties: {
                confirm: {
                  type: 'boolean',
                  description: 'Confirm the reset.',
                },
              },
              required: ['confirm'],
            },
          });
          if (res.action !== 'accept' || res.content?.confirm !== true) {
            return { ok: false, error: `git_reset cancelled by user (${res.action}).` };
          }
        }

        await git(ctx).reset([`--${mode}`]);
        return { ok: true, data: { reset: mode } };
      },
    }),

    defineTool({
      name: 'git_show',
      description: 'Show a commit by ref (read-only).',
      group: 'git',
      mutates: false,
      inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
      handler: async (args, ctx) => {
        const out = await git(ctx).show([String(args.ref)]);
        return { ok: true, data: { content: ctx.container.policy.secret.redact(out) } };
      },
    }),

    defineTool({
      name: 'git_blame',
      description: 'Show blame for a file (read-only).',
      group: 'git',
      mutates: false,
      inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },
      handler: async (args, ctx) => {
        const out = await git(ctx).raw(['blame', String(args.file)]);
        return { ok: true, data: { blame: out.slice(0, 50000) } };
      },
    }),
  ];
}
