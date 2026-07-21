import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface ValidationReport {
  mode: string;
  profiles: Array<{ id: string; package: string; version: string; integrity: string }>;
  summary: { total: number; valid: number; invalid: number };
}

const SCRIPT = resolve('scripts/child-mcp-third-party.mjs');
const MANIFEST = resolve('compatibility/child-mcp-third-party.json');

describe('third-party child MCP compatibility manifest', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'folderforge-third-party-manifest-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts five exact package and integrity pins without network access', () => {
    const executed = spawnSync(process.execPath, [SCRIPT, '--validate-only'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(executed.status).toBe(0);
    const report = JSON.parse(executed.stdout) as ValidationReport;
    expect(report.mode).toBe('validate-only');
    expect(report.summary).toEqual({ total: 5, valid: 5, invalid: 0 });
    expect(report.profiles.map((profile) => profile.id)).toEqual([
      'mcp-everything',
      'mcp-filesystem',
      'mcp-memory',
      'mcp-sequential-thinking',
      'playwright-mcp',
    ]);
    for (const profile of report.profiles) {
      expect(profile.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
      expect(profile.integrity).toMatch(/^sha512-/);
      expect(profile.package).not.toContain('@latest');
    }
  });

  it('supports selecting one profile and writing machine-readable evidence', () => {
    const output = join(root, 'validation.json');
    const executed = spawnSync(
      process.execPath,
      [SCRIPT, '--validate-only', '--profile', 'playwright-mcp', '--output', output],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(executed.status).toBe(0);
    const report = JSON.parse(readFileSync(output, 'utf8')) as ValidationReport;
    expect(report.summary.total).toBe(1);
    expect(report.profiles[0]).toMatchObject({
      id: 'playwright-mcp',
      package: '@playwright/mcp',
      version: '0.0.78',
    });
  });

  it('rejects floating versions and duplicate profile identities', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      profiles: Array<Record<string, unknown>>;
    };
    manifest.profiles[0]!.version = 'latest';
    manifest.profiles[1]!.id = manifest.profiles[0]!.id;
    const invalid = join(root, 'invalid.json');
    writeFileSync(invalid, JSON.stringify(manifest));

    const executed = spawnSync(
      process.execPath,
      [SCRIPT, '--validate-only', '--manifest', invalid],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(executed.status).not.toBe(0);
    expect(executed.stderr).toMatch(/exact pinned version/i);
  });
});
