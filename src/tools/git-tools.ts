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
        const redacted = ctx.container.policy.secret.redact(diff);
        const label = args.file ? String(args.file) : args.staged ? 'staged' : 'working tree';
        // Attach the diff as an embedded resource so spec-aware clients can render
        // it in a dedicated diff viewer/tab instead of a wall of text. Text-only
        // clients still get the diff in `data.diff`.
        return {
          ok: true,
          data: { diff: redacted },
          ...(redacted.trim()
            ? {
                content: [
                  {
                    kind: 'resource' as const,
                    uri: `folderforge://diff/${encodeURIComponent(label)}`,
                    title: `git diff (${label})`,
                    mimeType: 'text/x-diff',
                    text: redacted,
                  },
                ],
              }
            : {}),
        };
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
      name: 'git_fetch',
      description:
        'Fetch updates from a remote without touching the working tree. Updates ' +
        'remote-tracking refs only; safe and non-destructive.',
      group: 'git',
      mutates: true,
      annotations: { openWorldHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          remote: { type: 'string', description: 'Remote name (default origin).' },
          branch: { type: 'string', description: 'Specific branch to fetch (default all).' },
          prune: { type: 'boolean', description: 'Prune deleted remote-tracking branches.' },
        },
      },
      handler: async (args, ctx) => {
        const remote = String(args.remote ?? 'origin');
        const branch = args.branch ? String(args.branch) : undefined;
        const opts = args.prune ? ['--prune'] : [];
        await ctx.control?.reportProgress?.(0, 1, `Fetching from ${remote}...`);
        const res = await git(ctx).fetch(remote, branch as string, opts);
        await ctx.control?.reportProgress?.(1, 1, 'Fetch complete.');
        return {
          ok: true,
          data: {
            remote,
            branch: branch ?? null,
            updated: res.updated ?? [],
            deleted: res.deleted ?? [],
          },
        };
      },
    }),

    defineTool({
      name: 'git_pull',
      description:
        'Pull and integrate changes from a remote into the current branch. HIGH ' +
        'risk: may rewrite working-tree files and produce merge conflicts. ' +
        'Confirms interactively when the client supports elicitation.',
      group: 'git',
      mutates: true,
      annotations: { openWorldHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          remote: { type: 'string', description: 'Remote name (default origin).' },
          branch: { type: 'string', description: 'Branch to pull (default current upstream).' },
          rebase: { type: 'boolean', description: 'Use --rebase instead of merge.' },
        },
      },
      handler: async (args, ctx) => {
        const remote = String(args.remote ?? 'origin');
        const branch = args.branch ? String(args.branch) : undefined;
        const rebase = args.rebase === true;

        // P8 - elicitation: a pull can overwrite local files and create
        // conflicts, so confirm before integrating when the client supports it.
        // Clients without the capability proceed (policy/approval gate upstream).
        if (ctx.control?.elicitInput) {
          const status = await git(ctx).status();
          const target = branch ?? status.tracking ?? status.current ?? 'upstream';
          const dirty = !status.isClean();
          const res = await ctx.control.elicitInput({
            message:
              `Pull from ${remote}/${target} into ${status.current}` +
              `${rebase ? ' (rebase)' : ''}? ` +
              `${dirty ? 'Your working tree has uncommitted changes. ' : ''}` +
              'This may modify local files.',
            requestedSchema: {
              type: 'object',
              properties: {
                confirm: { type: 'boolean', description: 'Confirm the pull.' },
              },
              required: ['confirm'],
            },
          });
          if (res.action !== 'accept' || res.content?.confirm !== true) {
            return { ok: false, error: `git_pull cancelled by user (${res.action}).` };
          }
        }

        const opts: Record<string, null> = {};
        if (rebase) opts['--rebase'] = null;
        await ctx.control?.reportProgress?.(0, 1, `Pulling from ${remote}...`);
        const summary = await git(ctx).pull(remote, branch, opts);
        await ctx.control?.reportProgress?.(1, 1, 'Pull complete.');
        return {
          ok: true,
          data: {
            remote,
            branch: branch ?? null,
            rebase,
            changes: summary.summary?.changes ?? 0,
            insertions: summary.summary?.insertions ?? 0,
            deletions: summary.summary?.deletions ?? 0,
            files: summary.files ?? [],
          },
        };
      },
    }),

    defineTool({
      name: 'git_stash',
      description:
        'Save, restore, list, or drop stashed changes. op: push (default) | pop | ' +
        'apply | list | drop. Hard data loss is avoided (no stash clear).',
      group: 'git',
      mutates: true,
      inputSchema: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['push', 'pop', 'apply', 'list', 'drop'],
            description: 'Stash operation (default push).',
          },
          message: { type: 'string', description: 'Optional label when op=push.' },
          index: { type: 'number', description: 'Stash index for pop/apply/drop (default 0).' },
          includeUntracked: { type: 'boolean', description: 'Include untracked files when op=push.' },
        },
      },
      handler: async (args, ctx) => {
        const op = String(args.op ?? 'push');
        const g = git(ctx);

        if (op === 'list') {
          const list = await g.stashList();
          return {
            ok: true,
            data: {
              op,
              count: list.total,
              entries: list.all.map((e) => ({ hash: e.hash.slice(0, 8), message: e.message })),
            },
          };
        }

        if (op === 'push') {
          const opts = ['push'];
          if (args.includeUntracked) opts.push('--include-untracked');
          if (args.message) opts.push('-m', String(args.message));
          const out = await g.stash(opts);
          return { ok: true, data: { op, result: out.trim() } };
        }

        if (op === 'pop' || op === 'apply' || op === 'drop') {
          const index = Number(args.index ?? 0);
          if (!Number.isInteger(index) || index < 0) {
            return { ok: false, error: `Invalid stash index: ${args.index}` };
          }
          const out = await g.stash([op, `stash@{${index}}`]);
          return { ok: true, data: { op, index, result: out.trim() } };
        }

        return { ok: false, error: `Unknown stash op: ${op}` };
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
