import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceCapsuleManager } from '../../src/capsule/workspace-capsule-manager.js';
import { projectPrincipalId } from '../../src/core/principal.js';
import type { ToolPrincipal } from '../../src/core/types.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'folderforge-capsule-'));
  roots.push(value);
  return value;
}

function manager(projectRoot: string, enforcement: 'optional' | 'remote' | 'all' = 'optional') {
  return new WorkspaceCapsuleManager(
    [projectRoot],
    enforcement,
    60_000,
    3_600_000,
    projectRoot,
  );
}

function principal(projectRoot: string, overrides: Partial<ToolPrincipal> = {}): ToolPrincipal {
  return {
    id: 'principal:agent-a',
    role: 'agent',
    authMode: 'token',
    projectId: projectPrincipalId(projectRoot),
    sessionId: 'session:a',
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('WorkspaceCapsuleManager', () => {
  it('persists an exact workspace/principal/session binding and reloads it', () => {
    const projectRoot = root();
    const first = manager(projectRoot);
    const capsule = first.create({
      workspaceRoot: projectRoot,
      principalId: 'principal:agent-a',
      sessionId: 'session:a',
      profile: 'develop',
      clientCompatibility: 'chatgpt',
    });

    const allowed = first.check(principal(projectRoot), projectRoot, {
      name: 'file_read',
      risk: 'LOW',
      mutates: false,
      args: { path: 'README.md' },
    });
    expect(allowed).toMatchObject({ kind: 'allow', capsule: { id: capsule.id } });

    const reloaded = manager(projectRoot);
    expect(reloaded.get(capsule.id)).toMatchObject({
      id: capsule.id,
      workspaceRoot: projectRoot,
      profile: 'develop',
      clientCompatibility: 'chatgpt',
    });
  });

  it('fails closed for session mismatch, expiry, and revocation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T00:00:00.000Z'));
    const projectRoot = root();
    const capsules = manager(projectRoot);
    const capsule = capsules.create({
      workspaceRoot: projectRoot,
      principalId: 'principal:agent-a',
      sessionId: 'session:a',
      profile: 'develop',
      ttlMs: 1_000,
    });

    expect(
      capsules.check(principal(projectRoot, { sessionId: 'session:b' }), projectRoot, {
        name: 'file_read',
        risk: 'LOW',
        mutates: false,
        args: {},
      }),
    ).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/binding/) });

    vi.advanceTimersByTime(1_001);
    expect(
      capsules.check(principal(projectRoot), projectRoot, {
        name: 'file_read',
        risk: 'LOW',
        mutates: false,
        args: {},
      }),
    ).toMatchObject({ kind: 'deny', capsule: { id: capsule.id }, reason: expect.stringMatching(/expired/) });

    vi.setSystemTime(new Date('2026-07-21T00:00:00.000Z'));
    const active = capsules.create({
      workspaceRoot: projectRoot,
      principalId: 'principal:agent-b',
      profile: 'develop',
    });
    capsules.revoke(active.id, 'admin:operator');
    expect(
      capsules.check(principal(projectRoot, { id: 'principal:agent-b' }), projectRoot, {
        name: 'file_read',
        risk: 'LOW',
        mutates: false,
        args: {},
      }),
    ).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/revoked/) });
  });

  it('enforces permission profiles, network policy, and hard autonomous exclusions', () => {
    const projectRoot = root();
    const capsules = manager(projectRoot);
    capsules.create({
      workspaceRoot: projectRoot,
      principalId: 'principal:observe',
      profile: 'observe',
    });
    expect(
      capsules.check(principal(projectRoot, { id: 'principal:observe' }), projectRoot, {
        name: 'file_write',
        risk: 'MEDIUM',
        mutates: true,
        args: { path: 'a.txt' },
      }),
    ).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/Observe/) });

    capsules.create({
      workspaceRoot: projectRoot,
      principalId: 'principal:propose',
      profile: 'develop',
      networkPolicy: 'none',
    });
    expect(
      capsules.check(principal(projectRoot, { id: 'principal:propose' }), projectRoot, {
        name: 'shell_exec',
        risk: 'MEDIUM',
        mutates: true,
        args: { command: 'curl https://example.com' },
      }),
    ).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/network|process sandbox/) });

    capsules.create({
      workspaceRoot: projectRoot,
      principalId: 'principal:develop',
      profile: 'develop',
    });
    expect(
      capsules.check(principal(projectRoot, { id: 'principal:develop' }), projectRoot, {
        name: 'git_push',
        risk: 'CRITICAL',
        mutates: true,
        args: {},
      }),
    ).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/outside/) });
  });

  it('requires a capsule for authenticated remote callers and enforces atomic budgets', () => {
    const projectRoot = root();
    const capsules = manager(projectRoot, 'remote');
    const agent = principal(projectRoot);
    expect(
      capsules.check(agent, projectRoot, {
        name: 'file_read',
        risk: 'LOW',
        mutates: false,
        args: {},
      }),
    ).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/required/) });

    const capsule = capsules.create({
      workspaceRoot: projectRoot,
      principalId: agent.id,
      sessionId: agent.sessionId,
      profile: 'develop',
      limits: { maxCalls: 1 },
    });
    expect(
      capsules.check(agent, projectRoot, {
        name: 'file_read',
        risk: 'LOW',
        mutates: false,
        args: {},
      }).kind,
    ).toBe('allow');
    capsules.reserve(capsule.id, false);
    expect(
      capsules.check(agent, projectRoot, {
        name: 'file_read',
        risk: 'LOW',
        mutates: false,
        args: {},
      }),
    ).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/budget/) });
  });

  it('rejects boundary escapes and invalid runtime enum values', () => {
    const projectRoot = root();
    const capsules = manager(projectRoot);
    expect(() =>
      capsules.create({
        workspaceRoot: projectRoot,
        principalId: 'principal:a',
        profile: 'develop',
        evidenceDestination: '../outside',
      }),
    ).toThrow(/inside the workspace/);
    expect(() =>
      capsules.create({
        workspaceRoot: projectRoot,
        principalId: 'principal:a',
        profile: 'develop',
        networkPolicy: 'open' as never,
      }),
    ).toThrow(/network policy/);
  });
  it('enforces granted tool/group scopes and denies all unsandboxed command tools', () => {
    const projectRoot = root();
    const capsules = manager(projectRoot);
    capsules.create({
      workspaceRoot: projectRoot,
      principalId: 'principal:scoped',
      profile: 'develop',
      grantedScopes: ['tools:read', 'tool:file_write'],
    });
    const scoped = principal(projectRoot, { id: 'principal:scoped' });

    expect(
      capsules.check(scoped, projectRoot, {
        name: 'file_read',
        group: 'files',
        risk: 'LOW',
        mutates: false,
        args: { path: 'README.md' },
      }).kind,
    ).toBe('allow');
    expect(
      capsules.check(scoped, projectRoot, {
        name: 'file_write',
        group: 'files',
        risk: 'MEDIUM',
        mutates: true,
        args: { path: 'README.md' },
      }).kind,
    ).toBe('allow');
    expect(
      capsules.check(scoped, projectRoot, {
        name: 'git_commit',
        group: 'git',
        risk: 'HIGH',
        mutates: true,
        args: {},
      }),
    ).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/scope/) });
    expect(
      capsules.check(scoped, projectRoot, {
        name: 'shell_exec',
        group: 'terminal',
        risk: 'MEDIUM',
        mutates: true,
        args: { command: 'pwd' },
      }),
    ).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/scope|sandbox/) });

    capsules.create({
      workspaceRoot: projectRoot,
      principalId: 'principal:command',
      profile: 'develop',
      grantedScopes: ['group:terminal'],
    });
    expect(
      capsules.check(principal(projectRoot, { id: 'principal:command' }), projectRoot, {
        name: 'shell_exec',
        group: 'terminal',
        risk: 'MEDIUM',
        mutates: true,
        args: { command: 'pwd' },
      }),
    ).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/process sandbox/) });
  });

  it('fails closed when persisted capsule state is corrupted or schema-tampered', () => {
    const projectRoot = root();
    const capsules = manager(projectRoot);
    capsules.create({
      workspaceRoot: projectRoot,
      principalId: 'principal:integrity',
      profile: 'develop',
    });
    const statePath = join(projectRoot, '.folderforge', 'capsules.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      capsules: Array<{ principalId: string }>;
      digest: string;
    };
    state.capsules[0]!.principalId = 'principal:tampered';
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);
    expect(() => manager(projectRoot)).toThrow(/integrity/);
  });

});
