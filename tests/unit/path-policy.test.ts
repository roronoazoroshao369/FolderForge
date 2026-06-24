import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PathPolicy } from '../../src/policy/path-policy.js';
import { PathEscapeError } from '../../src/core/errors.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ff-path-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;\n');
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
    expect(() => policy.resolveSafe('../../etc/passwd', root)).toThrow(PathEscapeError);
  });

  it('rejects absolute paths outside the allowed root', () => {
    const policy = new PathPolicy([root], denied);
    expect(() => policy.resolveSafe('/etc/hosts', root)).toThrow(PathEscapeError);
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

  it('rejects symlinks that escape the workspace boundary', () => {
    const outside = mkdtempSync(join(tmpdir(), 'ff-out-'));
    writeFileSync(join(outside, 'target.txt'), 'leak\n');
    const link = join(root, 'escape-link');
    try {
      symlinkSync(join(outside, 'target.txt'), link);
      const policy = new PathPolicy([root], denied);
      expect(() => policy.resolveSafe('escape-link', root)).toThrow(PathEscapeError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
