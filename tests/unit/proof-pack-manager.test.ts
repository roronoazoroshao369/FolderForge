import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProofPackManager } from '../../src/proof/proof-pack-manager.js';
import { WorkflowManager, type WorkflowDefinition } from '../../src/workflows/workflow-manager.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'folderforge-proof-pack-'));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

const definition: WorkflowDefinition = {
  name: 'proof task',
  roles: { reader: { allowedTools: ['file_read'] } },
  steps: [{ id: 'read', role: 'reader', tool: 'file_read', args: { path: 'README.md' } }],
};

describe('ProofPackManager', () => {
  it('writes machine/human evidence with verifiable file and manifest hashes', () => {
    const projectRoot = root();
    const workflows = new WorkflowManager(projectRoot);
    const run = workflows.create(definition, { id: 'credential:owner', role: 'agent' }, {
      objective: 'Prove the task result',
      acceptanceCriteria: ['Read succeeded'],
      knownLimitations: ['No external reproduction'],
    });
    run.state = 'completed';
    run.startedAt = Date.now() - 10;
    run.completedAt = Date.now();
    run.steps[0]!.state = 'succeeded';
    run.steps[0]!.attempts = 1;
    run.steps[0]!.evidence = { ok: true, data: { content: 'secret-value' }, diff: 'diff --git a/a b/a' };
    workflows.save(run);

    const manager = new ProofPackManager(projectRoot, (text) => text.replaceAll('secret-value', '[REDACTED]'));
    const pack = manager.create({
      run,
      approvals: [],
      auditEvents: [{ ts: new Date().toISOString(), type: 'tool_result', detail: { taskId: run.id } }],
      auditVerification: {
        ok: true,
        schemaVersion: 2,
        records: 1,
        headHash: 'a'.repeat(64),
        signedRecords: 0,
        verifiedSignatures: 0,
        unverifiedSignatures: 0,
        issues: [],
      },
    });

    expect(manager.verify(pack.id)).toMatchObject({ id: pack.id, workflowId: run.id });
    expect(manager.list(run.id)).toHaveLength(1);
    const report = readFileSync(join(pack.directory, 'report.json'), 'utf8');
    expect(report).toContain('[REDACTED]');
    expect(report).not.toContain('secret-value');
    expect(readFileSync(join(pack.directory, 'report.md'), 'utf8')).toContain('Proof Pack');
    expect(readFileSync(join(pack.directory, 'changes.diff'), 'utf8')).toContain('diff --git');
  });

  it('fails closed on content or manifest tampering and rejects non-terminal workflows', () => {
    const projectRoot = root();
    const workflows = new WorkflowManager(projectRoot);
    const run = workflows.create(definition);
    const manager = new ProofPackManager(projectRoot, (text) => text);
    const audit = {
      ok: true as const,
      schemaVersion: 2 as const,
      records: 0,
      headHash: null,
      signedRecords: 0,
      verifiedSignatures: 0,
      unverifiedSignatures: 0,
      issues: [],
    };
    expect(() => manager.create({ run, approvals: [], auditEvents: [], auditVerification: audit })).toThrow(/terminal/);

    run.state = 'failed';
    run.failure = 'expected';
    run.completedAt = Date.now();
    const pack = manager.create({ run, approvals: [], auditEvents: [], auditVerification: audit });
    writeFileSync(join(pack.directory, 'report.json'), 'tampered\n');
    expect(() => manager.verify(pack.id)).toThrow(/integrity mismatch/);
  });
});
