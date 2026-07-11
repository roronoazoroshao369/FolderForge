import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PatchTransactionManager } from '../../src/managers/patch-transaction-manager.js';

function snapshot(root: string, path: string, before: string, after: string) {
  return {
    path,
    absolutePath: join(root, path),
    existed: true,
    before,
    after,
    diff: `--- ${path}\n+++ ${path}`,
  };
}

describe('PatchTransactionManager', () => {
  let root: string;
  let manager: PatchTransactionManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'folderforge-patch-'));
    manager = new PatchTransactionManager();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('applies and rolls back a multi-file transaction atomically', () => {
    writeFileSync(join(root, 'a.txt'), 'alpha\n');
    writeFileSync(join(root, 'b.txt'), 'beta\n');
    const preview = manager.create(root, [
      snapshot(root, 'a.txt', 'alpha\n', 'ALPHA\n'),
      snapshot(root, 'b.txt', 'beta\n', 'BETA\n'),
    ]);

    expect(preview.state).toBe('previewed');
    expect(manager.apply(preview.id).state).toBe('applied');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('ALPHA\n');
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('BETA\n');

    expect(manager.rollback(preview.id).state).toBe('rolled_back');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('alpha\n');
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('beta\n');
  });

  it('refuses to apply when a file changed after preview', () => {
    writeFileSync(join(root, 'a.txt'), 'before');
    const preview = manager.create(root, [snapshot(root, 'a.txt', 'before', 'after')]);
    writeFileSync(join(root, 'a.txt'), 'newer edit');

    expect(() => manager.apply(preview.id)).toThrow(/conflicts with newer workspace changes/);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('newer edit');
  });

  it('refuses rollback when an applied file has newer edits', () => {
    writeFileSync(join(root, 'a.txt'), 'before');
    const preview = manager.create(root, [snapshot(root, 'a.txt', 'before', 'after')]);
    manager.apply(preview.id);
    writeFileSync(join(root, 'a.txt'), 'post-apply edit');

    expect(() => manager.rollback(preview.id)).toThrow(/conflicts with newer workspace changes/);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('post-apply edit');
  });

  it('removes newly-created files during rollback', () => {
    const path = join(root, 'new.txt');
    const preview = manager.create(root, [
      {
        path: 'new.txt',
        absolutePath: path,
        existed: false,
        before: '',
        after: 'created',
        diff: 'new file',
      },
    ]);
    manager.apply(preview.id);
    expect(readFileSync(path, 'utf8')).toBe('created');
    manager.rollback(preview.id);
    expect(() => readFileSync(path, 'utf8')).toThrow();
  });
});
