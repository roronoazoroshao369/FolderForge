import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { buildRegistry } from '../../src/tools/index.js';

function initFixture(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'agent-fixture',
        version: '1.0.0',
        private: true,
        scripts: {
          typecheck: `node -e "console.log('typecheck-ok')"`,
          lint: `node -e "console.log('lint-ok')"`,
          test: `node -e "console.log('test-ok')"`,
          build: `node -e "console.log('build-ok')"`,
        },
        dependencies: { react: '^19.0.0', vite: '^7.0.0' },
      },
      null,
      2
    )
  );
  writeFileSync(
    join(root, 'src/invoice.ts'),
    `export function calculateInvoiceTotal(subtotal: number): number {\n  return subtotal;\n}\n`
  );
  writeFileSync(
    join(root, 'tests/invoice.test.ts'),
    `import { calculateInvoiceTotal } from '../src/invoice';\nvoid calculateInvoiceTotal(10);\n`
  );
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'FolderForge Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
}

function registryFor(root: string, mode: 'readonly' | 'danger' = 'danger') {
  const config = defaultConfig(root);
  config.policy.defaultMode = mode;
  config.rateLimit.enabled = false;
  const container = new Container(config);
  return { container, registry: buildRegistry(container) };
}

describe('AI coding runtime tools', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'folderforge-agent-'));
    initFixture(root);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('analyzes project architecture and builds ranked coding context', async () => {
    const { registry } = registryFor(root);
    const analysis = await registry.call('project_analyze', {});
    expect(analysis.ok).toBe(true);
    expect(analysis.data).toMatchObject({
      name: 'agent-fixture',
      frameworks: expect.arrayContaining(['React', 'Vite']),
      commands: { packageManager: 'npm' },
      architecture: { sourceRoots: expect.arrayContaining(['src']) },
    });

    const context = await registry.call('code_context', {
      query: 'calculate invoice total subtotal',
      maxResults: 5,
    });
    expect(context.ok).toBe(true);
    const results = (context.data as { results: Array<{ path: string; relatedTests: string[] }> }).results;
    expect(results[0]?.path).toBe('src/invoice.ts');
    expect(results[0]?.relatedTests).toContain('tests/invoice.test.ts');
  });

  it('previews, applies, and safely rolls back a patch transaction', async () => {
    const { registry } = registryFor(root);
    const preview = await registry.call('patch_transaction', {
      action: 'preview',
      operations: [
        {
          path: 'src/invoice.ts',
          oldText: '  return subtotal;',
          newText: '  return subtotal * 1.2;',
        },
      ],
    });
    expect(preview.ok).toBe(true);
    expect(preview.content?.[0]).toMatchObject({ kind: 'resource', mimeType: 'text/x-diff' });
    const id = (preview.data as { id: string }).id;
    expect(readFileSync(join(root, 'src/invoice.ts'), 'utf8')).toContain('return subtotal;');

    const applied = await registry.call('patch_transaction', { action: 'apply', transactionId: id });
    expect(applied.ok).toBe(true);
    expect(readFileSync(join(root, 'src/invoice.ts'), 'utf8')).toContain('subtotal * 1.2');

    const rolledBack = await registry.call('patch_transaction', {
      action: 'rollback',
      transactionId: id,
    });
    expect(rolledBack.ok).toBe(true);
    expect(readFileSync(join(root, 'src/invoice.ts'), 'utf8')).toContain('return subtotal;');
  });

  it('returns structured verification evidence for success and failure', async () => {
    const { registry } = registryFor(root);
    const success = await registry.call('project_verify', {
      checks: ['typecheck', 'lint', 'test'],
      stopOnFailure: false,
    });
    expect(success.ok).toBe(true);
    expect(success.data).toMatchObject({ passed: true, completed: 3 });

    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    pkg.scripts.test = `node -e "console.error('src/invoice.ts(1,1): error TS1000: boom'); process.exit(2)"`;
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
    const failure = await registry.call('project_verify', { checks: ['test'] });
    expect(failure.ok).toBe(false);
    const result = (failure.data as { results: Array<Record<string, unknown>> }).results[0]!;
    expect(result).toMatchObject({ check: 'test', exitCode: 2, passed: false });
    expect(result.errors).toBeTruthy();
  });

  it('summarizes Git changes and suggests checks', async () => {
    const { registry } = registryFor(root);
    writeFileSync(join(root, 'src/invoice.ts'), 'export const changed = true;\n');
    const summary = await registry.call('change_summary', {});
    expect(summary.ok).toBe(true);
    expect(summary.data).toMatchObject({
      clean: false,
      files: { modified: expect.arrayContaining(['src/invoice.ts']) },
      suggestedChecks: expect.arrayContaining(['typecheck', 'test']),
    });
  });

  it('allows preview/dry-run in readonly mode but denies patch apply', async () => {
    const { registry } = registryFor(root, 'readonly');
    const preview = await registry.call('patch_transaction', {
      action: 'preview',
      operations: [{ path: 'src/invoice.ts', oldText: 'subtotal;', newText: 'subtotal * 2;' }],
    });
    expect(preview.ok).toBe(true);
    const id = (preview.data as { id: string }).id;

    const apply = await registry.call('patch_transaction', { action: 'apply', transactionId: id });
    expect(apply.ok).toBe(false);
    expect(apply.error).toMatch(/^Denied:/);

    const plan = await registry.call('project_verify', { dryRun: true, checks: ['test'] });
    expect(plan.ok).toBe(true);
    expect(plan.data).toMatchObject({ dryRun: true });
  });
});
