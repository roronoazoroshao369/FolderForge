import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApprovalEngine } from '../../src/policy/approvals.js';
import { SecretPolicy } from '../../src/policy/secret-policy.js';

describe('ApprovalEngine one-shot approvals', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('matches canonical args and is consumed exactly once', () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-approval-'));
    roots.push(root);
    const path = join(root, 'approvals.jsonl');
    const engine = new ApprovalEngine({ persistPath: path });
    const request = engine.create('file_write', { path: 'a.txt', nested: { b: 2, a: 1 } }, 'HIGH', 'test');
    engine.approve(request.id, 'once');

    expect(engine.consumeOnce('file_write', { nested: { a: 1, b: 2 }, path: 'a.txt' })).toBe(true);
    expect(engine.consumeOnce('file_write', { path: 'a.txt', nested: { a: 1, b: 2 } })).toBe(false);
    expect(engine.get(request.id)?.consumedAt).toBeTypeOf('number');

    const restored = new ApprovalEngine({ persistPath: path });
    expect(restored.consumeOnce('file_write', { path: 'a.txt', nested: { a: 1, b: 2 } })).toBe(false);
  });

  it('persists an approved unconsumed request across restart, but not a session allowance', () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-approval-restart-'));
    roots.push(root);
    const path = join(root, 'approvals.jsonl');
    const engine = new ApprovalEngine({ persistPath: path });
    const once = engine.create('file_delete', { path: 'a.txt' }, 'HIGH', 'test');
    engine.approve(once.id, 'once');
    const session = engine.create('file_write', { path: 'b.txt' }, 'HIGH', 'test');
    engine.approve(session.id, 'session');

    const restarted = new ApprovalEngine({ persistPath: path });
    expect(restarted.consumeOnce('file_delete', { path: 'a.txt' })).toBe(true);
    expect(restarted.isSessionAllowed('file_write')).toBe(false);
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
    const rawArgs = {
      path: 'safe.txt',
      token: 'plain-token-value',
      nested: { password: 'plain-password-value', keep: 1 },
    };
    const request = engine.create('file_write', rawArgs, 'HIGH', 'test');
    engine.approve(request.id, 'once');

    const persisted = readFileSync(path, 'utf8');
    expect(persisted).not.toContain('plain-token-value');
    expect(persisted).not.toContain('plain-password-value');
    expect(persisted).toContain('[REDACTED]');
    expect(persisted).toContain('sha256:');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);

    const restarted = new ApprovalEngine({
      persistPath: path,
      sanitizeArgs: (args) => secret.redactValue(args) as Record<string, unknown>,
    });
    expect(restarted.consumeOnce('file_write', rawArgs)).toBe(true);
    expect(restarted.consumeOnce('file_write', { ...rawArgs, path: 'other.txt' })).toBe(false);
  });
});
