import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApprovalEngine } from '../../src/policy/approvals.js';

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
});
