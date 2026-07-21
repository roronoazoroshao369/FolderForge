import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { loadConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { buildRegistry } from '../../src/tools/index.js';
import type { ToolResult, PolicyMode } from '../../src/core/types.js';

/**
 * Q8 - git integration tests.
 *
 * These drive real git operations end-to-end through `registry.call()` against
 * a throwaway repository created per test, so the full pipeline (policy + audit
 * + handler + simple-git) is exercised - not just the handler in isolation.
 */

function setup(projectRoot: string, mode: PolicyMode = 'danger') {
  const config = loadConfig({ projectRoot });
  config.policy.defaultMode = mode;
  // git_commit / git_reset are HIGH/CRITICAL and would otherwise be approval-
  // gated. Tests run in danger mode and pre-grant a session approval so the
  // mutating pipeline actually executes (the gating itself is covered by the
  // policy-pipeline unit suite).
  const container = new Container(config);
  container.policy.setMode(mode);
  const registry = buildRegistry(container);
  // Pre-approve the HIGH/CRITICAL git tools for this session.
  for (const tool of ['git_commit', 'git_reset', 'git_push']) {
    const req = container.policy.approvals.create(tool, {}, 'HIGH', 'test pre-grant');
    container.policy.approvals.approve(req.id, 'session');
  }
  return { container, registry };
}

function data<T = Record<string, unknown>>(res: ToolResult): T {
  expect(res.ok).toBe(true);
  return res.data as T;
}

describe('git tools integration (Q8)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'ff-git-'));
    const g = simpleGit({ baseDir: repo });
    await g.init();
    await g.addConfig('user.email', 'test@folderforge.dev');
    await g.addConfig('user.name', 'FolderForge Test');
    await g.addConfig('commit.gpgsign', 'false');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.txt'), 'first\n');
    await g.add(['src/a.txt']);
    await g.commit('initial commit');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('reports a clean status on a fresh commit', async () => {
    const { registry } = setup(repo);
    await registry.call('workspace_activate', { path: repo });
    const status = data<{ clean: boolean; branch: string }>(
      await registry.call('git_status', {})
    );
    expect(status.clean).toBe(true);
    expect(status.branch).toBeTruthy();
  });

  it('detects an unstaged modification and a diff', async () => {
    const { registry } = setup(repo);
    await registry.call('workspace_activate', { path: repo });
    writeFileSync(join(repo, 'src', 'a.txt'), 'first\nsecond\n');

    const status = data<{ clean: boolean; modified: string[] }>(
      await registry.call('git_status', {})
    );
    expect(status.clean).toBe(false);
    expect(status.modified).toContain('src/a.txt');

    const diff = data<{ diff: string }>(await registry.call('git_diff', {}));
    expect(diff.diff).toContain('second');
  });

  it('stages, commits, and shows the new commit in the log', async () => {
    const { registry } = setup(repo);
    await registry.call('workspace_activate', { path: repo });
    writeFileSync(join(repo, 'src', 'b.txt'), 'new file\n');

    data(await registry.call('git_add', { files: ['src/b.txt'] }));
    data(await registry.call('git_commit', { message: 'add b.txt' }));

    const log = data<{ commits: Array<{ message: string }> }>(
      await registry.call('git_log', { limit: 5 })
    );
    expect(log.commits[0].message).toContain('add b.txt');
  });

  it('creates and lists a new branch', async () => {
    const { registry } = setup(repo);
    await registry.call('workspace_activate', { path: repo });
    data(await registry.call('git_branch', { create: 'feature/x' }));
    const branches = data<{ current: string; branches: string[] }>(
      await registry.call('git_branch', {})
    );
    expect(branches.current).toBe('feature/x');
    expect(branches.branches).toContain('feature/x');
  });

  it('unstages with git_reset (mixed) through the pipeline', async () => {
    const { registry } = setup(repo);
    await registry.call('workspace_activate', { path: repo });
    writeFileSync(join(repo, 'src', 'c.txt'), 'staged\n');
    data(await registry.call('git_add', { files: ['src/c.txt'] }));

    const before = data<{ staged: string[] }>(await registry.call('git_status', {}));
    expect(before.staged).toContain('src/c.txt');

    data(await registry.call('git_reset', { mode: 'mixed' }));

    const after = data<{ staged: string[]; not_added: string[] }>(
      await registry.call('git_status', {})
    );
    expect(after.staged).not.toContain('src/c.txt');
  });

  it('cancels git_reset when the elicitation client declines (P8)', async () => {
    const { registry } = setup(repo);
    await registry.call('workspace_activate', { path: repo });
    writeFileSync(join(repo, 'src', 'd.txt'), 'staged\n');
    data(await registry.call('git_add', { files: ['src/d.txt'] }));

    // Simulate a client that declines the confirmation prompt.
    const res = await registry.call(
      'git_reset',
      { mode: 'mixed' },
      {
        elicitInput: async () => ({ action: 'decline' as const }),
      }
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/cancelled/i);

    // The file must still be staged - the reset never ran.
    const status = data<{ staged: string[] }>(await registry.call('git_status', {}));
    expect(status.staged).toContain('src/d.txt');
  });

  it('proceeds with git_reset when the client accepts (P8)', async () => {
    const { registry } = setup(repo);
    await registry.call('workspace_activate', { path: repo });
    writeFileSync(join(repo, 'src', 'e.txt'), 'staged\n');
    data(await registry.call('git_add', { files: ['src/e.txt'] }));

    const res = await registry.call(
      'git_reset',
      { mode: 'mixed' },
      {
        elicitInput: async () => ({
          action: 'accept' as const,
          content: { confirm: true },
        }),
      }
    );
    expect(res.ok).toBe(true);

    const status = data<{ staged: string[] }>(await registry.call('git_status', {}));
    expect(status.staged).not.toContain('src/e.txt');
  });

  it('cancels git_push when the elicitation client declines (P8)', async () => {
    const { registry } = setup(repo);
    await registry.call('workspace_activate', { path: repo });

    // Give the working repo a bare remote so a real push would otherwise work.
    const remote = mkdtempSync(join(tmpdir(), 'ff-remote-'));
    const bare = simpleGit({ baseDir: remote });
    await bare.init(['--bare']);
    await simpleGit({ baseDir: repo }).addRemote('origin', remote);

    try {
      const res = await registry.call(
        'git_push',
        {},
        { elicitInput: async () => ({ action: 'decline' as const }) }
      );
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/cancelled/i);

      // Nothing was published: the bare remote has no branches yet.
      const remoteBranches = await bare.branch(['-a']);
      expect(remoteBranches.all).toHaveLength(0);
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('proceeds with git_push when the client accepts (P8)', async () => {
    const { registry } = setup(repo);
    await registry.call('workspace_activate', { path: repo });

    const remote = mkdtempSync(join(tmpdir(), 'ff-remote-'));
    const bare = simpleGit({ baseDir: remote });
    await bare.init(['--bare']);
    const local = simpleGit({ baseDir: repo });
    await local.addRemote('origin', remote);
    const current = (await local.branchLocal()).current;

    try {
      const res = await registry.call(
        'git_push',
        { remote: 'origin', branch: current },
        {
          elicitInput: async () => ({
            action: 'accept' as const,
            content: { confirm: true },
          }),
        }
      );
      expect(res.ok).toBe(true);
      expect((res.data as { pushed: boolean }).pushed).toBe(true);

      // The commit is now present on the bare remote.
      const remoteBranches = await bare.branch(['-a']);
      expect(remoteBranches.all).toContain(current);
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('pushes non-interactively when the client lacks elicitation (P8 fallback)', async () => {
    const { registry } = setup(repo);
    await registry.call('workspace_activate', { path: repo });

    const remote = mkdtempSync(join(tmpdir(), 'ff-remote-'));
    const bare = simpleGit({ baseDir: remote });
    await bare.init(['--bare']);
    const local = simpleGit({ baseDir: repo });
    await local.addRemote('origin', remote);
    const current = (await local.branchLocal()).current;

    try {
      // No `elicitInput` supplied -> handler must not block and just push.
      const res = await registry.call('git_push', { remote: 'origin', branch: current });
      expect(res.ok).toBe(true);
      const remoteBranches = await bare.branch(['-a']);
      expect(remoteBranches.all).toContain(current);
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('stashes and restores working-tree changes (push/list/pop)', async () => {
    const { registry } = setup(repo);
    await registry.call('workspace_activate', { path: repo });

    // Dirty a tracked file, then stash it away.
    writeFileSync(join(repo, 'src', 'a.txt'), 'first\nstashed change\n');
    const pushed = data<{ op: string }>(
      await registry.call('git_stash', { op: 'push', message: 'wip' })
    );
    expect(pushed.op).toBe('push');
    expect(data<{ clean: boolean }>(await registry.call('git_status', {})).clean).toBe(true);

    const list = data<{ count: number }>(await registry.call('git_stash', { op: 'list' }));
    expect(list.count).toBe(1);

    data(await registry.call('git_stash', { op: 'pop' }));
    expect(data<{ clean: boolean }>(await registry.call('git_status', {})).clean).toBe(false);
  });

  it('fetches and pulls from a remote (P8 fetch/pull)', async () => {
    const { registry } = setup(repo);
    await registry.call('workspace_activate', { path: repo });

    // Stand up a bare remote, push the current branch, then advance the remote
    // from a second clone so the working repo has something to fetch/pull.
    const remote = mkdtempSync(join(tmpdir(), 'ff-remote-'));
    const bare = simpleGit({ baseDir: remote });
    await bare.init(['--bare']);
    const local = simpleGit({ baseDir: repo });
    await local.addRemote('origin', remote);
    const current = (await local.branchLocal()).current;
    await local.push('origin', current);

    const clone = mkdtempSync(join(tmpdir(), 'ff-clone-'));
    const cg = simpleGit();
    await cg.clone(remote, clone);
    const cloneGit = simpleGit({ baseDir: clone });
    await cloneGit.addConfig('user.email', 't@e.st');
    await cloneGit.addConfig('user.name', 'Tester');
    writeFileSync(join(clone, 'remote-change.txt'), 'from remote\n');
    await cloneGit.add('.');
    await cloneGit.commit('remote commit');
    await cloneGit.push('origin', current);

    try {
      const fetched = data<{ remote: string }>(
        await registry.call('git_fetch', { remote: 'origin' })
      );
      expect(fetched.remote).toBe('origin');

      const pulled = await registry.call(
        'git_pull',
        { remote: 'origin', branch: current },
        { elicitInput: async () => ({ action: 'accept' as const, content: { confirm: true } }) }
      );
      expect(pulled.ok).toBe(true);
      expect(existsSync(join(repo, 'remote-change.txt'))).toBe(true);
    } finally {
      rmSync(remote, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    }
  }, 20_000);

  it('cancels git_pull when the elicitation client declines (P8)', async () => {
    const { registry } = setup(repo);
    await registry.call('workspace_activate', { path: repo });
    const res = await registry.call(
      'git_pull',
      {},
      { elicitInput: async () => ({ action: 'decline' as const }) }
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/cancelled/i);
  });
});
