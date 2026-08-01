import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { buildRegistry } from '../../src/tools/index.js';
import type { ToolResult } from '../../src/core/types.js';
import { TS_FIXTURE, PY_FIXTURE, isolatedFixture } from './fixtures.js';

/** Build a container + registry rooted at a fixture project, in a given mode. */
function setup(sourceFixture: string, mode: 'readonly' | 'safe' | 'dev' | 'danger' = 'dev') {
  // Activating a workspace writes runtime state (audit chain, approvals) into
  // the project root, so each test works on a throwaway copy of the fixture.
  const projectRoot = isolatedFixture(sourceFixture);
  const config = loadConfig({ projectRoot });
  config.policy.defaultMode = mode;
  const container = new Container(config);
  container.policy.setMode(mode);
  const registry = buildRegistry(container);
  return { container, registry, projectRoot };
}

function data<T = Record<string, unknown>>(res: ToolResult): T {
  expect(res.ok).toBe(true);
  return res.data as T;
}

describe('tool registry pipeline against fixtures', () => {
  it('activates the TypeScript fixture and detects the language', async () => {
    const { registry, projectRoot } = setup(TS_FIXTURE);
    await registry.call('workspace_activate', { path: projectRoot });
    const status = data<{ active: boolean; project: { languageHints: string[] } }>(
      await registry.call('workspace_status', {})
    );
    expect(status.active).toBe(true);
    expect(status.project.languageHints).toContain('typescript');
  });

  it('activates the Python fixture and detects the language', async () => {
    const { registry, projectRoot } = setup(PY_FIXTURE);
    await registry.call('workspace_activate', { path: projectRoot });
    const status = data<{ project: { languageHints: string[] } }>(
      await registry.call('workspace_status', {})
    );
    expect(status.project.languageHints).toContain('python');
  });

  it('reads a known fixture file through file_read', async () => {
    const { registry, projectRoot } = setup(TS_FIXTURE);
    await registry.call('workspace_activate', { path: projectRoot });
    const res = data<{ content: string }>(
      await registry.call('file_read', { path: 'src/calculator.ts' })
    );
    expect(res.content).toContain('export class Calculator');
    expect(res.content).toContain('TAX_RATE');
  });

  it('finds files by glob and text by regex', async () => {
    const { registry, projectRoot } = setup(TS_FIXTURE);
    await registry.call('workspace_activate', { path: projectRoot });

    const files = data<{ matches: string[] }>(
      await registry.call('search_files', { glob: 'src/**/*.ts' })
    );
    expect(files.matches).toContain('src/calculator.ts');

    const text = data<{ matches: unknown[] }>(
      await registry.call('search_text', { query: 'class\\s+Calculator', glob: 'src/**/*.ts' })
    );
    expect(text.matches.length).toBeGreaterThan(0);
  });

  it('finds Python symbols via search_text in the python fixture', async () => {
    const { registry, projectRoot } = setup(PY_FIXTURE);
    await registry.call('workspace_activate', { path: projectRoot });
    const text = data<{ matches: unknown[] }>(
      await registry.call('search_text', { query: 'def greet', glob: '**/*.py' })
    );
    expect(text.matches.length).toBeGreaterThan(0);
  });

  it('rejects unknown tools cleanly', async () => {
    const { registry } = setup(TS_FIXTURE);
    const res = await registry.call('does_not_exist', {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Unknown tool/);
  });
});

describe('policy enforcement through the pipeline', () => {
  it('blocks mutations in readonly mode', async () => {
    const { registry, projectRoot } = setup(TS_FIXTURE, 'readonly');
    await registry.call('workspace_activate', { path: projectRoot }).catch(() => undefined);
    const res = await registry.call('file_write', {
      path: 'scratch/should-not-write.txt',
      content: 'nope',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/readonly/i);
  });

  it('requires approval for file_delete and surfaces an approvalId', async () => {
    const { registry, projectRoot } = setup(TS_FIXTURE, 'safe');
    await registry.call('workspace_activate', { path: projectRoot });
    const res = await registry.call('file_delete', { path: 'src/calculator.ts' });
    expect(res.ok).toBe(false);
    expect(res.approvalId).toBeTruthy();
    // The file must still exist - the delete never ran.
    const read = await registry.call('file_read', { path: 'src/calculator.ts' });
    expect(read.ok).toBe(true);
  });
});
