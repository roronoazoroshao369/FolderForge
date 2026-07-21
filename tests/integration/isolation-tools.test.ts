import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { buildRegistry } from '../../src/tools/index.js';
import { LOOPBACK_DASHBOARD_ADMIN_PRINCIPAL } from '../../src/core/principal.js';

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-isolation-tools-'));
  roots.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'FolderForge Test');
  writeFileSync(join(root, 'file.txt'), 'before\n');
  git(root, 'add', 'file.txt');
  git(root, 'commit', '-m', 'initial');
  const config = defaultConfig(root);
  config.policy.defaultMode = 'danger';
  config.rateLimit.enabled = false;
  const container = new Container(config);
  const registry = buildRegistry(container);
  return { root, container, registry };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('isolation tools', () => {
  it('creates and reviews through the agent plane, but applies only through admin authority', async () => {
    const { root, registry } = setup();
    const created = await registry.callAgent('isolation_create', { taskId: 'tool-task' });
    expect(created.ok).toBe(true);
    const isolation = (created.data as { isolation: { id: string; worktreeRoot: string } }).isolation;
    writeFileSync(join(isolation.worktreeRoot, 'file.txt'), 'after\n');

    const diff = await registry.callAgent('isolation_diff', { id: isolation.id });
    expect(diff).toMatchObject({ ok: true, diff: expect.stringContaining('after') });

    const denied = await registry.callAgent('isolation_apply', { id: isolation.id });
    expect(denied).toMatchObject({ ok: false, error: expect.stringMatching(/Admin-only/) });
    expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('before\n');

    const applied = await registry.call(
      'isolation_apply',
      { id: isolation.id },
      { principal: LOOPBACK_DASHBOARD_ADMIN_PRINCIPAL },
    );
    expect(applied.ok).toBe(true);
    expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('after\n');

    const prematureDiscard = await registry.call(
      'isolation_discard',
      { id: isolation.id },
      { principal: LOOPBACK_DASHBOARD_ADMIN_PRINCIPAL },
    );
    expect(prematureDiscard).toMatchObject({ ok: false, error: expect.stringMatching(/Rollback/) });

    const rolledBack = await registry.call(
      'isolation_rollback',
      { id: isolation.id },
      { principal: LOOPBACK_DASHBOARD_ADMIN_PRINCIPAL },
    );
    expect(rolledBack).toMatchObject({ ok: true, data: { isolation: { state: 'rolled_back' }, clean: true } });
    expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('before\n');

    const discarded = await registry.call(
      'isolation_discard',
      { id: isolation.id },
      { principal: LOOPBACK_DASHBOARD_ADMIN_PRINCIPAL },
    );
    expect(discarded).toMatchObject({ ok: true, data: { isolation: { state: 'discarded' } } });
  });
});
