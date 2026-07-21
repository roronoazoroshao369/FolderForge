import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

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
  it('binds ownership to principal/project/client while allowing session reconnect', () => {
    const manager = new WorkflowManager(root);
    const owner = {
      id: 'credential:owner',
      role: 'agent' as const,
      projectId: 'project:alpha',
      oauthClientId: 'client:web',
      sessionId: 'session:one',
    };
    const run = manager.create(definition, owner, {
      objective: 'Implement a safe change',
      acceptanceCriteria: ['Tests pass'],
    });
    expect(manager.get(run.id, { ...owner, sessionId: 'session:two' }).id).toBe(run.id);
    expect(() => manager.get(run.id, { ...owner, projectId: 'project:beta' })).toThrow(/access denied/);
    expect(() => manager.get(run.id, { ...owner, oauthClientId: 'client:other' })).toThrow(/access denied/);
    expect(() => manager.get(run.id, { ...owner, id: 'credential:other' })).toThrow(/access denied/);
    expect(manager.list({ ...owner, sessionId: 'session:reconnect' })).toHaveLength(1);
    expect(manager.list({ ...owner, id: 'credential:other' })).toHaveLength(0);
  });

  it('supports targeted one-time handoff and invalidates prior ownership', () => {
    const manager = new WorkflowManager(root);
    const owner = { id: 'credential:owner', role: 'agent' as const, projectId: 'project:alpha' };
    const target = { id: 'credential:target', role: 'agent' as const, projectId: 'project:alpha' };
    const run = manager.create(definition, owner);
    const handoff = manager.handoff(run.id, owner, target.id, 60_000);
    expect(handoff.token).toMatch(/^wf_claim_/);
    expect(readFileSync(join(root, '.folderforge', 'workflows', 'runs', `${run.id}.json`), 'utf8')).not.toContain(handoff.token);
    expect(() => manager.claim(run.id, 'wrong-token-value-that-is-long-enough', target)).toThrow(/invalid/);
    expect(() => manager.claim(run.id, handoff.token, { ...target, id: 'credential:wrong' })).toThrow(/target mismatch/);
    expect(manager.claim(run.id, handoff.token, target).owner.principalId).toBe(target.id);
    expect(() => manager.claim(run.id, handoff.token, target)).toThrow(/no pending handoff/);
    expect(() => manager.get(run.id, owner)).toThrow(/access denied/);
    expect(manager.get(run.id, target).id).toBe(run.id);
  });

  it('fails expired handoff closed and migrates legacy runs as admin-only', () => {
    const manager = new WorkflowManager(root);
    const owner = { id: 'credential:owner', role: 'agent' as const };
    const target = { id: 'credential:target', role: 'agent' as const };
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T00:00:00.000Z'));
    const run = manager.create(definition, owner);
    const handoff = manager.handoff(run.id, owner, target.id, 1_000);
    vi.advanceTimersByTime(1_001);
    expect(() => manager.claim(run.id, handoff.token, target)).toThrow(/expired/);

    const legacyId = 'wf_legacy123';
    const legacy = {
      ...run,
      schemaVersion: 1,
      id: legacyId,
    } as Record<string, unknown>;
    delete legacy.owner;
    delete legacy.task;
    delete legacy.proofPacks;
    delete legacy.handoff;
    writeFileSync(
      join(root, '.folderforge', 'workflows', 'runs', `${legacyId}.json`),
      `${JSON.stringify(legacy, null, 2)}\n`,
    );
    expect(() => manager.get(legacyId, owner)).toThrow(/access denied/);
    expect(manager.get(legacyId, { id: 'local:admin', role: 'admin' })).toMatchObject({
      schemaVersion: 2,
      owner: { principalId: 'legacy:unowned' },
    });
  });

  it('detects state tampering and rejects stale concurrent saves', () => {
    const manager = new WorkflowManager(root);
    const run = manager.create(definition);
    const stale = manager.get(run.id);
    const current = manager.get(run.id);
    current.pauseReason = 'first writer';
    manager.save(current);
    stale.pauseReason = 'stale writer';
    expect(() => manager.save(stale)).toThrow(/changed concurrently/);

    const path = join(root, '.folderforge', 'workflows', 'runs', `${run.id}.json`);
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const task = persisted.task as Record<string, unknown>;
    task.objective = 'tampered objective';
    writeFileSync(path, `${JSON.stringify(persisted, null, 2)}
`);
    expect(() => manager.get(run.id)).toThrow(/integrity check failed/);
  });

  it('keeps live locks fail-closed and recovers an old dead-process lock', () => {
    const manager = new WorkflowManager(root);
    const owner = { id: 'credential:owner', role: 'agent' as const };
    const target = { id: 'credential:target', role: 'agent' as const };
    const run = manager.create(definition, owner);
    const handoff = manager.handoff(run.id, owner, target.id, 60_000);
    const lockPath = join(root, '.folderforge', 'workflows', 'runs', `${run.id}.lock`);

    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}
`,
    );
    expect(() => manager.claim(run.id, handoff.token, target)).toThrow(/busy/);
    expect(existsSync(lockPath)).toBe(true);

    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 99999999, createdAt: '2000-01-01T00:00:00.000Z' })}
`,
    );
    expect(manager.claim(run.id, handoff.token, target).owner.principalId).toBe(target.id);
    expect(existsSync(lockPath)).toBe(false);
    if (existsSync(lockPath)) unlinkSync(lockPath);
  });

});
