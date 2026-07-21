import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { buildRegistry } from '../../src/tools/index.js';
import { projectPrincipalId } from '../../src/core/principal.js';
import type { ToolPrincipal } from '../../src/core/types.js';
import { defineTool } from '../../src/tools/registry.js';

const roots: string[] = [];

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-workflow-owner-'));
  roots.push(root);
  writeFileSync(join(root, 'README.md'), 'password=workflow-secret-value\n');
  const config = defaultConfig(root);
  config.policy.defaultMode = 'danger';
  config.policy.dangerouslyAllowCritical = true;
  config.rateLimit.enabled = false;
  const container = new Container(config);
  const registry = buildRegistry(container);
  return { root, container, registry };
}

function agent(root: string, id: string, sessionId: string): ToolPrincipal {
  return {
    id,
    role: 'agent',
    projectId: projectPrincipalId(root),
    oauthClientId: 'client:web',
    sessionId,
  };
}

const definition = {
  name: 'owned proof workflow',
  description: 'Read the project fixture through a durable task.',
  roles: { reader: { allowedTools: ['file_read'] } },
  steps: [{ id: 'read', role: 'reader', tool: 'file_read', args: { path: 'README.md' } }],
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workflow ownership, handoff, and Proof Packs', () => {
  it('denies cross-owner access, supports targeted handoff, and survives session reconnect', async () => {
    const { root, registry } = setup();
    const owner = agent(root, 'credential:owner', 'session:one');
    const target = agent(root, 'credential:target', 'session:target-one');
    const other = agent(root, 'credential:other', 'session:other');

    const created = await registry.callAgent(
      'workflow_create',
      {
        definition,
        objective: 'Produce bounded evidence for README inspection.',
        acceptanceCriteria: ['The read step succeeds', 'No raw secret appears in evidence'],
        knownLimitations: ['No external client reproduction'],
      },
      { principal: owner },
    );
    expect(created.ok).toBe(true);
    const id = (created.data as { id: string }).id;

    expect(
      await registry.callAgent('workflow_status', { id }, { principal: other }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/access denied/) });
    expect(
      await registry.callAgent('workflow_list', {}, { principal: other }),
    ).toMatchObject({ ok: true, data: { runs: [] } });

    const paused = await registry.callAgent(
      'workflow_pause',
      { id, reason: 'Transfer ownership.' },
      { principal: owner },
    );
    expect(paused).toMatchObject({ ok: true, data: { state: 'paused' } });

    const handed = await registry.callAgent(
      'workflow_handoff',
      { id, targetPrincipalId: target.id, ttlMs: 60_000 },
      { principal: owner },
    );
    expect(handed.ok).toBe(true);
    const claimToken = (handed.data as { claimToken: string }).claimToken;
    expect(claimToken).toMatch(/^wf_claim_/);

    expect(
      await registry.callAgent('workflow_claim', { id, claimToken }, { principal: other }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/target mismatch/) });
    expect(
      await registry.callAgent('workflow_claim', { id, claimToken: `${claimToken}x` }, { principal: target }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/invalid/) });

    const claimed = await registry.callAgent(
      'workflow_claim',
      { id, claimToken },
      { principal: target },
    );
    expect(claimed).toMatchObject({ ok: true, data: { owner: { principalId: target.id } } });
    expect(
      await registry.callAgent('workflow_status', { id }, { principal: owner }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/access denied/) });

    const reconnect = { ...target, sessionId: 'session:target-two' };
    const resumed = await registry.callAgent('workflow_resume', { id }, { principal: reconnect });
    expect(resumed).toMatchObject({ ok: true, data: { state: 'completed' } });
  });

  it('binds child audit/approvals to task id and creates a redacted verifiable Proof Pack', async () => {
    const { root, container, registry } = setup();
    const owner = agent(root, 'credential:owner', 'session:one');
    const created = await registry.callAgent(
      'workflow_create',
      {
        definition,
        objective: 'Capture auditable evidence.',
        acceptanceCriteria: ['Read succeeds'],
      },
      { principal: owner },
    );
    const id = (created.data as { id: string }).id;
    const executed = await registry.callAgent('workflow_run', { id }, { principal: owner });
    expect(executed).toMatchObject({ ok: true, data: { state: 'completed' } });

    const envelopes = container.audit
      .exportRaw()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: { tool?: string; detail?: Record<string, unknown> } });
    expect(
      envelopes.some(
        (envelope) =>
          envelope.event.tool === 'file_read' && envelope.event.detail?.taskId === id,
      ),
    ).toBe(true);

    const createdPack = await registry.callAgent('workflow_proof_pack', { id }, { principal: owner });
    expect(createdPack.ok).toBe(true);
    const proofPack = (createdPack.data as {
      proofPack: { id: string; directory: string; manifestSha256: string };
    }).proofPack;
    expect(proofPack.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(join(proofPack.directory, 'manifest.json'))).toBe(true);
    for (const name of ['report.json', 'report.md', 'changes.diff', 'approvals.json', 'audit-events.json']) {
      const content = readFileSync(join(proofPack.directory, name), 'utf8');
      expect(content).not.toContain('workflow-secret-value');
    }

    expect(
      await registry.callAgent(
        'workflow_proof_verify',
        { id, proofPackId: proofPack.id },
        { principal: owner },
      ),
    ).toMatchObject({ ok: true, data: { verified: true } });
    expect(
      await registry.callAgent('workflow_proof_list', { id }, { principal: owner }),
    ).toMatchObject({ ok: true, data: { proofPacks: [{ id: proofPack.id }] } });

    const other = agent(root, 'credential:other', 'session:other');
    expect(
      await registry.callAgent(
        'workflow_proof_verify',
        { id, proofPackId: proofPack.id },
        { principal: other },
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/access denied/) });

    writeFileSync(join(proofPack.directory, 'report.md'), 'tampered\n');
    expect(
      await registry.callAgent(
        'workflow_proof_verify',
        { id, proofPackId: proofPack.id },
        { principal: owner },
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/integrity mismatch/) });
  });
  it('preserves a manual pause during an in-flight step and resumes without replay', async () => {
    const { root, container, registry } = setup();
    const owner = agent(root, 'credential:owner', 'session:one');
    let startedResolve!: () => void;
    let releaseResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    let executions = 0;
    registry.register(
      defineTool({
        name: 'test_delayed_checkpoint',
        description: 'Test-only delayed checkpoint tool.',
        group: 'test',
        mutates: false,
        risk: 'LOW',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => {
          executions += 1;
          startedResolve();
          await release;
          return { ok: true, data: { completed: true } };
        },
      }),
    );
    const delayedDefinition = {
      name: 'pause-safe workflow',
      roles: { worker: { allowedTools: ['test_delayed_checkpoint'] } },
      steps: [{ id: 'delayed', role: 'worker', tool: 'test_delayed_checkpoint', args: {} }],
    };
    const created = await registry.callAgent(
      'workflow_create',
      { definition: delayedDefinition },
      { principal: owner },
    );
    const id = (created.data as { id: string }).id;
    const running = registry.callAgent('workflow_run', { id }, { principal: owner });
    await started;

    const paused = await registry.callAgent(
      'workflow_pause',
      { id, reason: 'Operator pause during child execution.' },
      { principal: owner },
    );
    expect(paused).toMatchObject({ ok: true, data: { state: 'paused' } });
    const handoffWhileRunning = await registry.callAgent(
      'workflow_handoff',
      { id, targetPrincipalId: 'credential:target' },
      { principal: owner },
    );
    expect(handoffWhileRunning).toMatchObject({
      ok: false,
      error: expect.stringMatching(/current running step/),
    });

    releaseResolve();
    const pausedResult = await running;
    expect(pausedResult).toMatchObject({
      ok: true,
      data: { state: 'paused', steps: [{ state: 'succeeded' }] },
    });
    expect(executions).toBe(1);

    const resumed = await registry.callAgent('workflow_resume', { id }, { principal: owner });
    expect(resumed).toMatchObject({ ok: true, data: { state: 'completed' } });
    expect(executions).toBe(1);

    const statePath = join(root, '.folderforge', 'workflows', 'runs', `${id}.json`);
    expect(existsSync(statePath)).toBe(true);
    expect(
      await registry.callAgent('file_read', { path: statePath }, { principal: owner }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/denied|Denied|blocked/) });
    expect(container.workflows.get(id, owner).state).toBe('completed');
  });

});
