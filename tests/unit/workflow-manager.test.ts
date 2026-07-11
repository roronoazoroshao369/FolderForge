import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  WorkflowManager,
  checkWorkflowExpectation,
  resolveWorkflowValue,
  validateWorkflowDefinition,
  workflowEvidence,
  type WorkflowDefinition,
} from '../../src/workflows/workflow-manager.js';

describe('WorkflowManager', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'folderforge-workflow-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const definition: WorkflowDefinition = {
    name: 'implementation council',
    roles: {
      planner: { allowedTools: ['project_analyze'] },
      coder: { allowedTools: ['patch_transaction'] },
    },
    steps: [
      { id: 'analyze', role: 'planner', tool: 'project_analyze' },
      {
        id: 'preview', role: 'coder', tool: 'patch_transaction', dependsOn: ['analyze'],
        args: { action: 'status', transactionId: { $step: 'analyze', path: 'data.transactionId' } },
      },
    ],
  };

  it('validates roles, tools, dependencies, and cycles', () => {
    const tools = new Set(['project_analyze', 'patch_transaction']);
    expect(validateWorkflowDefinition(definition, tools).steps).toHaveLength(2);
    expect(() => validateWorkflowDefinition({ ...definition, steps: [{ ...definition.steps[0]!, tool: 'workflow_run' }] }, new Set([...tools, 'workflow_run']))).toThrow(/recursive/);
    expect(() => validateWorkflowDefinition({ ...definition, steps: [
      { id: 'a', role: 'planner', tool: 'project_analyze', dependsOn: ['b'] },
      { id: 'b', role: 'planner', tool: 'project_analyze', dependsOn: ['a'] },
    ] }, tools)).toThrow(/cycle/);
  });

  it('persists runs and resolves bounded step references', () => {
    const manager = new WorkflowManager(root);
    const run = manager.create(definition);
    run.steps[0]!.state = 'succeeded';
    run.steps[0]!.evidence = { ok: true, data: { transactionId: 'patch_123' } };
    manager.save(run);
    expect(resolveWorkflowValue(definition.steps[1]!.args, run)).toMatchObject({ transactionId: 'patch_123' });
    expect(new WorkflowManager(root).get(run.id).steps[0]?.state).toBe('succeeded');
    expect(manager.list()[0]?.id).toBe(run.id);
  });

  it('redacts/truncates evidence and evaluates assertions', () => {
    const evidence = workflowEvidence(
      { ok: true, data: { token: 'secret-value', passed: true }, content: [{ kind: 'image', data: 'a'.repeat(100), mimeType: 'image/png' }] },
      (text) => text.replaceAll('secret-value', '[REDACTED]')
    );
    expect(evidence.data).toEqual({ token: '[REDACTED]', passed: true });
    expect(evidence.content?.[0]).toMatchObject({ kind: 'image', mimeType: 'image/png' });
    expect(evidence.content?.[0]).not.toHaveProperty('data');
    expect(checkWorkflowExpectation({ path: 'data.passed', equals: true }, evidence).passed).toBe(true);
  });
});
