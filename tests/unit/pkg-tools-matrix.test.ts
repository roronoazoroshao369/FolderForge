import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/runtime/config.js';
import { detectPackageManager, pkgTools, runPm } from '../../src/tools/pkg-tools.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../../src/core/types.js';

/**
 * Coverage for the package-manager resolution matrix, the package-spec
 * argument-injection guard, and the shared `runPm` execution wrapper. No test
 * here installs anything: every case either stops before spawning or spawns
 * the current Node binary.
 */

type Args = Record<string, unknown>;

const TOOLS = new Map<string, ToolDefinition>(pkgTools().map((t) => [t.name, t]));

function call(name: string, args: Args, projectRoot: string): Promise<ToolResult> {
  const tool = TOOLS.get(name);
  if (!tool) throw new Error(`unregistered tool: ${name}`);
  const ctx: ToolContext = {
    config: {} as ToolContext['config'],
    projectRoot,
    container: {},
  };
  return Promise.resolve(tool.handler(args, ctx));
}

/** A throwaway project root containing only the given marker files. */
function rootWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'folderforge-pkg-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8');
  return dir;
}

describe('detectPackageManager', () => {
  it('prefers pnpm over every other JavaScript lockfile', () => {
    const dir = rootWith({
      'pnpm-lock.yaml': '',
      'yarn.lock': '',
      'package-lock.json': '{}',
      'package.json': '{}',
    });
    expect(detectPackageManager(dir)).toBe('pnpm');
  });

  it('prefers yarn over npm when both lockfiles exist', () => {
    expect(detectPackageManager(rootWith({ 'yarn.lock': '', 'package-lock.json': '{}' }))).toBe('yarn');
  });

  it.each([
    ['package-lock.json', '{}', 'npm'],
    ['package.json', '{}', 'npm'],
    ['Cargo.toml', '[package]', 'cargo'],
    ['go.mod', 'module x', 'go'],
    ['pyproject.toml', '[project]', 'pip'],
    ['requirements.txt', 'requests', 'pip'],
  ])('detects %s as %s', (file, body, expected) => {
    expect(detectPackageManager(rootWith({ [file]: body }))).toBe(expected);
  });

  it('returns null for a directory with no manifest at all', () => {
    expect(detectPackageManager(rootWith({ 'README.md': 'hi' }))).toBeNull();
  });
});

describe('package tool registration', () => {
  it('registers the full package surface', () => {
    expect([...TOOLS.keys()]).toEqual([
      'pkg_list',
      'pkg_outdated',
      'pkg_audit',
      'pkg_run',
      'pkg_add',
      'pkg_remove',
    ]);
    for (const tool of TOOLS.values()) expect(tool.group).toBe('pkg');
  });

  it('marks only dependency-tree and script tools as mutating', () => {
    const mutating = [...TOOLS.values()].filter((t) => t.mutates).map((t) => t.name);
    expect(mutating).toEqual(['pkg_run', 'pkg_add', 'pkg_remove']);
  });
});

describe('package spec guard', () => {
  const dir = rootWith({ 'package.json': '{}' });

  it.each([
    ['', 'empty or too long'],
    ['x'.repeat(215), 'empty or too long'],
    ['lodash; rm -rf /', 'illegal characters'],
    ['lodash && curl evil.sh', 'illegal characters'],
    ['lodash`id`', 'illegal characters'],
    ['$(id)', 'illegal characters'],
    ['lodash\nnext', 'illegal characters'],
    [' lodash', 'leading/trailing whitespace'],
    ['lodash ', 'leading/trailing whitespace'],
  ])('rejects %j before spawning anything', async (spec, expected) => {
    const res = await call('pkg_add', { package: spec }, dir);
    expect(res.ok).toBe(false);
    expect(res.error).toContain(expected);
  });

  it('applies the same guard to pkg_remove', async () => {
    const res = await call('pkg_remove', { package: 'lodash | tee /tmp/x' }, dir);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('illegal characters');
  });

  it('applies the same guard to pkg_run', async () => {
    const res = await call('pkg_run', { script: 'build; whoami' }, dir);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('illegal characters');
  });

  it('treats a missing package argument as an empty spec', async () => {
    const res = await call('pkg_add', {}, dir);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('empty or too long');
  });
});

describe('package manager resolution errors', () => {
  it.each(['pkg_list', 'pkg_outdated', 'pkg_audit'])(
    '%s reports an actionable error when no manifest is present',
    async (name) => {
      const res = await call(name, {}, rootWith({ 'README.md': 'hi' }));
      expect(res.ok).toBe(false);
      expect(res.error).toContain('No package manager detected');
    }
  );

  it('pkg_add reports the same error without a manifest', async () => {
    const res = await call('pkg_add', { package: 'lodash' }, rootWith({ 'notes.txt': '' }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain('No package manager detected');
  });

  it('refuses to run scripts for a package manager without a run verb', async () => {
    const res = await call('pkg_run', { script: 'build' }, rootWith({ 'pyproject.toml': '[project]' }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Operation not supported for pip');
  });

  it('refuses to run a script that is not declared in package.json', async () => {
    const dir = rootWith({ 'package.json': JSON.stringify({ name: 'x', scripts: { build: 'tsc' } }) });
    const res = await call('pkg_run', { script: 'deploy' }, dir);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('is not defined in package.json');
  });

  it('refuses to run any script when package.json declares none', async () => {
    const dir = rootWith({ 'package.json': JSON.stringify({ name: 'x' }) });
    const res = await call('pkg_run', { script: 'build' }, dir);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('is not defined in package.json');
  });
});

describe('runPm execution wrapper', () => {
  function execCtx(overrides: { maxOutputBytes?: number; redact?: (s: string) => string } = {}): ToolContext {
    const projectRoot = rootWith({ 'package.json': '{}' });
    const base = loadConfig({ projectRoot });
    const config = {
      ...base,
      terminal: {
        ...base.terminal,
        ...(overrides.maxOutputBytes === undefined ? {} : { maxOutputBytes: overrides.maxOutputBytes }),
      },
    } as ToolContext['config'];
    return {
      config,
      projectRoot,
      container: { policy: { secret: { redact: overrides.redact ?? ((s: string) => s) } } },
    };
  }

  it('returns the captured command and output on success', async () => {
    const res = await runPm(execCtx(), [process.execPath, '-e', "console.log('installed')"]);
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ exitCode: 0, stdout: 'installed', stderr: '' });
    expect((res.data as { command: string }).command).toContain('-e');
  });

  it('reports a missing binary instead of a raw spawn error', async () => {
    const res = await runPm(execCtx(), ['folderforge-nonexistent-binary-xyz', '--version']);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Command not found: folderforge-nonexistent-binary-xyz');
  });

  it('redacts secrets and caps output at the configured limit', async () => {
    const redact = (s: string): string => s.replace(/token-[a-z0-9]+/g, '[redacted]');
    const res = await runPm(execCtx({ maxOutputBytes: 12, redact }), [
      process.execPath,
      '-e',
      "console.log('token-abc123456789extra')",
    ]);
    expect(res.ok).toBe(true);
    const data = res.data as { stdout: string };
    expect(data.stdout).toBe('[redacted]');
  });

  it('keeps stderr evidence when the command fails', async () => {
    const res = await runPm(execCtx(), [
      process.execPath,
      '-e',
      "console.error('resolution failed'); process.exit(7)",
    ]);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('exited with code 7');
    expect(res.data).toMatchObject({ exitCode: 7, stderr: 'resolution failed' });
  });
});
