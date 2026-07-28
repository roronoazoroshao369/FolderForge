import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { buildRegistry } from '../../src/tools/index.js';
import type { ToolResult } from '../../src/core/types.js';

function setup(projectRoot: string) {
  const config = loadConfig({ projectRoot });
  config.policy.defaultMode = 'dev';
  const container = new Container(config);
  container.policy.setMode('dev');
  return buildRegistry(container);
}

function data<T>(result: ToolResult): T {
  expect(result.ok).toBe(true);
  return result.data as T;
}

describe('search tool workspace boundary', () => {
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ff-search-workspace-'));
    outside = mkdtempSync(join(tmpdir(), 'ff-search-outside-'));
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'local.ts'), 'export const LOCAL_MARKER = true;\n');
    writeFileSync(
      join(outside, 'outside.ts'),
      'export const OUTSIDE_ESCAPE_MARKER = true;\n'
    );
    symlinkSync(
      outside,
      join(workspace, 'linked-outside'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('does not enumerate or read files through nested symlinks', async () => {
    const registry = setup(workspace);
    await registry.call('workspace_activate', { path: workspace });

    const files = data<{ matches: string[] }>(
      await registry.call('search_files', { glob: '**/*.ts' })
    );
    expect(files.matches).toContain('src/local.ts');
    expect(files.matches).not.toContain('linked-outside/outside.ts');

    const text = data<{ count: number }>(
      await registry.call('search_text', {
        query: 'OUTSIDE_ESCAPE_MARKER',
        glob: '**/*.ts',
      })
    );
    expect(text.count).toBe(0);

    const ast = data<{ count: number }>(
      await registry.call('search_ast', {
        name: 'OUTSIDE_ESCAPE_MARKER',
        kind: 'const',
        glob: '**/*.ts',
      })
    );
    expect(ast.count).toBe(0);

    const context = data<{ results: Array<{ path: string; snippets: string[] }> }>(
      await registry.call('code_context', {
        query: 'OUTSIDE_ESCAPE_MARKER',
        glob: '**/*.ts',
      })
    );
    expect(context.results.every((entry) => !entry.path.startsWith('linked-outside/'))).toBe(true);
    expect(JSON.stringify(context.results)).not.toContain('OUTSIDE_ESCAPE_MARKER');
  });

  it.skipIf(process.platform === 'win32')(
    'ignores symlinked project manifests and verification scripts',
    async () => {
      writeFileSync(
        join(outside, 'package.json'),
        JSON.stringify({
          name: 'outside-injected-project',
          scripts: { test: 'node outside-payload.js' },
        })
      );
      symlinkSync(join(outside, 'package.json'), join(workspace, 'package.json'), 'file');
      const registry = setup(workspace);
      await registry.call('workspace_activate', { path: workspace });

      const analysis = data<{
        name: string;
        commands: { packageManager: string | null; scripts: Record<string, string> };
        manifests: string[];
      }>(await registry.call('project_analyze', {}));
      expect(analysis.name).not.toBe('outside-injected-project');
      expect(analysis.commands).toEqual({ packageManager: null, scripts: {} });
      expect(analysis.manifests).not.toContain('package.json');

      const verification = data<{
        packageManager: string | null;
        plan: Array<{ check: string; command: string | null; status: string }>;
      }>(
        await registry.call('project_verify', {
          action: 'plan',
          checks: ['test'],
        })
      );
      expect(verification.packageManager).toBeNull();
      expect(verification.plan).toContainEqual({
        check: 'test',
        command: null,
        status: 'unavailable',
      });
    }
  );
});
