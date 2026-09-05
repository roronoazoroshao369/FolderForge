import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** Poll project_verify status until the run leaves the running state. */
async function waitForVerificationTerminal(
  registry: ReturnType<typeof buildRegistry>,
  id: string,
  timeoutMs = 15000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await registry.call('project_verify', { action: 'status', id });
    expect(status.ok).toBe(true);
    const data = status.data as Record<string, unknown>;
    if (data.state !== 'running') return data;
    if (Date.now() > deadline) {
      throw new Error(`Verification ${id} did not reach a terminal state within ${timeoutMs}ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
    const failure = await registry.call('project_verify', { checks: ['test', 'build'] });
    expect(failure.ok).toBe(false);
    const failureData = failure.data as {
      id: string;
      overall: string;
      results: Array<Record<string, unknown>>;
    };
    expect(failureData.overall).toBe('failed');
    expect(failureData.results[0]).toMatchObject({
      check: 'test',
      exitCode: 2,
      status: 'failed',
      passed: false,
    });
    expect(failureData.results[0]?.errors).toBeTruthy();
    expect(failureData.results[1]).toMatchObject({
      check: 'build',
      status: 'skipped',
      skipped: true,
    });

    delete pkg.scripts.lint;
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
    const unavailable = await registry.call('project_verify', { checks: ['lint', 'build'] });
    expect(unavailable.ok).toBe(false);
    expect(unavailable.data).toMatchObject({
      overall: 'unavailable',
      results: [
        { check: 'lint', status: 'unavailable', passed: false },
        { check: 'build', status: 'skipped', skipped: true },
      ],
    });
  });

  it('persists verification reports and enforces owner/project/client boundaries', async () => {
    const { registry } = registryFor(root);
    const owner = {
      id: 'credential:verify-owner',
      role: 'agent' as const,
      projectId: 'project:alpha',
      oauthClientId: 'client:web',
      sessionId: 'session:one',
      taskId: 'wf_verifytask',
    };
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    pkg.scripts.test = `node -e "console.log('api_key=supersecretverificationvalue')"`;
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
    const executed = await registry.call(
      'project_verify',
      { action: 'run', checks: ['test'] },
      { principal: owner },
    );
    expect(executed.ok).toBe(true);
    expect(JSON.stringify(executed.data)).not.toContain('supersecretverificationvalue');
    const id = (executed.data as { id: string }).id;
    expect(
      readFileSync(join(root, '.folderforge', 'verifications', 'runs', `${id}.json`), 'utf8'),
    ).not.toContain('supersecretverificationvalue');

    const status = await registry.call(
      'project_verify',
      { action: 'status', id },
      { principal: { ...owner, sessionId: 'session:reconnect' } },
    );
    expect(status.ok).toBe(true);
    expect(status.data).toMatchObject({
      id,
      taskId: owner.taskId,
      state: 'completed',
      overall: 'passed',
    });

    const deniedStateRead = await registry.call(
      'file_read',
      { path: `.folderforge/verifications/runs/${id}.json` },
      { principal: owner },
    );
    expect(deniedStateRead.ok).toBe(false);
    expect(deniedStateRead.error).toMatch(/denied by policy/i);

    const listed = await registry.call(
      'project_verify',
      { action: 'list' },
      { principal: { ...owner, sessionId: 'session:list' } },
    );
    expect(listed.ok).toBe(true);
    expect(listed.data).toMatchObject({ runs: [expect.objectContaining({ id })] });

    const crossOwner = await registry.call(
      'project_verify',
      { action: 'status', id },
      { principal: { ...owner, id: 'credential:other' } },
    );
    expect(crossOwner.ok).toBe(false);
    expect(crossOwner.error).toMatch(/access denied/i);
    const crossProject = await registry.call(
      'project_verify',
      { action: 'status', id },
      { principal: { ...owner, projectId: 'project:other' } },
    );
    expect(crossProject.ok).toBe(false);
    const crossClient = await registry.call(
      'project_verify',
      { action: 'status', id },
      { principal: { ...owner, oauthClientId: 'client:other' } },
    );
    expect(crossClient.ok).toBe(false);
  });

  it('cancels an in-flight verification command and persists skipped evidence', async () => {
    const { registry } = registryFor(root);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    pkg.scripts.test = `node -e "setTimeout(() => console.log('too-late'), 10000)"`;
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));

    const controller = new AbortController();
    const call = registry.call(
      'project_verify',
      { checks: ['test', 'build'] },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error('operator cancelled verification')), 100);
    const cancelled = await call;
    expect(cancelled.ok).toBe(false);
    expect(cancelled.error).toMatch(/cancelled/i);
    expect(cancelled.data).toMatchObject({
      state: 'cancelled',
      overall: 'incomplete',
      results: [
        { check: 'test', status: 'skipped', skipped: true },
        { check: 'build', status: 'skipped', skipped: true },
      ],
    });
  });

  it('fails before execution when durable evidence storage is unavailable', async () => {
    const { registry } = registryFor(root);
    const markerPath = join(root, 'should-not-run.txt');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    pkg.scripts.test = `node -e "require('fs').writeFileSync('${markerPath}', 'ran')"`;
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
    writeFileSync(join(root, '.folderforge', 'verifications'), 'not-a-directory');

    const result = await registry.call('project_verify', { checks: ['test'] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/evidence store unavailable before execution/i);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('reports uncertain outcome when checkpoint persistence fails after execution', async () => {
    const { container, registry } = registryFor(root);
    const markerPath = join(root, 'verification-ran.txt');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    pkg.scripts.test = `node -e "require('fs').writeFileSync('${markerPath}', 'ran')"`;
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
    container.verifications.checkpoint = (() => {
      throw new Error('simulated disk full');
    }) as typeof container.verifications.checkpoint;

    const result = await registry.call('project_verify', { checks: ['test'] });
    expect(existsSync(markerPath)).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^VERIFICATION_OUTCOME_UNCERTAIN:/);
    expect(result.error).toMatch(/Do not retry automatically/);
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

  it('allows verification plan/status/list in readonly mode but denies execution and patch apply', async () => {
    const seeded = registryFor(root);
    const verified = await seeded.registry.call('project_verify', { checks: ['test'] });
    expect(verified.ok).toBe(true);
    const verificationId = (verified.data as { id: string }).id;

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

    const plan = await registry.call('project_verify', { action: 'plan', checks: ['build', 'test'] });
    expect(plan.ok).toBe(true);
    expect(plan.data).toMatchObject({ dryRun: true, requested: ['test', 'build'] });
    const invalid = await registry.call('project_verify', { action: 'plan', checks: ['test', 'unknown'] });
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toMatch(/Unknown verification checks: unknown/);
    const status = await registry.call('project_verify', {
      action: 'status',
      id: verificationId,
      dryRun: true,
    });
    expect(status.ok).toBe(true);
    expect(status.data).toMatchObject({ id: verificationId, overall: 'passed' });
    const listed = await registry.call('project_verify', { action: 'list' });
    expect(listed.ok).toBe(true);
    expect(listed.data).toMatchObject({ runs: [expect.objectContaining({ id: verificationId })] });
    const deniedVerification = await registry.call('project_verify', { action: 'run', checks: ['test'] });
    expect(deniedVerification.ok).toBe(false);
    expect(deniedVerification.error).toMatch(/^Denied:/);
  });

  it('starts an async verification detached from the request and polls it to a passed terminal state', async () => {
    const { registry } = registryFor(root);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    pkg.scripts.test = `node -e "setTimeout(() => console.log('test-ok'), 2500)"`;
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));

    const startedAt = Date.now();
    const started = await registry.call('project_verify', { action: 'run', async: true, checks: ['test'] });
    const startMs = Date.now() - startedAt;
    expect(started.ok).toBe(true);
    const startedData = started.data as { id: string; state: string; results: Array<{ status: string }> };
    expect(startedData.state).toBe('running');
    expect(startedData.results[0]?.status).toBe('pending');
    expect(startMs).toBeLessThan(5000);

    const final = await waitForVerificationTerminal(registry, startedData.id);
    expect(final).toMatchObject({ state: 'completed', overall: 'passed', passed: true });

    // Polling must never create a duplicate execution.
    const listed = await registry.call('project_verify', { action: 'list' });
    const matching = (listed.data as { runs: Array<{ id: string }> }).runs.filter(
      (entry) => entry.id === startedData.id,
    );
    expect(matching).toHaveLength(1);
  });

  it('keeps an async verification running after the requesting call is aborted', async () => {
    const { registry } = registryFor(root);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    pkg.scripts.test = `node -e "setTimeout(() => console.log('test-ok'), 2500)"`;
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));

    const controller = new AbortController();
    const started = await registry.call(
      'project_verify',
      { action: 'run', async: true, checks: ['test'] },
      { signal: controller.signal },
    );
    expect(started.ok).toBe(true);
    const id = (started.data as { id: string }).id;
    // The client disconnecting must not cancel a detached run.
    controller.abort(new Error('client disconnected'));
    const final = await waitForVerificationTerminal(registry, id);
    expect(final).toMatchObject({ state: 'completed', overall: 'passed' });
  });

  it('cancels a detached async verification and records skipped evidence', async () => {
    const { registry } = registryFor(root);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    pkg.scripts.test = `node -e "setTimeout(() => console.log('too-late'), 30000)"`;
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));

    const started = await registry.call('project_verify', { action: 'run', async: true, checks: ['test', 'build'] });
    expect(started.ok).toBe(true);
    const id = (started.data as { id: string }).id;

    const cancelled = await registry.call('project_verify', { action: 'cancel', id });
    expect(cancelled.ok).toBe(true);
    expect((cancelled.data as { cancellation: string }).cancellation).toBe('requested');

    const final = await waitForVerificationTerminal(registry, id);
    expect(final).toMatchObject({ state: 'cancelled', overall: 'incomplete' });
    expect((final as { results: Array<Record<string, unknown>> }).results).toMatchObject([
      { check: 'test', status: 'skipped', skipped: true },
      { check: 'build', status: 'skipped', skipped: true },
    ]);

    // Cancelling a terminal run is an idempotent no-op.
    const again = await registry.call('project_verify', { action: 'cancel', id });
    expect(again.ok).toBe(true);
    expect((again.data as { cancellation: string }).cancellation).toBe('not-required');
  });

  it('handles cancel edge cases: terminal run, unknown id, and owner boundary', async () => {
    const { registry } = registryFor(root);
    const done = await registry.call('project_verify', { action: 'run', checks: ['test'] });
    expect(done.ok).toBe(true);
    const doneId = (done.data as { id: string }).id;

    const terminal = await registry.call('project_verify', { action: 'cancel', id: doneId });
    expect(terminal.ok).toBe(true);
    expect(terminal.data).toMatchObject({ id: doneId, state: 'completed', cancellation: 'not-required' });

    const unknown = await registry.call('project_verify', { action: 'cancel', id: 'verify_0000000000000000' });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/not found/i);

    const owner = {
      id: 'credential:verify-owner',
      role: 'agent' as const,
      projectId: 'project:alpha',
      oauthClientId: 'client:web',
      sessionId: 'session:one',
    };
    const owned = await registry.call(
      'project_verify',
      { action: 'run', checks: ['test'] },
      { principal: owner },
    );
    const ownedId = (owned.data as { id: string }).id;
    const denied = await registry.call(
      'project_verify',
      { action: 'cancel', id: ownedId },
      { principal: { ...owner, id: 'credential:intruder' } },
    );
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/access denied/i);
    // Admin principals share the existing read-side bypass for cancellation.
    const asAdmin = await registry.call(
      'project_verify',
      { action: 'cancel', id: ownedId },
      { principal: { id: 'user:admin', role: 'admin' } },
    );
    expect(asAdmin.ok).toBe(true);
    expect((asAdmin.data as { cancellation: string }).cancellation).toBe('not-required');
  });

  it('denies async run and cancel in readonly mode while keeping plan/status/list', async () => {
    const { registry } = registryFor(root, 'readonly');
    const deniedAsync = await registry.call('project_verify', { action: 'run', async: true, checks: ['test'] });
    expect(deniedAsync.ok).toBe(false);
    expect(deniedAsync.error).toMatch(/^Denied:/);
    const deniedCancel = await registry.call('project_verify', { action: 'cancel', id: 'verify_0000000000000000' });
    expect(deniedCancel.ok).toBe(false);
    expect(deniedCancel.error).toMatch(/^Denied:/);
    const plan = await registry.call('project_verify', { action: 'plan', checks: ['test'] });
    expect(plan.ok).toBe(true);
    const listed = await registry.call('project_verify', { action: 'list' });
    expect(listed.ok).toBe(true);
  });

  it('refuses a second concurrent async run while allowing synchronous runs', async () => {
    const { registry } = registryFor(root);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    pkg.scripts.test = `node -e "setTimeout(() => console.log('too-late'), 30000)"`;
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));

    const first = await registry.call('project_verify', { action: 'run', async: true, checks: ['test'] });
    expect(first.ok).toBe(true);
    const firstId = (first.data as { id: string }).id;

    const second = await registry.call('project_verify', { action: 'run', async: true, checks: ['test'] });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/Another async verification is still running/);
    expect(second.error).toContain(firstId);

    // Synchronous executions are not capped by the async single-flight guard.
    const syncRun = await registry.call('project_verify', { action: 'run', checks: ['build'] });
    expect(syncRun.ok).toBe(true);

    const cancelled = await registry.call('project_verify', { action: 'cancel', id: firstId });
    expect(cancelled.ok).toBe(true);
    const final = await waitForVerificationTerminal(registry, firstId);
    expect(final).toMatchObject({ state: 'cancelled', overall: 'incomplete' });
  });

  it('applies stopOnFailure semantics to detached async runs', async () => {
    const { registry } = registryFor(root);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    pkg.scripts.test = `node -e "console.error('boom'); process.exit(2)"`;
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));

    const started = await registry.call('project_verify', { action: 'run', async: true, checks: ['test', 'build'] });
    expect(started.ok).toBe(true);
    const id = (started.data as { id: string }).id;
    const final = await waitForVerificationTerminal(registry, id);
    expect(final).toMatchObject({ state: 'completed', overall: 'failed', passed: false });
    expect((final as { results: Array<Record<string, unknown>> }).results).toMatchObject([
      { check: 'test', status: 'failed', exitCode: 2 },
      { check: 'build', status: 'skipped', skipped: true },
    ]);
  });

  it('cancels an in-flight synchronous run through the cancel action', async () => {
    const { registry } = registryFor(root);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    pkg.scripts.test = `node -e "setTimeout(() => console.log('too-late'), 30000)"`;
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));

    const call = registry.call('project_verify', { checks: ['test', 'build'] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const listed = await registry.call('project_verify', { action: 'list' });
    const running = (listed.data as { runs: Array<{ id: string; state: string }> }).runs.find(
      (entry) => entry.state === 'running',
    );
    expect(running).toBeDefined();
    const cancelled = await registry.call('project_verify', { action: 'cancel', id: running!.id });
    expect(cancelled.ok).toBe(true);
    const result = await call;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cancelled/i);
    expect(result.data).toMatchObject({ state: 'cancelled', overall: 'incomplete' });
  });

  it('rejects async on non-run actions', async () => {
    const { registry } = registryFor(root);
    const onPlan = await registry.call('project_verify', { action: 'plan', async: true, checks: ['test'] });
    expect(onPlan.ok).toBe(false);
    expect(onPlan.error).toMatch(/async is only supported with action=run/);
  });
});
