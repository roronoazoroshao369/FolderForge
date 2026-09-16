import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentLoopManager } from '../../src/agent-loops/agent-loop-manager.js';
import type { ToolPrincipal } from '../../src/core/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const owner: ToolPrincipal = { id: 'agent:test-owner', role: 'agent' };
const other: ToolPrincipal = { id: 'agent:other', role: 'agent' };

function advanceToVerification(manager: AgentLoopManager, id: string, changedPaths = ['src/example.ts']) {
  let run = manager.start(id, owner);
  for (const expert of run.experts) {
    run = manager.submitProposal(id, {
      expertId: expert.id,
      phase: 'council',
      summary: `${expert.role} proposal`,
      plan: ['Inspect', 'Implement', 'Verify'],
      risks: ['Regression risk'],
      evidence: ['Repository context reviewed'],
    }, owner);
  }
  const proposals = manager.view(run).currentIterationProposals;
  const winner = proposals[0]!;
  for (const expert of run.experts.slice(0, run.councilMinVotes)) {
    run = manager.submitVote(id, {
      expertId: expert.id,
      proposalId: winner.id,
      score: 1,
      approve: true,
      rationale: 'Strong evidence and bounded plan.',
    }, owner);
  }
  run = manager.decide(id, owner);
  run = manager.recordImplementation(id, {
    status: 'completed',
    summary: 'Implementation completed through the governed workflow.',
    changedPaths,
  }, owner);
  return run;
}

describe('AgentLoopManager', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'folderforge-agent-loop-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('persists an owner-bound loop and rejects another principal', () => {
    const manager = new AgentLoopManager(root);
    const created = manager.create({
      title: 'Feature loop',
      goal: 'Ship the feature safely.',
      acceptanceCriteria: ['Tests pass'],
    }, owner);

    expect(manager.get(created.id, owner).revision).toBeGreaterThan(0);
    expect(() => manager.get(created.id, other)).toThrow(/access denied/i);

    const restarted = new AgentLoopManager(root);
    expect(restarted.view(restarted.get(created.id, owner))).toMatchObject({
      id: created.id,
      state: 'created',
      phase: 'discovery',
      goalGate: { satisfied: false, totalCriteria: 1 },
    });
  });

  it('accepts one durable run idempotency key and rejects conflicting retries', () => {
    const manager = new AgentLoopManager(root);
    const created = manager.create({
      title: 'Idempotent loop',
      goal: 'Do not launch duplicate background runs.',
      acceptanceCriteria: ['Only one claim is recorded'],
    }, owner);

    const claimed = manager.claimRunInvocation(created.id, 'request-123', owner);
    expect(claimed.runInvocationKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manager.claimRunInvocation(created.id, 'request-123', owner).revision).toBe(claimed.revision);
    expect(() => manager.claimRunInvocation(created.id, 'request-456', owner)).toThrow(/different idempotency key/i);
  });

  it('binds a loop to its creating client, session and task context', () => {
    const manager = new AgentLoopManager(root);
    const bound: ToolPrincipal = {
      id: 'agent:bound-owner',
      role: 'agent',
      oauthClientId: 'client-a',
      sessionId: 'session-a',
      taskId: 'task-a',
    };
    const created = manager.create({
      title: 'Bound loop',
      goal: 'Keep remote execution correlated.',
      acceptanceCriteria: ['Context is preserved'],
    }, bound);

    expect(created).toMatchObject({
      ownerId: bound.id,
      clientId: bound.oauthClientId,
      sessionId: bound.sessionId,
      taskId: bound.taskId,
    });
    expect(() => manager.get(created.id, { ...bound, sessionId: 'session-b' })).toThrow(/session binding/i);
    expect(() => manager.get(created.id, { ...bound, oauthClientId: 'client-b' })).toThrow(/client binding/i);
    expect(() => manager.get(created.id, { ...bound, taskId: 'task-b' })).toThrow(/task binding/i);
    expect(() => manager.get(created.id, { ...bound, taskId: undefined })).toThrow(/task binding/i);
    expect(manager.get(created.id, bound).id).toBe(created.id);
    expect(manager.get(created.id, bound).events[0]?.data).toMatchObject({ taskId: 'task-a' });
  });

  it('runs discovery, reaches council consensus, and completes the goal gate', () => {
    const manager = new AgentLoopManager(root);
    const created = manager.create({
      title: 'Complete loop',
      goal: 'Complete the implementation.',
      acceptanceCriteria: ['Typecheck passes', 'Tests pass'],
      maxIterations: 2,
      councilMinVotes: 2,
    }, owner);

    const implementation = advanceToVerification(manager, created.id);
    expect(implementation.phase).toBe('verification');
    expect(implementation.decision?.voteCount).toBe(2);

    const completed = manager.recordVerification(created.id, {
      passed: true,
      criteria: [
        { name: 'Typecheck passes', passed: true, evidence: 'tsc exited 0' },
        { name: 'Tests pass', passed: true, evidence: 'vitest exited 0' },
      ],
      checks: ['typecheck', 'test'],
    }, owner);

    expect(completed).toMatchObject({ state: 'completed', phase: 'completed' });
    expect(manager.view(completed).goalGate).toEqual({ satisfied: true, passedCriteria: 2, totalCriteria: 2 });
  });

  it('starts a new iteration after a failed goal gate and fails at the limit', () => {
    const manager = new AgentLoopManager(root);
    const created = manager.create({
      title: 'Retry loop',
      goal: 'Pass verification eventually.',
      acceptanceCriteria: ['Tests pass'],
      maxIterations: 2,
      councilMinVotes: 2,
    }, owner);

    advanceToVerification(manager, created.id);
    const retry = manager.recordVerification(created.id, {
      passed: false,
      criteria: [{ name: 'Tests pass', passed: false, evidence: 'test failed' }],
      checks: ['test'],
    }, owner);
    expect(retry).toMatchObject({ state: 'running', phase: 'discovery', iteration: 2 });

    const secondVerification = advanceToVerification(manager, created.id);
    expect(secondVerification.iteration).toBe(2);
    const failed = manager.recordVerification(created.id, {
      passed: false,
      criteria: [{ name: 'Tests pass', passed: false }],
    }, owner);
    expect(failed).toMatchObject({ state: 'failed', phase: 'failed' });
  });

  it('persists lifecycle events and supports bounded sequence polling', () => {
    const manager = new AgentLoopManager(root);
    const created = manager.create({
      title: 'Event loop',
      goal: 'Expose durable progress.',
      acceptanceCriteria: ['Events are queryable'],
    }, owner);

    let run = manager.start(created.id, owner);
    run = manager.pause(created.id, owner, 'Operator review.');
    run = manager.start(created.id, owner);
    run = manager.cancel(created.id, owner, 'No longer needed.');

    expect(run.events.map((event) => event.type)).toEqual([
      'created',
      'started',
      'paused',
      'resumed',
      'cancelled',
    ]);
    const page = manager.eventsSince(created.id, 1, 2, owner);
    expect(page.events.map((event) => event.seq)).toEqual([2, 3]);
    expect(page.latestSeq).toBe(5);
    expect(page.hasMore).toBe(true);
    expect(() => manager.eventsSince(created.id, 0, 10, other)).toThrow(/access denied/i);
    });

    it('records proposal, vote, decision, implementation, and verification events', () => {
      const manager = new AgentLoopManager(root);
      const created = manager.create({
        title: 'Phase events',
        goal: 'Capture every orchestration phase.',
        acceptanceCriteria: ['All phase events exist'],
      }, owner);

      const verification = advanceToVerification(manager, created.id);
      const completed = manager.recordVerification(created.id, {
        passed: true,
        criteria: [{ name: 'All phase events exist', passed: true }],
        checks: ['event-history'],
      }, owner);
      const types = completed.events.map((event) => event.type);
      expect(types).toEqual(expect.arrayContaining([
        'created',
        'started',
        'proposal.submitted',
        'vote.submitted',
        'council.decided',
        'implementation.updated',
        'verification.passed',
      ]));
      expect(verification.events.find((event) => event.type === 'council.decided')?.data).toMatchObject({
        proposalId: verification.decision?.proposalId,
      });
    });

    it('bounds event history, payloads, and loads legacy runs without events', () => {
      const manager = new AgentLoopManager(root);
      const created = manager.create({
        title: 'Bounded events',
        goal: 'Keep event storage bounded.',
        acceptanceCriteria: ['Events remain bounded'],
      }, owner);

      let run = manager.start(created.id, owner);
      for (let index = 0; index < 260; index += 1) {
        run = manager.pause(created.id, owner, `Review ${index}`);
        run = manager.start(created.id, owner);
      }
      expect(run.events).toHaveLength(500);
      expect(run.events[0]!.seq).toBeGreaterThan(1);
      const page = manager.eventsSince(created.id, 0, 500);
      expect(page.events).toHaveLength(200);
      expect(page.hasMore).toBe(true);

      const changedPaths = Array.from({ length: 200 }, (_, index) => `src/${'x'.repeat(100)}-${index}.ts`);
      const bounded = advanceToVerification(manager, created.id, changedPaths);
      const implementationEvent = bounded.events.find((event) => event.type === 'implementation.updated')!;
      expect(implementationEvent.data).toMatchObject({ truncated: true });
      expect(implementationEvent.type).toBe('implementation.updated');
      expect(JSON.stringify(implementationEvent.data ?? {}).length).toBeLessThanOrEqual(4_000);
      expect(bounded.phase).toBe('verification');

      const path = join(root, '.folderforge', 'agent-loops', 'runs', `${created.id}.json`);
      const legacy = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      delete legacy.events;
      const { integritySha256: _oldIntegrity, ...unsigned } = legacy;
      legacy.integritySha256 = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
      writeFileSync(path, JSON.stringify(legacy, null, 2));
      const restarted = new AgentLoopManager(root);
      expect(restarted.get(created.id, owner).events).toEqual([]);
    });

    it('fails closed when a persisted run is tampered with', () => {
      const manager = new AgentLoopManager(root);
      const created = manager.create({
        title: 'Tamper loop',
        goal: 'Reject modified durable state.',
        acceptanceCriteria: ['Integrity is enforced'],
      }, owner);
      const path = join(root, '.folderforge', 'agent-loops', 'runs', `${created.id}.json`);
      const persisted = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      persisted.goal = 'attacker changed the goal';
      writeFileSync(path, JSON.stringify(persisted, null, 2));

      expect(() => manager.get(created.id, owner)).toThrow(/integrity check failed/i);
    });
});
