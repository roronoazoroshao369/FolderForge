import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkArchitecture,
  findCycles,
  parseStaticImports,
} from '../../scripts/architecture-lib.mjs';

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-architecture-'));
  roots.push(root);
  mkdirSync(join(root, 'src', 'core'), { recursive: true });
  mkdirSync(join(root, 'src', 'tools'), { recursive: true });
  mkdirSync(join(root, 'src', 'runtime'), { recursive: true });
  return root;
}

function file(root: string, path: string, source: string): void {
  const destination = join(root, path);
  mkdirSync(resolve(destination, '..'), { recursive: true });
  writeFileSync(destination, source, 'utf8');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('architecture gate', () => {
  it('distinguishes runtime and type-only imports', () => {
    expect(
      parseStaticImports(
        "import type { A } from './a.js';\nimport { B } from './b.js';\nexport type { C } from './c.js';\n",
      ),
    ).toEqual([
      { kind: 'import', typeOnly: true, specifier: './a.js' },
      { kind: 'import', typeOnly: false, specifier: './b.js' },
      { kind: 'export', typeOnly: true, specifier: './c.js' },
    ]);
  });

  it('finds strongly connected runtime components', () => {
    const graph = new Map<string, Set<string>>([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set(['a'])],
      ['d', new Set()],
    ]);
    expect(findCycles(graph)).toEqual([['a', 'b', 'c']]);
  });

  it('rejects core importing a vertical implementation', () => {
    const root = fixture();
    file(root, 'src/core/index.ts', "import '../tools/registry.js';\n");
    file(root, 'src/tools/registry.ts', 'export const registry = true;\n');
    const report = checkArchitecture(root);
    expect(report.ok).toBe(false);
    expect(report.violations).toEqual([
      expect.objectContaining({ code: 'core_imports_vertical' }),
    ]);
  });

  it('rejects a runtime import cycle', () => {
    const root = fixture();
    file(root, 'src/runtime/a.ts', "import './b.js';\n");
    file(root, 'src/runtime/b.ts', "import './a.js';\n");
    const report = checkArchitecture(root);
    expect(report.ok).toBe(false);
    expect(report.cycles).toEqual([
      ['src/runtime/a.ts', 'src/runtime/b.ts'],
    ]);
  });

  it('accepts the repository architecture', () => {
    const report = checkArchitecture(resolve(import.meta.dirname, '../..'));
    expect(report).toMatchObject({ ok: true, cycles: [], violations: [] });
  });
});
