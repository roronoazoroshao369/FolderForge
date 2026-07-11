import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../../src/core/config.js';
import { Container } from '../../src/core/container.js';
import { buildRegistry } from '../../src/tools/index.js';

function setup(root: string) {
  const config = defaultConfig(root);
  config.policy.defaultMode = 'safe';
  config.policy.requireApproval = ['file_write'];
  config.rateLimit.enabled = false;
  const container = new Container(config);
  const registry = buildRegistry(container);
  return { container, registry };
}

describe('governed workflow tools', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'folderforge-workflow-tools-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'workflow-fixture', version: '1.0.0' }));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('pauses for one-shot approval, resumes without replay, and persists report', async () => {
    const { container, registry } = setup(root);
    const definition = {
      name: 'multi-role implementation',
      roles: {
        planner: { allowedTools: ['project_analyze'] },
        coder: { allowedTools: ['file_write'] },
        reviewer: { allowedTools: ['file_read'] },
      },
      steps: [
        { id: 'analyze', role: 'planner', tool: 'project_analyze' },
        {
          id: 'write', role: 'coder', tool: 'file_write', dependsOn: ['analyze'],
          args: { path: 'workflow-output.txt', content: 'hello workflow\n' },
        },
        {
          id: 'review', role: 'reviewer', tool: 'file_read', dependsOn: ['write'],
          args: { path: 'workflow-output.txt' },
          expect: { path: 'ok', equals: true },
        },
      ],
    };

    const created = await registry.call('workflow_create', { definition });
    expect(created.ok).toBe(true);
    const id = (created.data as { id: string }).id;

    const paused = await registry.call('workflow_run', { id });
    expect(paused.ok).toBe(true);
    expect(paused.data).toMatchObject({ state: 'paused', currentStepId: 'write' });
    const pausedSteps = (paused.data as { steps: Array<{ id: string; state: string; attempts: number; approvalId?: string }> }).steps;
    expect(pausedSteps.find((step) => step.id === 'analyze')).toMatchObject({ state: 'succeeded', attempts: 1 });
    const waiting = pausedSteps.find((step) => step.id === 'write')!;
    expect(waiting).toMatchObject({ state: 'awaiting_approval', attempts: 1 });
    expect(waiting.approvalId).toBeTruthy();

    container.policy.approvals.approve(waiting.approvalId!, 'once');
    const resumed = await registry.call('workflow_resume', { id });
    expect(resumed.ok).toBe(true);
    expect(resumed.data).toMatchObject({ state: 'completed' });
    const steps = (resumed.data as { steps: Array<{ id: string; attempts: number; state: string }> }).steps;
    expect(steps.find((step) => step.id === 'analyze')).toMatchObject({ attempts: 1, state: 'succeeded' });
    expect(steps.find((step) => step.id === 'write')).toMatchObject({ attempts: 2, state: 'succeeded' });
    expect(steps.find((step) => step.id === 'review')).toMatchObject({ attempts: 1, state: 'succeeded' });
    expect(readFileSync(join(root, 'workflow-output.txt'), 'utf8')).toBe('hello workflow\n');

    const restarted = setup(root);
    const report = await restarted.registry.call('workflow_report', { id });
    expect(report.ok).toBe(true);
    expect(report.data).toMatchObject({ state: 'completed', summary: { successful: true, resumable: false } });
    const rerun = await restarted.registry.call('workflow_resume', { id });
    expect(rerun.ok).toBe(false);
    expect(rerun.error).toContain('requires paused state');
  });

  it('enforces role scopes, rejects recursion, and supports cancellation', async () => {
    const { registry } = setup(root);
    const invalid = await registry.call('workflow_create', {
      definition: {
        name: 'invalid', roles: { coder: { allowedTools: ['file_read'] } },
        steps: [{ id: 'bad', role: 'coder', tool: 'file_write', args: { path: 'x', content: 'x' } }],
      },
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain('not allowed');

    const recursive = await registry.call('workflow_create', {
      definition: {
        name: 'recursive', roles: { orchestrator: { allowedTools: ['workflow_status'] } },
        steps: [{ id: 'bad', role: 'orchestrator', tool: 'workflow_status', args: { id: 'wf_x' } }],
      },
    });
    expect(recursive.ok).toBe(false);
    expect(recursive.error).toContain('recursive');

    const created = await registry.call('workflow_create', {
      definition: {
        name: 'cancel me', roles: { reader: { allowedTools: ['file_read'] } },
        steps: [{ id: 'read', role: 'reader', tool: 'file_read', args: { path: 'package.json' } }],
      },
    });
    const id = (created.data as { id: string }).id;
    const cancelled = await registry.call('workflow_cancel', { id });
    expect(cancelled.ok).toBe(true);
    expect(cancelled.data).toMatchObject({ state: 'cancelled' });
  });
});
