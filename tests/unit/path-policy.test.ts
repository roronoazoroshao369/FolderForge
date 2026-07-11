import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PathPolicy } from '../../src/policy/path-policy.js';
import { PathEscapeError } from '../../src/core/errors.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ff path ünicode-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;\n');
  writeFileSync(join(root, 'src', 'space ünicode.ts'), 'export const ü = 1;\n');
  writeFileSync(join(root, '.env'), 'SECRET=1\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('PathPolicy', () => {
  const denied = ['**/.env', '**/.env.*', '**/node_modules/**', '**/*.pem'];

  it('resolves a path inside the workspace', () => {
    const policy = new PathPolicy([root], denied);
    const abs = policy.resolveSafe('src/index.ts', root);
    expect(abs).toBe(resolve(root, 'src/index.ts'));
  });

  it('allows files that do not exist yet (for writes)', () => {
    const policy = new PathPolicy([root], denied);
    const abs = policy.resolveSafe('src/new-file.ts', root);
    expect(abs).toBe(resolve(root, 'src/new-file.ts'));
  });

  it('rejects traversal outside the allowed root', () => {
    const policy = new PathPolicy([root], denied);
    expect(() => policy.resolveSafe(join('..', '..', 'outside.txt'), root)).toThrow(PathEscapeError);
  });

  it('rejects absolute paths outside the allowed root', () => {
    const policy = new PathPolicy([root], denied);
    const outside = resolve(dirname(root), 'outside.txt');
    expect(() => policy.resolveSafe(outside, root)).toThrow(PathEscapeError);
  });

  it('preserves spaces and Unicode inside the workspace', () => {
    const policy = new PathPolicy([root], denied);
    expect(policy.resolveSafe(join('src', 'space ünicode.ts'), root)).toBe(
      resolve(root, 'src', 'space ünicode.ts')
    );
  });

  it('blocks denied globs (.env)', () => {
    const policy = new PathPolicy([root], denied);
    expect(() => policy.resolveSafe('.env', root)).toThrow(PathEscapeError);
  });

  it('detects denial via isDenied without throwing', () => {
    const policy = new PathPolicy([root], denied);
    expect(policy.isDenied(resolve(root, '.env'), root)).toBe(true);
    expect(policy.isDenied(resolve(root, 'src/index.ts'), root)).toBe(false);
  });

  it('reports isInsideAllowed correctly', () => {
    const policy = new PathPolicy([root], denied);
    expect(policy.isInsideAllowed(resolve(root, 'src/index.ts'))).toBe(true);
    expect(policy.isInsideAllowed(resolve(root, '..', 'outside.ts'))).toBe(false);
  });

  it('accepts an allowed root reached through a filesystem alias', () => {
    const target = mkdtempSync(join(tmpdir(), 'ff canonical target-'));
    const alias = join(dirname(target), `${target.split(/[\\/]/).at(-1)}-alias`);
    try {
      mkdirSync(join(target, 'src'), { recursive: true });
      writeFileSync(join(target, 'src', 'alias.txt'), 'ok\n');
      symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const policy = new PathPolicy([alias], denied);
      expect(policy.resolveSafe(join('src', 'alias.txt'), alias)).toBe(
        resolve(alias, 'src', 'alias.txt')
      );
      expect(policy.resolveSafe(join('src', 'new.txt'), alias)).toBe(resolve(alias, 'src', 'new.txt'));
    } finally {
      rmSync(alias, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('rejects symlink or Windows junction escapes from the workspace boundary', () => {
    const outside = mkdtempSync(join(tmpdir(), 'ff outside ü-'));
    writeFileSync(join(outside, 'target.txt'), 'leak\n');
    const link = join(root, 'escape-link');
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      const policy = new PathPolicy([root], denied);
      expect(() => policy.resolveSafe(join('escape-link', 'target.txt'), root)).toThrow(PathEscapeError);
    } finally {
      rmSync(link, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
