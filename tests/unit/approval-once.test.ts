import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ApprovalEngine,
  ApprovalResolutionError,
} from '../../src/policy/approvals.js';
import { SecretPolicy } from '../../src/policy/secret-policy.js';

const REQUESTER = 'principal:agent-a';
const OTHER_REQUESTER = 'principal:agent-b';
const APPROVER = 'principal:admin';

describe('ApprovalEngine principal-bound approvals', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('matches canonical args and is consumed exactly once by the requester', () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-approval-'));
    roots.push(root);
    const path = join(root, 'approvals.jsonl');
    const engine = new ApprovalEngine({ persistPath: path });
    const request = engine.create(
      'file_write',
      { path: 'a.txt', nested: { b: 2, a: 1 } },
      'HIGH',
      'test',
      REQUESTER
    );
    engine.approve(request.id, 'once', APPROVER);

    expect(
      engine.consumeOnce(
        'file_write',
        { nested: { a: 1, b: 2 }, path: 'a.txt' },
        OTHER_REQUESTER
      )
    ).toBe(false);
    expect(
      engine.consumeOnce(
        'file_write',
        { nested: { a: 1, b: 2 }, path: 'a.txt' },
        REQUESTER
      )
    ).toBe(true);
    expect(
      engine.consumeOnce(
        'file_write',
        { path: 'a.txt', nested: { a: 1, b: 2 } },
        REQUESTER
      )
    ).toBe(false);
    expect(engine.get(request.id)?.consumedAt).toBeTypeOf('number');

    const restored = new ApprovalEngine({ persistPath: path });
    expect(
      restored.consumeOnce(
        'file_write',
        { path: 'a.txt', nested: { a: 1, b: 2 } },
        REQUESTER
      )
    ).toBe(false);
  });

  it('rejects self-approval and leaves the request pending', () => {
    const engine = new ApprovalEngine();
    const request = engine.create('file_delete', { path: 'a.txt' }, 'HIGH', 'test', REQUESTER);

    expect(() => engine.approve(request.id, 'once', REQUESTER)).toThrowError(
      ApprovalResolutionError
    );
    expect(engine.get(request.id)?.state).toBe('pending');
  });

  it('expires pending requests and rejects late approval', () => {
    let now = 1_000;
    const engine = new ApprovalEngine({ approvalTtlMs: 100, now: () => now });
    const request = engine.create('file_delete', { path: 'a.txt' }, 'HIGH', 'test', REQUESTER);
    expect(request.expiresAt).toBe(1_100);

    now = 1_101;
    expect(() => engine.approve(request.id, 'once', APPROVER)).toThrowError(/expired/i);
    expect(engine.get(request.id)?.state).toBe('expired');
    expect(engine.pending()).toEqual([]);
  });

  it('persists an approved unconsumed request across restart, but not a session allowance', () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-approval-restart-'));
    roots.push(root);
    const path = join(root, 'approvals.jsonl');
    const engine = new ApprovalEngine({ persistPath: path });
    const once = engine.create(
      'file_delete',
      { path: 'a.txt' },
      'HIGH',
      'test',
      REQUESTER
    );
    engine.approve(once.id, 'once', APPROVER);
    const session = engine.create(
      'file_write',
      { path: 'b.txt' },
      'HIGH',
      'test',
      REQUESTER
    );
    engine.approve(session.id, 'session', APPROVER);

    const restarted = new ApprovalEngine({ persistPath: path });
    expect(restarted.consumeOnce('file_delete', { path: 'a.txt' }, REQUESTER)).toBe(true);
    expect(restarted.isSessionAllowed('file_write', REQUESTER)).toBe(false);
  });

  it('scopes a session allowance to its requester', () => {
    const engine = new ApprovalEngine();
    const request = engine.create('file_write', { path: 'a.txt' }, 'HIGH', 'test', REQUESTER);
    engine.approve(request.id, 'session', APPROVER);

    expect(engine.isSessionAllowed('file_write', REQUESTER)).toBe(true);
    expect(engine.isSessionAllowed('file_write', OTHER_REQUESTER)).toBe(false);
  });

  it('persists only redacted args while retaining exact fingerprint matching', () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-approval-redaction-'));
    roots.push(root);
    const path = join(root, 'approvals.jsonl');
    const secret = new SecretPolicy();
    const engine = new ApprovalEngine({
      persistPath: path,
      sanitizeArgs: (args) => secret.redactValue(args) as Record<string, unknown>,
    });
    const token = ['plain', 'token', 'value'].join('-');
    const password = ['plain', 'password', 'value'].join('-');
    const rawArgs = {
      path: 'safe.txt',
      token,
      nested: { password, keep: 1 },
    };
    const request = engine.create('file_write', rawArgs, 'HIGH', 'test', REQUESTER);
    engine.approve(request.id, 'once', APPROVER);

    const persisted = readFileSync(path, 'utf8');
    expect(persisted).not.toContain(token);
    expect(persisted).not.toContain(password);
    expect(persisted).toContain('[REDACTED]');
    expect(persisted).toContain('sha256:');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);

    const restarted = new ApprovalEngine({
      persistPath: path,
      sanitizeArgs: (args) => secret.redactValue(args) as Record<string, unknown>,
    });
    expect(restarted.consumeOnce('file_write', rawArgs, REQUESTER)).toBe(true);
    expect(
      restarted.consumeOnce('file_write', { ...rawArgs, path: 'other.txt' }, REQUESTER)
    ).toBe(false);
  });
  it('binds approvals to client, project, session, capsule, and task context', () => {
    const engine = new ApprovalEngine();
    const exact = {
      id: REQUESTER,
      role: 'agent' as const,
      oauthClientId: 'client:web-a',
      projectId: 'project:alpha',
      sessionId: 'session:one',
      capsuleId: 'capsule:one',
      taskId: 'task:one',
    };
    const request = engine.create(
      'file_write',
      { path: 'a.txt' },
      'HIGH',
      'test',
      exact,
    );
    expect(request.binding).toEqual({
      principalId: REQUESTER,
      clientId: 'client:web-a',
      projectId: 'project:alpha',
      sessionId: 'session:one',
      capsuleId: 'capsule:one',
      taskId: 'task:one',
    });
    expect(request.requesterKey).toMatch(/^binding:sha256:/);
    engine.approve(request.id, 'once', APPROVER);

    for (const mismatch of [
      { ...exact, oauthClientId: 'client:web-b' },
      { ...exact, projectId: 'project:beta' },
      { ...exact, sessionId: 'session:two' },
      { ...exact, capsuleId: 'capsule:two' },
      { ...exact, taskId: 'task:two' },
    ]) {
      expect(engine.consumeOnce('file_write', { path: 'a.txt' }, mismatch)).toBe(false);
    }
    expect(engine.consumeOnce('file_write', { path: 'a.txt' }, exact)).toBe(true);
  });

  it('keeps self-approval bound to the human principal id even with context', () => {
    const engine = new ApprovalEngine();
    const requester = {
      id: REQUESTER,
      role: 'agent' as const,
      projectId: 'project:alpha',
      sessionId: 'session:one',
    };
    const request = engine.create('file_delete', { path: 'a.txt' }, 'HIGH', 'test', requester);
    expect(() => engine.approve(request.id, 'once', REQUESTER)).toThrowError(
      ApprovalResolutionError,
    );
    expect(engine.get(request.id)?.state).toBe('pending');
  });

});
