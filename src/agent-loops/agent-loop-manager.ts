import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ToolPrincipal } from '../core/types.js';

export type AgentLoopPhase = 'discovery' | 'council' | 'implementation' | 'verification' | 'completed' | 'paused' | 'failed' | 'cancelled';
export type AgentLoopState = 'created' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface AgentLoopExpert {
  id: string;
  role: string;
  weight: number;
  model?: string;
}

export interface AgentLoopProposal {
  id: string;
  iteration: number;
  expertId: string;
  phase: 'discovery' | 'council';
  summary: string;
  plan: string[];
  risks: string[];
  evidence: string[];
  createdAt: number;
}

export interface AgentLoopVote {
  id: string;
  iteration: number;
  expertId: string;
  proposalId: string;
  score: number;
  approve: boolean;
  rationale: string;
  createdAt: number;
}

export interface AgentLoopDecision {
  proposalId: string;
  consensus: number;
  approvalRate: number;
  voteCount: number;
  decidedAt: number;
  ranked: Array<{ proposalId: string; consensus: number; approvalRate: number; voteCount: number }>;
}

export interface AgentLoopVerification {
  passed: boolean;
  criteria: Array<{ name: string; passed: boolean; evidence?: string }>;
  checks: string[];
  notes?: string;
  recordedAt: number;
  proofPack?: { id: string; manifestSha256: string; verified: boolean };
}

export interface AgentLoopEvent {
  seq: number;
  type: string;
  phase: AgentLoopPhase;
  iteration: number;
  message: string;
  data?: Record<string, unknown>;
  recordedAt: number;
}

export interface AgentLoopRun {
  schemaVersion: 1;
  id: string;
  revision: number;
  integritySha256: string;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  projectRoot: string;
  ownerId: string;
  /** Optional client/session binding captured when the loop is created. */
  clientId?: string;
  sessionId?: string;
  /** Durable task identity used to correlate approvals and audit evidence. */
  taskId?: string;
  /** SHA-256 of the one accepted background-run idempotency key. */
  runInvocationKeyHash?: string;
  experts: AgentLoopExpert[];
  councilMinVotes: number;
  councilThreshold: number;
  maxIterations: number;
  iteration: number;
  phase: AgentLoopPhase;
  state: AgentLoopState;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  pauseReason?: string;
  failure?: string;
  proposals: AgentLoopProposal[];
  votes: AgentLoopVote[];
  events: AgentLoopEvent[];
  decision?: AgentLoopDecision;
  implementation?: {
    status: 'running' | 'completed' | 'blocked';
    summary: string;
    changedPaths: string[];
    recordedAt: number;
  };
  verification?: AgentLoopVerification;
}

export interface AgentLoopView extends Omit<AgentLoopRun, 'integritySha256'> {
  integritySha256?: never;
  currentIterationProposals: AgentLoopProposal[];
  currentIterationVotes: AgentLoopVote[];
  goalGate: { satisfied: boolean; passedCriteria: number; totalCriteria: number };
}

const MAX_TEXT = 8_000;
const MAX_ITEMS = 50;
const MAX_EVENTS = 500;
const MAX_EVENT_DATA = 4_000;
const DEFAULT_EXPERTS: AgentLoopExpert[] = [
  { id: 'architect', role: 'architecture and systems design', weight: 1.2 },
  { id: 'security', role: 'security and threat modeling', weight: 1.2 },
  { id: 'implementer', role: 'implementation and maintainability', weight: 1 },
  { id: 'qa', role: 'testing and verification', weight: 1 },
];

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cleanItems(value: unknown, max = MAX_ITEMS): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].slice(0, max).map((item) => item.slice(0, 2_000));
}

function ownerId(principal: ToolPrincipal): string {
  return principal.id || 'local:unknown';
}

function unsigned(run: AgentLoopRun): Omit<AgentLoopRun, 'integritySha256'> {
  const { integritySha256: _integrity, ...rest } = run;
  return rest;
}

function isTerminal(run: AgentLoopRun): boolean {
  return run.state === 'completed' || run.state === 'failed' || run.state === 'cancelled';
}

function boundedEventData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const serialized = JSON.stringify(data);
  if (serialized.length <= MAX_EVENT_DATA) return clone(data);

  let preview = serialized.slice(0, MAX_EVENT_DATA);
  let bounded: Record<string, unknown> = { truncated: true, preview };
  while (JSON.stringify(bounded).length > MAX_EVENT_DATA && preview.length > 0) {
    preview = preview.slice(0, Math.max(0, preview.length - 64));
    bounded = { truncated: true, preview };
  }
  return bounded;
}

export class AgentLoopManager {
  private readonly root: string;
  private readonly runsDir: string;

  constructor(private readonly projectRoot: string) {
    this.root = join(projectRoot, '.folderforge', 'agent-loops');
    this.runsDir = join(this.root, 'runs');
  }

  create(input: {
    title: string;
    goal: string;
    acceptanceCriteria: string[];
    experts?: AgentLoopExpert[];
    councilMinVotes?: number;
    councilThreshold?: number;
    maxIterations?: number;
    projectRoot?: string;
  }, principal: ToolPrincipal): AgentLoopRun {
    const title = String(input.title ?? '').trim();
    const goal = String(input.goal ?? '').trim();
    if (!title || !goal) throw new Error('title and goal are required.');
    const criteria = cleanItems(input.acceptanceCriteria);
    if (criteria.length === 0) throw new Error('At least one acceptance criterion is required.');
    const experts = (Array.isArray(input.experts) && input.experts.length ? input.experts : DEFAULT_EXPERTS)
      .map((expert) => ({
        id: String(expert.id).trim(),
        role: String(expert.role).trim().slice(0, 500),
        weight: Number(expert.weight ?? 1),
        ...(expert.model ? { model: String(expert.model).slice(0, 256) } : {}),
      }))
      .filter((expert) => expert.id && expert.role && Number.isFinite(expert.weight) && expert.weight > 0);
    if (experts.length < 2) throw new Error('At least two experts are required for council review.');
    const ids = new Set<string>();
    for (const expert of experts) {
      if (ids.has(expert.id)) throw new Error(`Duplicate expert id: ${expert.id}`);
      ids.add(expert.id);
    }
    const now = Date.now();
    const run: AgentLoopRun = {
      schemaVersion: 1,
      id: `loop_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      revision: 0,
      integritySha256: '',
      title: title.slice(0, 500),
      goal: goal.slice(0, MAX_TEXT),
      acceptanceCriteria: criteria,
      projectRoot: input.projectRoot ? String(input.projectRoot) : this.projectRoot,
      ownerId: ownerId(principal),
      ...(principal.oauthClientId ? { clientId: principal.oauthClientId } : {}),
      ...(principal.sessionId ? { sessionId: principal.sessionId } : {}),
      ...(principal.taskId ? { taskId: principal.taskId } : {}),
      experts,
      councilMinVotes: Math.max(2, Math.min(experts.length, Math.floor(Number(input.councilMinVotes ?? Math.min(3, experts.length))))),
      councilThreshold: Math.max(0.5, Math.min(1, Number(input.councilThreshold ?? 0.7))),
      maxIterations: Math.max(1, Math.min(100, Math.floor(Number(input.maxIterations ?? 20)))),
      iteration: 1,
      phase: 'discovery',
      state: 'created',
      createdAt: now,
      updatedAt: now,
      proposals: [],
      votes: [],
      events: [],
    };
    this.appendEvent(run, 'created', 'Agent loop created.');
    return this.save(run);
  }

  get(id: string, principal?: ToolPrincipal): AgentLoopRun {
    if (!/^loop_[a-z0-9]+$/i.test(id)) throw new Error('Invalid agent loop id.');
    const path = join(this.runsDir, `${id}.json`);
    if (!existsSync(path)) throw new Error(`Agent loop not found: ${id}`);
    const run = JSON.parse(readFileSync(path, 'utf8')) as AgentLoopRun;
    if (run.id !== id || run.schemaVersion !== 1 || hash(unsigned(run)) !== run.integritySha256) {
      throw new Error(`Agent loop integrity check failed: ${id}`);
    }
    run.events ??= [];
    if (principal && principal.role !== 'admin' && run.ownerId !== ownerId(principal)) {
      throw new Error(`Agent loop access denied for principal ${ownerId(principal)}.`);
    }
      if (principal && principal.role !== 'admin' && run.clientId && run.clientId !== principal.oauthClientId) {
        throw new Error(`Agent loop client binding mismatch for ${id}.`);
      }
      if (principal && principal.role !== 'admin' && run.sessionId && run.sessionId !== principal.sessionId) {
        throw new Error(`Agent loop session binding mismatch for ${id}.`);
      }
      if (principal && principal.role !== 'admin' && run.taskId && run.taskId !== principal.taskId) {
        throw new Error(`Agent loop task binding mismatch for ${id}.`);
      }
    return run;
  }

  view(run: AgentLoopRun): AgentLoopView {
    const criteria = run.verification?.criteria ?? [];
    return {
      ...clone(unsigned(run)),
      currentIterationProposals: run.proposals.filter((proposal) => proposal.iteration === run.iteration),
      currentIterationVotes: run.votes.filter((vote) => vote.iteration === run.iteration),
      goalGate: {
        satisfied: Boolean(run.verification?.passed && criteria.length > 0 && criteria.every((item) => item.passed)),
        passedCriteria: criteria.filter((item) => item.passed).length,
        totalCriteria: criteria.length || run.acceptanceCriteria.length,
      },
    };
  }

  list(principal?: ToolPrincipal, limit = 100): AgentLoopView[] {
    if (!existsSync(this.runsDir)) return [];
    return readdirSync(this.runsDir)
      .filter((name) => /^loop_[a-z0-9]+\.json$/i.test(name))
      .map((name) => {
        try { return this.view(this.get(name.slice(0, -5), principal)); } catch { return null; }
      })
      .filter((item): item is AgentLoopView => item !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, Math.min(200, limit)));
  }

  eventsSince(id: string, after = 0, limit = 100, principal?: ToolPrincipal): { events: AgentLoopEvent[]; latestSeq: number; hasMore: boolean } {
    const run = this.get(id, principal);
    const safeAfter = Math.max(0, Math.floor(Number(after) || 0));
    const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
    const pending = run.events.filter((event) => event.seq > safeAfter);
    return {
      events: clone(pending.slice(0, safeLimit)),
      latestSeq: run.events.at(-1)?.seq ?? safeAfter,
      hasMore: pending.length > safeLimit,
    };
  }

  claimRunInvocation(id: string, idempotencyKey: string, principal: ToolPrincipal): AgentLoopRun {
    const run = this.get(id, principal);
    const key = String(idempotencyKey).trim();
    if (!key || key.length > 256) throw new Error('idempotencyKey must be 1-256 characters.');
    const keyHash = hash(key);
    if (run.runInvocationKeyHash) {
      if (run.runInvocationKeyHash !== keyHash) {
        throw new Error(`Agent loop ${id} was already started with a different idempotency key.`);
      }
      return run;
    }
    if (isTerminal(run)) throw new Error(`Agent loop ${id} is terminal (${run.state}).`);
    run.runInvocationKeyHash = keyHash;
    this.appendEvent(run, 'run.claimed', 'Background run accepted idempotently.', { keyHash: keyHash.slice(0, 16) });
    return this.save(run);
  }

  start(id: string, principal: ToolPrincipal): AgentLoopRun {
    const run = this.get(id, principal);
    if (isTerminal(run)) throw new Error(`Agent loop ${id} is terminal (${run.state}).`);
    const wasPaused = run.state === 'paused';
    run.state = 'running';
    run.phase = run.phase === 'paused' ? 'discovery' : run.phase;
    delete run.pauseReason;
    run.startedAt ??= Date.now();
    this.appendEvent(run, wasPaused ? 'resumed' : 'started', wasPaused ? 'Agent loop resumed.' : 'Agent loop started.');
    return this.save(run);
  }

  pause(id: string, principal: ToolPrincipal, reason = 'Paused by operator.'): AgentLoopRun {
    const run = this.get(id, principal);
    if (isTerminal(run)) throw new Error(`Agent loop ${id} is terminal (${run.state}).`);
    run.state = 'paused';
    run.phase = 'paused';
    run.pauseReason = String(reason).trim().slice(0, 2_000) || 'Paused by operator.';
    this.appendEvent(run, 'paused', run.pauseReason);
    return this.save(run);
  }

  cancel(id: string, principal: ToolPrincipal, reason = 'Cancelled by operator.'): AgentLoopRun {
    const run = this.get(id, principal);
    if (isTerminal(run)) return run;
    run.state = 'cancelled';
    run.phase = 'cancelled';
    run.pauseReason = String(reason).trim().slice(0, 2_000) || 'Cancelled by operator.';
    run.completedAt = Date.now();
    this.appendEvent(run, 'cancelled', run.pauseReason);
    return this.save(run);
  }

  recordRunnerError(id: string, principal: ToolPrincipal, error: string): AgentLoopRun {
    const run = this.get(id, principal);
    if (isTerminal(run)) return run;
    const message = String(error).trim().slice(0, 2_000) || 'Unknown runner error.';
    run.state = 'paused';
    run.phase = 'paused';
    run.pauseReason = `Runner stopped safely: ${message}`;
    this.appendEvent(run, 'runner.error', run.pauseReason, { error: message });
    return this.save(run);
  }

  submitProposal(id: string, input: {
    expertId: string;
    phase?: 'discovery' | 'council';
    summary: string;
    plan?: string[];
    risks?: string[];
    evidence?: string[];
  }, principal: ToolPrincipal): AgentLoopRun {
    const run = this.get(id, principal);
    if (run.state !== 'running' || (run.phase !== 'discovery' && run.phase !== 'council')) throw new Error('Proposals are accepted only during a running discovery/council phase.');
    const expert = run.experts.find((item) => item.id === input.expertId);
    if (!expert) throw new Error(`Unknown expert: ${input.expertId}`);
    const summary = String(input.summary ?? '').trim();
    if (!summary) throw new Error('Proposal summary is required.');
    const proposal: AgentLoopProposal = {
      id: `prop_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      iteration: run.iteration,
      expertId: expert.id,
      phase: input.phase ?? run.phase,
      summary: summary.slice(0, MAX_TEXT),
      plan: cleanItems(input.plan),
      risks: cleanItems(input.risks),
      evidence: cleanItems(input.evidence),
      createdAt: Date.now(),
    };
    run.proposals.push(proposal);
    if (run.phase === 'discovery') run.phase = 'council';
    this.appendEvent(run, 'proposal.submitted', `Proposal submitted by ${expert.id}.`, { proposalId: proposal.id, expertId: expert.id });
    return this.save(run);
  }

  submitVote(id: string, input: { expertId: string; proposalId: string; score: number; approve: boolean; rationale?: string }, principal: ToolPrincipal): AgentLoopRun {
    const run = this.get(id, principal);
    if (run.state !== 'running' || run.phase !== 'council') throw new Error('Votes are accepted only during a running council phase.');
    if (!run.experts.some((expert) => expert.id === input.expertId)) throw new Error(`Unknown expert: ${input.expertId}`);
    const proposal = run.proposals.find((item) => item.id === input.proposalId && item.iteration === run.iteration);
    if (!proposal) throw new Error(`Proposal not found in current iteration: ${input.proposalId}`);
    const score = Number(input.score);
    if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error('Vote score must be between 0 and 1.');
    run.votes = run.votes.filter((vote) => !(vote.iteration === run.iteration && vote.expertId === input.expertId));
    run.votes.push({
      id: `vote_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      iteration: run.iteration,
      expertId: input.expertId,
      proposalId: proposal.id,
      score,
      approve: Boolean(input.approve),
      rationale: String(input.rationale ?? '').trim().slice(0, MAX_TEXT),
      createdAt: Date.now(),
    });
    this.appendEvent(run, 'vote.submitted', `Vote submitted by ${input.expertId}.`, { expertId: input.expertId, proposalId: proposal.id, score, approve: Boolean(input.approve) });
    return this.save(run);
  }

  decide(id: string, principal: ToolPrincipal): AgentLoopRun {
    const run = this.get(id, principal);
    if (run.state !== 'running' || run.phase !== 'council') throw new Error('Council decision requires the running council phase.');
    const proposals = run.proposals.filter((proposal) => proposal.iteration === run.iteration);
    const votes = run.votes.filter((vote) => vote.iteration === run.iteration);
    if (proposals.length === 0) throw new Error('Council cannot decide without proposals.');
    if (votes.length < run.councilMinVotes) throw new Error(`Council quorum not reached: ${votes.length}/${run.councilMinVotes} votes.`);
    const ranked = proposals.map((proposal) => {
      const proposalVotes = votes.filter((vote) => vote.proposalId === proposal.id);
      const weighted = proposalVotes.reduce((total, vote) => {
        const expert = run.experts.find((item) => item.id === vote.expertId);
        return total + vote.score * (expert?.weight ?? 1);
      }, 0);
      const weight = proposalVotes.reduce((total, vote) => total + (run.experts.find((item) => item.id === vote.expertId)?.weight ?? 1), 0);
      const approvals = proposalVotes.filter((vote) => vote.approve).length;
      return {
        proposalId: proposal.id,
        consensus: weight ? weighted / weight : 0,
        approvalRate: proposalVotes.length ? approvals / proposalVotes.length : 0,
        voteCount: proposalVotes.length,
      };
    }).sort((a, b) => b.consensus - a.consensus || b.approvalRate - a.approvalRate || b.voteCount - a.voteCount);
    const winner = ranked[0]!;
    if (winner.consensus < run.councilThreshold || winner.approvalRate < 0.5) {
      throw new Error(`No consensus reached: winner=${winner.consensus.toFixed(2)}, approval=${winner.approvalRate.toFixed(2)}, threshold=${run.councilThreshold.toFixed(2)}.`);
    }
    run.decision = { ...winner, decidedAt: Date.now(), ranked };
    run.phase = 'implementation';
    this.appendEvent(run, 'council.decided', `Council selected proposal ${winner.proposalId}.`, { proposalId: winner.proposalId, consensus: winner.consensus, approvalRate: winner.approvalRate, voteCount: winner.voteCount });
    return this.save(run);
  }

  recordImplementation(id: string, input: { status: 'running' | 'completed' | 'blocked'; summary: string; changedPaths?: string[] }, principal: ToolPrincipal): AgentLoopRun {
    const run = this.get(id, principal);
    if (run.state !== 'running' || run.phase !== 'implementation') throw new Error('Implementation update requires the running implementation phase.');
    run.implementation = {
      status: input.status,
      summary: String(input.summary ?? '').trim().slice(0, MAX_TEXT),
      changedPaths: cleanItems(input.changedPaths, 200),
      recordedAt: Date.now(),
    };
    if (input.status === 'completed') run.phase = 'verification';
    if (input.status === 'blocked') { run.state = 'paused'; run.phase = 'paused'; run.pauseReason = 'Implementation reported a blocker.'; }
    this.appendEvent(run, 'implementation.updated', `Implementation status: ${input.status}.`, { status: input.status, changedPaths: run.implementation.changedPaths });
    return this.save(run);
  }

  recordVerification(id: string, input: { passed: boolean; criteria: Array<{ name: string; passed: boolean; evidence?: string }>; checks?: string[]; notes?: string; proofPack?: { id: string; manifestSha256: string; verified: boolean } }, principal: ToolPrincipal): AgentLoopRun {
    const run = this.get(id, principal);
    if (run.state !== 'running' || run.phase !== 'verification') throw new Error('Verification requires the running verification phase.');
    const criteria = (Array.isArray(input.criteria) ? input.criteria : []).map((item) => ({ name: String(item.name).trim().slice(0, 500), passed: Boolean(item.passed), ...(item.evidence ? { evidence: String(item.evidence).slice(0, 2_000) } : {}) })).filter((item) => item.name);
    const passed = Boolean(input.passed) && criteria.length >= run.acceptanceCriteria.length && criteria.every((item) => item.passed);
    run.verification = { passed, criteria, checks: cleanItems(input.checks, 100), ...(input.notes ? { notes: String(input.notes).slice(0, MAX_TEXT) } : {}), ...(input.proofPack ? { proofPack: input.proofPack } : {}), recordedAt: Date.now() };
    if (passed) {
      run.state = 'completed';
      run.phase = 'completed';
      run.completedAt = Date.now();
      delete run.failure;
    } else if (run.iteration >= run.maxIterations) {
      run.state = 'failed';
      run.phase = 'failed';
      run.failure = 'Goal gate failed after maxIterations.';
      run.completedAt = Date.now();
    } else {
      run.iteration += 1;
      run.phase = 'discovery';
      delete run.decision;
      delete run.implementation;
      run.pauseReason = 'Verification failed; loop returned to discovery.';
    }
    this.appendEvent(run, passed ? 'verification.passed' : (run.state === 'failed' ? 'verification.failed' : 'verification.retry'), passed ? 'Verification passed the goal gate.' : (run.state === 'failed' ? 'Verification failed after the iteration limit.' : 'Verification failed; retrying the loop.'), { passed, criteriaPassed: criteria.filter((item) => item.passed).length, criteriaTotal: criteria.length, iteration: run.iteration });
    return this.save(run);
  }

  private appendEvent(run: AgentLoopRun, type: string, message: string, data?: Record<string, unknown>): void {
    run.events ??= [];
    const event: AgentLoopEvent = {
      seq: (run.events.at(-1)?.seq ?? 0) + 1,
      type: String(type).slice(0, 120),
      phase: run.phase,
      iteration: run.iteration,
      message: String(message).trim().slice(0, 2_000),
      recordedAt: Date.now(),
    };
    const eventData = { ...(data ?? {}), ...(run.taskId ? { taskId: run.taskId } : {}) };
    const bounded = Object.keys(eventData).length > 0 ? boundedEventData(eventData) : undefined;
    if (bounded) event.data = bounded;
    run.events.push(event);
    if (run.events.length > MAX_EVENTS) run.events = run.events.slice(-MAX_EVENTS);
  }

  private save(run: AgentLoopRun): AgentLoopRun {
    mkdirSync(this.runsDir, { recursive: true });
    run.updatedAt = Date.now();
    run.revision += 1;
    run.integritySha256 = hash(unsigned(run));
    const path = join(this.runsDir, `${run.id}.json`);
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(run, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, path);
    return run;
  }
}
