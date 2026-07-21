import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { buildRegistry } from '../../src/tools/index.js';
import { withExecutionContext } from '../../src/core/principal.js';
import type { ToolPrincipal } from '../../src/core/types.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-capsule-policy-'));
  roots.push(root);
  writeFileSync(join(root, 'README.md'), 'capsule fixture\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'FolderForge Test'], { cwd: root });
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root });
  const config = defaultConfig(root);
  config.capsule.enforcement = 'remote';
  config.rateLimit.enabled = false;
  const container = new Container(config);
  const registry = buildRegistry(container);
  return { root, container, registry };
}

function remote(root: string, id: string, session: string): ToolPrincipal {
  return withExecutionContext(
    { id, role: 'agent', authMode: 'token' },
    root,
    session,
  );
}

describe('Workspace Capsule policy pipeline', () => {
  it('denies missing remote capsules, then permits an exact bound read', async () => {
    const { root, container, registry } = setup();
    const principal = remote(root, 'credential:agent-a', 'session-a');

    const missing = await registry.callAgent('file_read', { path: 'README.md' }, { principal });
    expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/Capsule.*required/) });

    container.capsules.create({
      workspaceRoot: root,
      principalId: principal.id,
      sessionId: principal.sessionId,
      profile: 'develop',
    });
    const allowed = await registry.callAgent('file_read', { path: 'README.md' }, { principal });
    expect(allowed.ok).toBe(true);
    expect(container.audit.recent(20).some((event) => event.detail?.capsuleId)).toBe(true);
  });

  it('blocks observe mutation, session reuse, network escape, and revoked access', async () => {
    const { root, container, registry } = setup();

    const observer = remote(root, 'credential:observer', 'observer-session');
    container.capsules.create({
      workspaceRoot: root,
      principalId: observer.id,
      sessionId: observer.sessionId,
      profile: 'observe',
    });
    const write = await registry.callAgent(
      'file_write',
      { path: 'blocked.txt', content: 'no' },
      { principal: observer },
    );
    expect(write).toMatchObject({ ok: false, error: expect.stringMatching(/Observe/) });

    const reused = await registry.callAgent(
      'file_read',
      { path: 'README.md' },
      { principal: remote(root, observer.id, 'different-session') },
    );
    expect(reused).toMatchObject({ ok: false, error: expect.stringMatching(/binding/) });

    const proposer = remote(root, 'credential:proposer', 'proposer-session');
    container.capsules.create({
      workspaceRoot: root,
      principalId: proposer.id,
      sessionId: proposer.sessionId,
      profile: 'develop',
      networkPolicy: 'none',
    });
    const network = await registry.callAgent(
      'shell_exec',
      { command: 'curl https://example.com' },
      { principal: proposer },
    );
    expect(network).toMatchObject({ ok: false, error: expect.stringMatching(/network|process sandbox/) });

    const developer = remote(root, 'credential:developer', 'developer-session');
    const capsule = container.capsules.create({
      workspaceRoot: root,
      principalId: developer.id,
      sessionId: developer.sessionId,
      profile: 'develop',
    });
    container.capsules.revoke(capsule.id, 'admin:operator');
    const revoked = await registry.callAgent(
      'file_read',
      { path: 'README.md' },
      { principal: developer },
    );
    expect(revoked).toMatchObject({ ok: false, error: expect.stringMatching(/revoked/) });
  });

  it('exposes only the caller-bound capsule through capsule_status', async () => {
    const { root, container, registry } = setup();
    const principal = remote(root, 'credential:agent-a', 'session-a');
    const capsule = container.capsules.create({
      workspaceRoot: root,
      principalId: principal.id,
      sessionId: principal.sessionId,
      profile: 'develop',
      clientCompatibility: 'generic',
    });
    container.capsules.create({
      workspaceRoot: root,
      principalId: 'credential:other',
      profile: 'observe',
    });

    const status = await registry.callAgent('capsule_status', {}, { principal });
    expect(status).toMatchObject({
      ok: true,
      data: {
        total: 2,
        capsule: { id: capsule.id, principalId: principal.id },
      },
    });
  });
  it('enforces an exact managed-worktree boundary for Propose capsules', async () => {
    const { root, container, registry } = setup();
    const isolation = container.isolation.create('capsule-worktree');
    container.workspace.activate(isolation.worktreeRoot);
    const principal = remote(
      isolation.worktreeRoot,
      'credential:propose-agent',
      'propose-session',
    );
    container.capsules.create({
      workspaceRoot: isolation.worktreeRoot,
      principalId: principal.id,
      sessionId: principal.sessionId,
      taskId: isolation.taskId,
      profile: 'propose',
    });

    const write = await registry.callAgent(
      'file_write',
      { path: 'proposal.txt', content: 'isolated\n' },
      { principal },
    );
    expect(write.ok).toBe(true);

    const absoluteEscape = await registry.callAgent(
      'file_read',
      { path: join(root, 'README.md') },
      { principal },
    );
    expect(absoluteEscape).toMatchObject({
      ok: false,
      error: expect.stringMatching(/escapes the capsule workspace/),
    });

    symlinkSync(join(root, 'README.md'), join(isolation.worktreeRoot, 'source-link'));
    const symlinkEscape = await registry.callAgent(
      'file_read',
      { path: 'source-link' },
      { principal },
    );
    expect(symlinkEscape).toMatchObject({
      ok: false,
      error: expect.stringMatching(/escapes the capsule workspace/),
    });

    container.workspace.setCurrent(root);
    const sourcePrincipal = remote(root, 'credential:source-agent', 'source-session');
    container.capsules.create({
      workspaceRoot: root,
      principalId: sourcePrincipal.id,
      sessionId: sourcePrincipal.sessionId,
      profile: 'develop',
    });
    const crossWorktree = await registry.callAgent(
      'file_read',
      { path: join(isolation.worktreeRoot, 'README.md') },
      { principal: sourcePrincipal },
    );
    expect(crossWorktree).toMatchObject({
      ok: false,
      error: expect.stringMatching(/different managed worktree/),
    });

    container.workspace.setCurrent(isolation.worktreeRoot);
    const shell = await registry.callAgent(
      'shell_exec',
      { command: 'cat README.md' },
      { principal },
    );
    expect(shell).toMatchObject({
      ok: false,
      error: expect.stringMatching(/process sandbox/),
    });
  });

});
