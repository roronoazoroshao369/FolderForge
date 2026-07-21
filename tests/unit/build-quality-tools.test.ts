import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPackageManager } from '../../src/tools/pkg-tools.js';
import { detectFormatter } from '../../src/tools/format-tools.js';
import {
  detectCoverageCommand,
  parseIstanbulSummary,
  parseCoberturaXml,
} from '../../src/tools/coverage-tools.js';

/**
 * Detection + parsing tests for the v1.2 build/quality tools (Gap 2/3/5).
 * Everything runs against temp fixtures; no package manager is actually
 * invoked, so the suite stays offline and fast.
 */

function tmpProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ff-pkg-'));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('detectPackageManager', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('prefers pnpm lockfile', () => {
    const d = tmpProject({ 'package.json': '{}', 'pnpm-lock.yaml': '' });
    dirs.push(d);
    expect(detectPackageManager(d)).toBe('pnpm');
  });
  it('falls back to npm for a bare package.json', () => {
    const d = tmpProject({ 'package.json': '{}' });
    dirs.push(d);
    expect(detectPackageManager(d)).toBe('npm');
  });
  it('detects cargo and go and pip', () => {
    const c = tmpProject({ 'Cargo.toml': '' });
    const g = tmpProject({ 'go.mod': '' });
    const p = tmpProject({ 'pyproject.toml': '' });
    dirs.push(c, g, p);
    expect(detectPackageManager(c)).toBe('cargo');
    expect(detectPackageManager(g)).toBe('go');
    expect(detectPackageManager(p)).toBe('pip');
  });
  it('returns null when nothing matches', () => {
    const d = tmpProject({ 'README.md': '#' });
    dirs.push(d);
    expect(detectPackageManager(d)).toBeNull();
  });
});

describe('detectFormatter', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('detects prettier from config', () => {
    const d = tmpProject({ '.prettierrc': '{}', 'package.json': '{}' });
    dirs.push(d);
    expect(detectFormatter(d)?.id).toBe('prettier');
  });
  it('detects biome', () => {
    const d = tmpProject({ 'biome.json': '{}' });
    dirs.push(d);
    expect(detectFormatter(d)?.id).toBe('biome');
  });
  it('detects ruff via pyproject', () => {
    const d = tmpProject({ 'pyproject.toml': '' });
    dirs.push(d);
    expect(detectFormatter(d)?.id).toBe('ruff');
  });
  it('returns null with no formatter', () => {
    const d = tmpProject({ 'README.md': '#' });
    dirs.push(d);
    expect(detectFormatter(d)).toBeNull();
  });
  it('check and apply argv differ', () => {
    const d = tmpProject({ '.prettierrc': '{}' });
    dirs.push(d);
    const f = detectFormatter(d)!;
    expect(f.check).toContain('--check');
    expect(f.apply).toContain('--write');
  });
});

describe('coverage detection + parsing', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('picks vitest coverage for a vitest project', () => {
    const d = tmpProject({
      'package.json': JSON.stringify({ devDependencies: { vitest: '^2' } }),
      'tsconfig.json': '{}',
    });
    dirs.push(d);
    const cmd = detectCoverageCommand(d);
    expect(cmd?.argv.join(' ')).toContain('vitest');
    expect(cmd?.report?.kind).toBe('istanbul-json');
  });
  it('picks pytest-cov for python', () => {
    const d = tmpProject({ 'pyproject.toml': '' });
    dirs.push(d);
    expect(detectCoverageCommand(d)?.argv.join(' ')).toContain('pytest');
  });

  it('parses an istanbul json-summary', () => {
    const json = JSON.stringify({
      total: {
        lines: { pct: 91.2 },
        statements: { pct: 90 },
        functions: { pct: 88.5 },
        branches: { pct: 75 },
      },
    });
    expect(parseIstanbulSummary(json)).toEqual({
      lines: 91.2,
      statements: 90,
      functions: 88.5,
      branches: 75,
    });
  });
  it('returns null for malformed istanbul json', () => {
    expect(parseIstanbulSummary('not json')).toBeNull();
    expect(parseIstanbulSummary('{}')).toBeNull();
  });
  it('parses cobertura line-rate', () => {
    const xml = '<coverage line-rate="0.834" branch-rate="0.5"></coverage>';
    expect(parseCoberturaXml(xml)).toEqual({ lines: 83.4, branches: 50 });
  });
});
