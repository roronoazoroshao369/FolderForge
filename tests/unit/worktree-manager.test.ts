import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorktreeManager } from '../../src/isolation/worktree-manager.js';

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-worktree-'));
  roots.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'FolderForge Test');
  // Fixture bytes must not depend on the host Git installation's EOL policy.
  git(root, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(root, 'tracked.txt'), 'original\n');
  git(root, 'add', 'tracked.txt');
  git(root, 'commit', '-m', 'initial');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('WorktreeManager', () => {
  it('reports an explicit base comparison and clean HEAD-relative state for a fresh task', () => {
    const root = repository();
    const manager = new WorktreeManager([root], root);
    const isolation = manager.create('status-fresh');
    expect(manager.status(isolation.id)).toMatchObject({
      clean: true, changed: [], untracked: [], conflicts: [],
      comparison: { target: 'worktree', baseCommit: isolation.baseCommit },
      workingTree: {
        headCommit: isolation.baseCommit, clean: true,
        staged: [], unstaged: [], untracked: [], conflicts: [],
      },
    });
  });

  it('keeps committed task delta distinct from dirty state even after merge into source', () => {
    const root = repository();
    const manager = new WorktreeManager([root], root);
    const isolation = manager.create('status-committed');
    writeFileSync(join(isolation.worktreeRoot, 'tracked.txt'), 'committed task\n');
    git(isolation.worktreeRoot, 'add', 'tracked.txt');
    git(isolation.worktreeRoot, 'commit', '-m', 'task change');
    const head = git(isolation.worktreeRoot, 'rev-parse', 'HEAD').trim();
    const indexPath = git(isolation.worktreeRoot, 'rev-parse', '--git-path', 'index').trim();
    const indexBefore = readFileSync(indexPath);
    const statePath = join(root, '.git', 'folderforge', 'isolations.json');
    const stateBefore = readFileSync(statePath);
    const expected = {
      clean: false, changed: ['tracked.txt'],
      comparison: { target: 'worktree', baseCommit: isolation.baseCommit },
      workingTree: { headCommit: head, clean: true, staged: [], unstaged: [], untracked: [], conflicts: [] },
    };
    expect(manager.status(isolation.id)).toMatchObject(expected);
    git(root, 'merge', '--ff-only', isolation.branch);
    expect(manager.status(isolation.id)).toMatchObject(expected);
    expect(manager.get(isolation.id)?.state).toBe('active');
    expect(readFileSync(indexPath)).toEqual(indexBefore);
    expect(readFileSync(statePath)).toEqual(stateBefore);
  });

  it('detects cancelling staged and unstaged changes even when the net HEAD diff is empty', () => {
    const root = repository();
    const manager = new WorktreeManager([root], root);
    const isolation = manager.create('status-cancelling');
    writeFileSync(join(isolation.worktreeRoot, 'tracked.txt'), 'staged content\n');
    git(isolation.worktreeRoot, 'add', 'tracked.txt');
    writeFileSync(join(isolation.worktreeRoot, 'tracked.txt'), 'original\n');
    expect(git(isolation.worktreeRoot, 'diff', 'HEAD', '--')).toBe('');
    expect(manager.status(isolation.id)).toMatchObject({
      clean: true, changed: [],
      workingTree: { clean: false, staged: ['tracked.txt'], unstaged: ['tracked.txt'], untracked: [], conflicts: [] },
    });
  });

  it('reports unstaged, untracked, renamed and deleted paths without losing spaces or Unicode', () => {
    const root = repository();
    const manager = new WorktreeManager([root], root);
    const isolation = manager.create('status-paths');
    writeFileSync(join(isolation.worktreeRoot, 'tracked.txt'), 'unstaged\n');
    writeFileSync(join(isolation.worktreeRoot, 'ghi chú.txt'), 'untracked\n');
    expect(manager.status(isolation.id).workingTree).toMatchObject({
      clean: false, staged: [], unstaged: ['tracked.txt'], untracked: ['ghi chú.txt'], conflicts: [],
    });
    writeFileSync(join(isolation.worktreeRoot, 'tracked.txt'), 'original\n');
    git(isolation.worktreeRoot, 'mv', 'tracked.txt', 'renamed file.txt');
    const renamed = manager.status(isolation.id).workingTree;
    expect(renamed.staged).toContain('renamed file.txt');
    rmSync(join(isolation.worktreeRoot, 'renamed file.txt'));
    expect(manager.status(isolation.id).workingTree.unstaged).toContain('renamed file.txt');
  });

  it('reports real unresolved merge conflicts instead of treating the worktree as clean', () => {
    const root = repository();
    const manager = new WorktreeManager([root], root);
    const isolation = manager.create('status-conflict');
    writeFileSync(join(isolation.worktreeRoot, 'tracked.txt'), 'task side\n');
    git(isolation.worktreeRoot, 'add', 'tracked.txt');
    git(isolation.worktreeRoot, 'commit', '-m', 'task side');
    writeFileSync(join(root, 'tracked.txt'), 'source side\n');
    git(root, 'add', 'tracked.txt');
    git(root, 'commit', '-m', 'source side');
    expect(() => git(isolation.worktreeRoot, 'merge', 'main')).toThrow();
    expect(manager.status(isolation.id)).toMatchObject({
      clean: false, conflicts: ['tracked.txt'],
      workingTree: { clean: false, conflicts: ['tracked.txt'] },
    });
  });

  it('labels source snapshots returned after apply and rollback without changing legacy semantics', () => {
    const root = repository();
    const manager = new WorktreeManager([root], root);
    const isolation = manager.create('status-source');
    writeFileSync(join(isolation.worktreeRoot, 'tracked.txt'), 'task change\n');
    expect(manager.apply(isolation.id)).toMatchObject({
      clean: false, changed: ['tracked.txt'],
      comparison: { target: 'source', baseCommit: isolation.sourceHead },
      workingTree: { headCommit: isolation.sourceHead, clean: false, staged: [], unstaged: ['tracked.txt'], untracked: [], conflicts: [] },
    });
    expect(manager.rollback(isolation.id)).toMatchObject({
      clean: true,
      comparison: { target: 'source', baseCommit: isolation.sourceHead },
      workingTree: { headCommit: isolation.sourceHead, clean: true, staged: [], unstaged: [], untracked: [], conflicts: [] },
    });
  });

  it('creates an isolated branch without touching a dirty source workspace', () => {
    const root = repository();
    writeFileSync(join(root, 'tracked.txt'), 'user work\n');
    const manager = new WorktreeManager([root], root);
    const isolation = manager.create('task-dirty');

    expect(isolation.sourceDirty).toBe(true);
    expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('user work\n');
    expect(readFileSync(join(isolation.worktreeRoot, 'tracked.txt'), 'utf8')).toBe('original\n');
    expect(git(root, 'status', '--short')).toContain('tracked.txt');

    writeFileSync(join(isolation.worktreeRoot, 'tracked.txt'), 'agent work\n');
    expect(() => manager.apply(isolation.id)).toThrow(/dirty at creation/);
  });

  it('applies, rolls back tracked and bounded untracked changes, then discards cleanly', () => {
    const root = repository();
    const manager = new WorktreeManager([root], root);
    const isolation = manager.create('task-apply');
    writeFileSync(join(isolation.worktreeRoot, 'tracked.txt'), 'changed\n');
    writeFileSync(join(isolation.worktreeRoot, 'new.txt'), 'new file\n');

    const review = manager.diff(isolation.id);
    expect(review.diff).toContain('changed');
    expect(review.untracked).toEqual(['new.txt']);

    const applied = manager.apply(isolation.id);
    expect(applied.isolation.state).toBe('applied');
    expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('changed\n');
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('new file\n');

    expect(() => manager.discard(isolation.id)).toThrow(/Rollback applied isolation/);
    const rolledBack = manager.rollback(isolation.id);
    expect(rolledBack.isolation.state).toBe('rolled_back');
    expect(rolledBack.clean).toBe(true);
    expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('original\n');
    expect(existsSync(join(root, 'new.txt'))).toBe(false);

    const discarded = manager.discard(isolation.id);
    expect(discarded.state).toBe('discarded');
    expect(existsSync(isolation.worktreeRoot)).toBe(false);
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain(isolation.worktreeRoot);
    expect(() => git(root, 'show-ref', '--verify', `refs/heads/${isolation.branch}`)).toThrow();
  });

  it('refuses apply after source drift and rejects untracked symlinks', () => {
    const root = repository();
    const manager = new WorktreeManager([root], root);
    const drift = manager.create('task-drift');
    writeFileSync(join(drift.worktreeRoot, 'tracked.txt'), 'task change\n');
    writeFileSync(join(root, 'tracked.txt'), 'new user change\n');
    expect(() => manager.apply(drift.id)).toThrow(/changed after isolation creation/);

    writeFileSync(join(root, 'tracked.txt'), 'original\n');
    const clean = sourceClean(root);
    expect(clean).toBe(true);
    const outside = mkdtempSync(join(tmpdir(), 'folderforge-worktree-link-target-'));
    roots.push(outside);
    const outsideFile = join(outside, 'outside.txt');
    writeFileSync(outsideFile, 'outside\n');

    const symlink = manager.create('task-symlink');
    symlinkSync(outsideFile, join(symlink.worktreeRoot, 'escape-link'), 'file');
    expect(() => manager.apply(symlink.id)).toThrow(/regular file|outside managed root/);

    const trackedSymlink = manager.create('task-tracked-symlink');
    symlinkSync(outsideFile, join(trackedSymlink.worktreeRoot, 'tracked-link'), 'file');
    git(trackedSymlink.worktreeRoot, 'add', 'tracked-link');
    expect(() => manager.apply(trackedSymlink.id)).toThrow(
      /regular file or deletion|outside managed root/
    );
  });

  it('persists managed identity and rejects traversal-like task identifiers', () => {
    const root = repository();
    const first = new WorktreeManager([root], root);
    expect(() => first.create('../escape')).toThrow(/taskId/);
    const isolation = first.create('task-reload');

    const second = new WorktreeManager([root], root);
    expect(second.isManagedRoot(isolation.worktreeRoot)).toBe(true);
    expect(second.get(isolation.id)).toMatchObject({ id: isolation.id, state: 'active' });
  });

  it('reports an unavailable fallback instead of crashing for a non-Git folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-no-git-'));
    roots.push(root);
    const manager = new WorktreeManager([root], root);
    expect(manager.describe()).toMatchObject({ available: false, total: 0, active: 0 });
    expect(() => manager.create('task')).toThrow(/Git command failed/);
  });
  it('fails closed when persisted isolation state is corrupted', () => {
    const root = repository();
    const manager = new WorktreeManager([root], root);
    manager.create('task-integrity');
    const statePath = join(root, '.git', 'folderforge', 'isolations.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      isolations: Array<{ taskId: string }>;
      digest: string;
    };
    state.isolations[0]!.taskId = 'tampered-task';
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);
    expect(() => new WorktreeManager([root], root)).toThrow(/integrity/);
  });

  it('refuses rollback after post-apply user drift and preserves the recovery worktree', () => {
    const root = repository();
    const manager = new WorktreeManager([root], root);
    const isolation = manager.create('task-rollback-drift');
    writeFileSync(join(isolation.worktreeRoot, 'tracked.txt'), 'task change\n');
    manager.apply(isolation.id);
    writeFileSync(join(root, 'tracked.txt'), 'user changed after apply\n');

    expect(() => manager.rollback(isolation.id)).toThrow(/changed after isolation apply/);
    expect(manager.get(isolation.id)).toMatchObject({ state: 'applied' });
    expect(existsSync(isolation.worktreeRoot)).toBe(true);
  });

  it('recovers an uncertain applying journal after restart without replaying apply', () => {
    const root = repository();
    const manager = new WorktreeManager([root], root);
    const isolation = manager.create('task-uncertain');
    writeFileSync(join(isolation.worktreeRoot, 'tracked.txt'), 'uncertain change\n');
    manager.apply(isolation.id);

    const statePath = join(root, '.git', 'folderforge', 'isolations.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      isolations: Array<Record<string, unknown>>;
      digest: string;
    };
    const record = state.isolations[0]!;
    record.state = 'applying';
    delete record.appliedAt;
    delete record.appliedSourceFingerprint;
    state.digest = `sha256:${createHash('sha256')
      .update(JSON.stringify(state.isolations))
      .digest('hex')}`;
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

    const restarted = new WorktreeManager([root], root);
    expect(restarted.get(isolation.id)).toMatchObject({ state: 'applying' });
    const rolledBack = restarted.rollback(isolation.id);
    expect(rolledBack).toMatchObject({ clean: true, isolation: { state: 'rolled_back' } });
    expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('original\n');
  });

  it('rejects a tampered rollback patch without touching applied source changes', () => {
    const root = repository();
    const manager = new WorktreeManager([root], root);
    const isolation = manager.create('task-patch-integrity');
    writeFileSync(join(isolation.worktreeRoot, 'tracked.txt'), 'applied change\n');
    manager.apply(isolation.id);
    const patchPath = join(root, '.git', 'folderforge', 'rollbacks', `${isolation.id}.patch`);
    writeFileSync(patchPath, 'tampered patch\n');

    expect(() => manager.rollback(isolation.id)).toThrow(/patch integrity/);
    expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('applied change\n');
    expect(manager.get(isolation.id)).toMatchObject({ state: 'applied' });
  });

  it(
    'revalidates an untracked target after preflight and blocks a symlink or junction swap',
    () => {
      const root = repository();
      const outside = mkdtempSync(join(tmpdir(), 'folderforge-worktree-outside-'));
      roots.push(outside);
      let swapped = false;
      const manager = new WorktreeManager([root], root, {
        beforeUntrackedCopy: ({ target }) => {
          if (swapped) return;
          swapped = true;
          const parent = join(root, 'nested');
          expect(target).toBe(join(parent, 'new.txt'));
          symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
        },
      });
      const isolation = manager.create('task-target-swap');
      mkdirSync(join(isolation.worktreeRoot, 'nested'));
      writeFileSync(join(isolation.worktreeRoot, 'nested', 'new.txt'), 'must stay inside\n');

      expect(() => manager.apply(isolation.id)).toThrow(/resolves outside managed root/);
      expect(existsSync(join(outside, 'new.txt'))).toBe(false);
      expect(manager.get(isolation.id)).toMatchObject({ state: 'active' });
    }
  );

});

function sourceClean(root: string): boolean {
  git(root, 'checkout', '--', 'tracked.txt');
  return git(root, 'status', '--porcelain').trim() === '';
}
