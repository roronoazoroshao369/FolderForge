import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ToolContentBlock, ToolPrincipal, ToolResult } from '../core/types.js';
import { logger } from '../core/logger.js';

export type WorkflowState =
  | 'created'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type WorkflowStepState =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'skipped';

export interface WorkflowRole {
  allowedTools: string[];
  description?: string;
}

export interface WorkflowExpectation {
  path: string;
  equals?: unknown;
  exists?: boolean;
}

export interface WorkflowStepDefinition {
  id: string;
  role: string;
  tool: string;
  args?: Record<string, unknown>;
  dependsOn?: string[];
  continueOnError?: boolean;
  expect?: WorkflowExpectation;
  description?: string;
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  roles: Record<string, WorkflowRole>;
  steps: WorkflowStepDefinition[];
}

export interface WorkflowOwnerBinding {
  principalId: string;
  projectId?: string;
  clientId?: string;
  createdSessionId?: string;
  createdCapsuleId?: string;
}

export interface WorkflowTaskMetadata {
  objective: string;
  acceptanceCriteria: string[];
  isolationId?: string;
  knownLimitations: string[];
}

export interface WorkflowHandoff {
  targetPrincipalId: string;
  tokenSha256: string;
  createdAt: number;
  expiresAt: number;
}

export interface WorkflowProofPackRef {
  id: string;
  manifestSha256: string;
  createdAt: string;
}

export interface WorkflowEvidence {
  ok: boolean;
  data?: unknown;
  error?: string;
  diff?: string;
  approvalId?: string;
  content?: Array<Record<string, unknown>>;
  truncated?: boolean;
}

export interface WorkflowStepRun {
  id: string;
  role: string;
  tool: string;
  state: WorkflowStepState;
  attempts: number;
  startedAt?: number;
  completedAt?: number;
  approvalId?: string;
  resolvedArgs?: Record<string, unknown>;
  evidence?: WorkflowEvidence;
  note?: string;
}

export interface WorkflowRun {
  schemaVersion: 2;
  id: string;
  revision: number;
  integritySha256: string;
  definition: WorkflowDefinition;
  definitionHash: string;
  projectRoot: string;
  owner: WorkflowOwnerBinding;
  task: WorkflowTaskMetadata;
  handoff?: WorkflowHandoff;
  proofPacks: WorkflowProofPackRef[];
  state: WorkflowState;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  currentStepId?: string;
  pauseReason?: string;
  failure?: string;
  steps: WorkflowStepRun[];
}

export interface WorkflowRunView {
  id: string;
  name: string;
  description?: string;
  definitionHash: string;
  projectRoot: string;
  owner: WorkflowOwnerBinding;
  task: WorkflowTaskMetadata;
  handoff?: Omit<WorkflowHandoff, 'tokenSha256'>;
  proofPacks: WorkflowProofPackRef[];
  state: WorkflowState;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  currentStepId?: string;
  pauseReason?: string;
  failure?: string;
  roles: Record<string, WorkflowRole>;
  steps: WorkflowStepRun[];
}

const MAX_STEPS = 50;
const MAX_DEFINITION_BYTES = 256_000;
const MAX_STEP_ARGS_BYTES = 64_000;
const MAX_EVIDENCE_BYTES = 64_000;
const MAX_TEXT_CONTENT = 8_000;
const MAX_ACCEPTANCE_CRITERIA = 50;
const MAX_LIMITATIONS = 50;
const DEFAULT_HANDOFF_TTL_MS = 15 * 60 * 1000;
const MAX_HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_LOCK_MS = 5 * 60 * 1000;

function ownerBinding(principal: ToolPrincipal): WorkflowOwnerBinding {
  return {
    principalId: principal.id,
    ...(principal.projectId ? { projectId: principal.projectId } : {}),
    ...(principal.oauthClientId ? { clientId: principal.oauthClientId } : {}),
    ...(principal.sessionId ? { createdSessionId: principal.sessionId } : {}),
    ...(principal.capsuleId ? { createdCapsuleId: principal.capsuleId } : {}),
  };
}

function ownerMatches(owner: WorkflowOwnerBinding, principal: ToolPrincipal): boolean {
  if (principal.role === 'admin') return true;
  if (owner.principalId !== principal.id) return false;
  if (owner.projectId && owner.projectId !== principal.projectId) return false;
  if (owner.clientId && owner.clientId !== principal.oauthClientId) return false;
  return true;
}

function taskMetadata(
  definition: WorkflowDefinition,
  value: Partial<WorkflowTaskMetadata> = {},
): WorkflowTaskMetadata {
  const objective = String(value.objective ?? definition.description ?? definition.name).trim();
  if (!objective) throw new Error('workflow objective is required.');
  const criteria = [...new Set((value.acceptanceCriteria ?? []).map((item) => String(item).trim()).filter(Boolean))];
  const limitations = [...new Set((value.knownLimitations ?? []).map((item) => String(item).trim()).filter(Boolean))];
  if (criteria.length > MAX_ACCEPTANCE_CRITERIA) throw new Error(`acceptanceCriteria exceeds ${MAX_ACCEPTANCE_CRITERIA} items.`);
  if (limitations.length > MAX_LIMITATIONS) throw new Error(`knownLimitations exceeds ${MAX_LIMITATIONS} items.`);
  return {
    objective: objective.slice(0, 8_000),
    acceptanceCriteria: criteria.map((item) => item.slice(0, 2_000)),
    ...(value.isolationId ? { isolationId: String(value.isolationId) } : {}),
    knownLimitations: limitations.map((item) => item.slice(0, 2_000)),
  };
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function runIntegrity(run: WorkflowRun): string {
  const { integritySha256: _integrity, ...unsigned } = run;
  return createHash('sha256').update(stable(unsigned)).digest('hex');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function simpleHash(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function getPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let current = value;
  for (const segment of path.split('.').filter(Boolean)) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
    } else if (current && typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function sanitizeJson(value: unknown, redact: (text: string) => string): {
  value: unknown;
  truncated: boolean;
} {
  if (value === undefined) return { value: undefined, truncated: false };
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return { value: '[unserializable]', truncated: true };
  }
  const redacted = redact(text);
  if (Buffer.byteLength(redacted) <= MAX_EVIDENCE_BYTES) {
    try {
      return { value: JSON.parse(redacted), truncated: false };
    } catch {
      return { value: redacted, truncated: false };
    }
  }
  return {
    value: {
      truncated: true,
      originalBytes: Buffer.byteLength(redacted),
      preview: redacted.slice(0, MAX_EVIDENCE_BYTES),
    },
    truncated: true,
  };
}

function contentEvidence(
  content: ToolContentBlock[] | undefined,
  redact: (text: string) => string
): Array<Record<string, unknown>> | undefined {
  if (!content?.length) return undefined;
  return content.map((block) => {
    if (block.kind === 'text') {
      return { kind: 'text', text: redact(block.text).slice(0, MAX_TEXT_CONTENT) };
    }
    if (block.kind === 'image') {
      return { kind: 'image', mimeType: block.mimeType, bytesApprox: Math.floor(block.data.length * 0.75) };
    }
    if (block.kind === 'resource') {
      return {
        kind: 'resource',
        uri: block.uri,
        ...(block.title ? { title: block.title } : {}),
        ...(block.mimeType ? { mimeType: block.mimeType } : {}),
        text: redact(block.text).slice(0, MAX_TEXT_CONTENT),
      };
    }
    return {
      kind: 'resource_link',
      uri: block.uri,
      ...(block.name ? { name: block.name } : {}),
      ...(block.title ? { title: block.title } : {}),
      ...(block.description ? { description: block.description } : {}),
      ...(block.mimeType ? { mimeType: block.mimeType } : {}),
    };
  });
}

export function workflowEvidence(
  result: ToolResult,
  redact: (text: string) => string
): WorkflowEvidence {
  const data = sanitizeJson(result.data, redact);
  const content = contentEvidence(result.content, redact);
  return {
    ok: result.ok,
    ...(data.value !== undefined ? { data: data.value } : {}),
    ...(result.error ? { error: redact(result.error).slice(0, MAX_TEXT_CONTENT) } : {}),
    ...(result.diff ? { diff: redact(result.diff).slice(0, MAX_TEXT_CONTENT) } : {}),
    ...(result.approvalId ? { approvalId: result.approvalId } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(data.truncated ? { truncated: true } : {}),
  };
}

export function resolveWorkflowValue(value: unknown, run: WorkflowRun): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveWorkflowValue(item, run));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (typeof record.$step === 'string') {
    const step = run.steps.find((item) => item.id === record.$step);
    if (!step?.evidence) throw new Error(`Workflow reference step has no evidence: ${record.$step}`);
    const selected = getPath(step.evidence, String(record.path ?? 'data'));
    if (selected === undefined) {
      throw new Error(`Workflow reference not found: ${record.$step}.${String(record.path ?? 'data')}`);
    }
    return selected;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, resolveWorkflowValue(item, run)])
  );
}

export function checkWorkflowExpectation(
  expectation: WorkflowExpectation | undefined,
  evidence: WorkflowEvidence
): { passed: boolean; reason?: string } {
  if (!expectation) return { passed: true };
  const actual = getPath(evidence, expectation.path);
  if (expectation.exists !== undefined) {
    const exists = actual !== undefined;
    if (exists !== expectation.exists) {
      return { passed: false, reason: `Expectation ${expectation.path} exists=${expectation.exists}; actual=${exists}.` };
    }
  }
  if (Object.prototype.hasOwnProperty.call(expectation, 'equals') && stable(actual) !== stable(expectation.equals)) {
    return {
      passed: false,
      reason: `Expectation ${expectation.path}=${stable(expectation.equals)}; actual=${stable(actual)}.`,
    };
  }
  return { passed: true };
}

export function validateWorkflowDefinition(
  value: unknown,
  availableTools: Set<string>
): WorkflowDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('definition must be an object.');
  }
  const definition = value as WorkflowDefinition;
  if (typeof definition.name !== 'string' || !definition.name.trim()) {
    throw new Error('definition.name is required.');
  }
  if (!definition.roles || typeof definition.roles !== 'object' || Array.isArray(definition.roles)) {
    throw new Error('definition.roles must be an object.');
  }
  if (!Array.isArray(definition.steps) || definition.steps.length < 1 || definition.steps.length > MAX_STEPS) {
    throw new Error(`definition.steps must contain 1-${MAX_STEPS} steps.`);
  }
  if (Buffer.byteLength(JSON.stringify(definition)) > MAX_DEFINITION_BYTES) {
    throw new Error(`Workflow definition exceeds ${MAX_DEFINITION_BYTES} bytes.`);
  }

  const roleNames = new Set(Object.keys(definition.roles));
  for (const [name, role] of Object.entries(definition.roles)) {
    if (!/^[a-z][a-z0-9_-]{0,62}$/i.test(name)) throw new Error(`Invalid workflow role: ${name}`);
    if (!role || !Array.isArray(role.allowedTools) || role.allowedTools.length === 0) {
      throw new Error(`Role ${name} must declare allowedTools.`);
    }
    for (const tool of role.allowedTools) {
      if (typeof tool !== 'string' || tool.startsWith('workflow_')) {
        throw new Error(`Role ${name} contains an invalid or recursive tool: ${String(tool)}`);
      }
      if (!availableTools.has(tool)) throw new Error(`Role ${name} references unknown tool: ${tool}`);
    }
  }

  const ids = new Set<string>();
  for (const step of definition.steps) {
    if (!step || typeof step !== 'object') throw new Error('Each workflow step must be an object.');
    if (!/^[a-z][a-z0-9_-]{0,62}$/i.test(step.id)) throw new Error(`Invalid workflow step id: ${step.id}`);
    if (ids.has(step.id)) throw new Error(`Duplicate workflow step id: ${step.id}`);
    ids.add(step.id);
    if (!roleNames.has(step.role)) throw new Error(`Step ${step.id} references unknown role: ${step.role}`);
    if (!availableTools.has(step.tool) || step.tool.startsWith('workflow_')) {
      throw new Error(`Step ${step.id} references unknown or recursive tool: ${step.tool}`);
    }
    if (!definition.roles[step.role]!.allowedTools.includes(step.tool)) {
      throw new Error(`Role ${step.role} is not allowed to call ${step.tool} (step ${step.id}).`);
    }
    if (Buffer.byteLength(JSON.stringify(step.args ?? {})) > MAX_STEP_ARGS_BYTES) {
      throw new Error(`Step ${step.id} args exceed ${MAX_STEP_ARGS_BYTES} bytes.`);
    }
    if (step.expect && typeof step.expect.path !== 'string') {
      throw new Error(`Step ${step.id} expectation requires a path.`);
    }
  }

  const graph = new Map<string, string[]>();
  for (const step of definition.steps) {
    const deps = step.dependsOn ?? [];
    for (const dep of deps) {
      if (!ids.has(dep)) throw new Error(`Step ${step.id} depends on unknown step: ${dep}`);
      if (dep === step.id) throw new Error(`Step ${step.id} cannot depend on itself.`);
    }
    graph.set(step.id, deps);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Workflow dependency cycle detected at ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of graph.get(id) ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);

  return JSON.parse(JSON.stringify(definition)) as WorkflowDefinition;
}

export class WorkflowManager {
  private root: string;
  private runsDir: string;

  constructor(private projectRoot: string) {
    this.root = join(projectRoot, '.folderforge', 'workflows');
    this.runsDir = join(this.root, 'runs');
  }

  create(
    definition: WorkflowDefinition,
    principal: ToolPrincipal = { id: 'agent:unknown', role: 'agent' },
    metadata: Partial<WorkflowTaskMetadata> = {},
  ): WorkflowRun {
    this.ensureStore();
    const now = Date.now();
    const run: WorkflowRun = {
      schemaVersion: 2,
      id: `wf_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      revision: 0,
      integritySha256: '',
      definition,
      definitionHash: simpleHash(stable(definition)),
      projectRoot: this.projectRoot,
      owner: ownerBinding(principal),
      task: taskMetadata(definition, metadata),
      proofPacks: [],
      state: 'created',
      createdAt: now,
      updatedAt: now,
      steps: definition.steps.map((step) => ({
        id: step.id,
        role: step.role,
        tool: step.tool,
        state: 'pending',
        attempts: 0,
      })),
    };
    this.save(run);
    return run;
  }

  get(id: string, principal?: ToolPrincipal): WorkflowRun {
    if (!/^wf_[a-z0-9]+$/i.test(id)) throw new Error('Invalid workflow run id.');
    const path = join(this.runsDir, `${id}.json`);
    if (!existsSync(path)) throw new Error(`Workflow run not found: ${id}`);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const run = this.normalizeRun(raw, id);
    if (principal && !ownerMatches(run.owner, principal)) {
      throw new Error(`Workflow access denied for principal ${principal.id}.`);
    }
    return run;
  }

  list(
    principal?: ToolPrincipal,
    limit = 50,
  ): WorkflowRunView[] {
    if (!existsSync(this.runsDir)) return [];
    return readdirSync(this.runsDir)
      .filter((name) => /^wf_[a-z0-9]+\.json$/i.test(name))
      .map((name) => {
        try {
          const run = this.get(name.slice(0, -5));
          if (principal && !ownerMatches(run.owner, principal)) return null;
          return this.view(run);
        } catch {
          return null;
        }
      })
      .filter((item): item is WorkflowRunView => item !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.min(200, Math.max(1, limit)));
  }

  save(run: WorkflowRun): void {
    this.ensureStore();
    if (run.projectRoot !== this.projectRoot) throw new Error('Workflow project root mismatch.');
    const path = join(this.runsDir, `${run.id}.json`);
    if (existsSync(path)) {
      const currentRaw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const current = this.normalizeRun(currentRaw, run.id);
      if (current.revision !== run.revision) {
        throw new Error(
          `Workflow state changed concurrently: expected revision ${run.revision}, current ${current.revision}.`,
        );
      }
    }
    run.updatedAt = Date.now();
    run.revision += 1;
    run.integritySha256 = runIntegrity(run);
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(run, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, path);
  }

  cancel(id: string, principal?: ToolPrincipal): WorkflowRun {
    return this.withRunLock(id, () => {
      const run = this.get(id, principal);
      if (['completed', 'failed', 'cancelled'].includes(run.state)) return run;
      run.state = 'cancelled';
      run.completedAt = Date.now();
      run.pauseReason = 'Cancelled by operator.';
      this.save(run);
      return run;
    });
  }

  pause(id: string, principal: ToolPrincipal, reason = 'Paused by operator.'): WorkflowRun {
    return this.withRunLock(id, () => {
      const run = this.get(id, principal);
      if (['completed', 'failed', 'cancelled'].includes(run.state)) {
        throw new Error(`Workflow ${id} is terminal (${run.state}).`);
      }
      run.state = 'paused';
      run.pauseReason = reason.trim().slice(0, 2_000) || 'Paused by operator.';
      this.save(run);
      return run;
    });
  }

  handoff(
    id: string,
    principal: ToolPrincipal,
    targetPrincipalId: string,
    ttlMs = DEFAULT_HANDOFF_TTL_MS,
  ): { run: WorkflowRun; token: string } {
    return this.withRunLock(id, () => {
      const run = this.get(id, principal);
      if (!['created', 'paused'].includes(run.state)) {
        throw new Error('Workflow handoff requires created or paused state.');
      }
      if (run.steps.some((step) => step.state === 'running')) {
        throw new Error('Workflow handoff waits for the current running step to checkpoint.');
      }
      const target = targetPrincipalId.trim();
    if (!target || target === run.owner.principalId) throw new Error('Handoff target must be a different principal.');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_HANDOFF_TTL_MS) {
      throw new Error(`handoff ttlMs must be between 1000 and ${MAX_HANDOFF_TTL_MS}.`);
    }
    const token = `wf_claim_${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
    const now = Date.now();
    for (const step of run.steps.filter((item) => item.state === 'awaiting_approval')) {
      step.state = 'pending';
      step.note = 'Previous approval invalidated by workflow handoff.';
      delete step.approvalId;
    }
    run.handoff = {
      targetPrincipalId: target,
      tokenSha256: tokenHash(token),
      createdAt: now,
      expiresAt: now + ttlMs,
    };
      this.save(run);
      return { run, token };
    });
  }

  claim(id: string, token: string, principal: ToolPrincipal): WorkflowRun {
    return this.withRunLock(id, () => {
      const run = this.get(id);
    const handoff = run.handoff;
    if (!handoff) throw new Error('Workflow has no pending handoff.');
    if (handoff.expiresAt <= Date.now()) {
      delete run.handoff;
      this.save(run);
      throw new Error('Workflow handoff has expired.');
    }
    if (handoff.targetPrincipalId !== principal.id) throw new Error('Workflow handoff target mismatch.');
    if (tokenHash(token) !== handoff.tokenSha256) throw new Error('Workflow handoff token is invalid.');
    run.owner = ownerBinding(principal);
    delete run.handoff;
      this.save(run);
      return run;
    });
  }

  addProofPack(id: string, ref: WorkflowProofPackRef, principal?: ToolPrincipal): WorkflowRun {
    return this.withRunLock(id, () => {
      const run = this.get(id, principal);
      if (!run.proofPacks.some((item) => item.id === ref.id)) run.proofPacks.push({ ...ref });
      this.save(run);
      return run;
    });
  }

  removeProofPack(id: string, proofPackId: string, principal?: ToolPrincipal): WorkflowRun {
    return this.withRunLock(id, () => {
      const run = this.get(id, principal);
      run.proofPacks = run.proofPacks.filter((item) => item.id !== proofPackId);
      this.save(run);
      return run;
    });
  }

  checkpoint(candidate: WorkflowRun, principal: ToolPrincipal): WorkflowRun {
    return this.withRunLock(candidate.id, () => {
      const current = this.get(candidate.id, principal);
      if (current.revision === candidate.revision) {
        this.save(candidate);
        return candidate;
      }
      if (!['paused', 'cancelled'].includes(current.state)) {
        throw new Error(
          `Workflow state changed concurrently at revision ${current.revision}; refusing stale checkpoint.`,
        );
      }
      if (candidate.currentStepId) {
        const source = candidate.steps.find((step) => step.id === candidate.currentStepId);
        const target = current.steps.find((step) => step.id === candidate.currentStepId);
        if (source && target && source.attempts >= target.attempts) {
          if (source.state === 'running' && !source.evidence) {
            target.state = 'pending';
            delete target.startedAt;
            delete current.currentStepId;
          } else {
            Object.assign(target, structuredClone(source));
            current.currentStepId = candidate.currentStepId;
          }
        }
      }
      this.save(current);
      return current;
    });
  }

  view(run: WorkflowRun): WorkflowRunView {
    return {
      id: run.id,
      name: run.definition.name,
      ...(run.definition.description ? { description: run.definition.description } : {}),
      definitionHash: run.definitionHash,
      projectRoot: run.projectRoot,
      owner: { ...run.owner },
      task: structuredClone(run.task),
      ...(run.handoff
        ? {
            handoff: {
              targetPrincipalId: run.handoff.targetPrincipalId,
              createdAt: run.handoff.createdAt,
              expiresAt: run.handoff.expiresAt,
            },
          }
        : {}),
      proofPacks: run.proofPacks.map((item) => ({ ...item })),
      state: run.state,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      ...(run.completedAt ? { completedAt: run.completedAt } : {}),
      ...(run.currentStepId ? { currentStepId: run.currentStepId } : {}),
      ...(run.pauseReason ? { pauseReason: run.pauseReason } : {}),
      ...(run.failure ? { failure: run.failure } : {}),
      roles: run.definition.roles,
      steps: run.steps.map((step) => ({ ...step })),
    };
  }

  report(run: WorkflowRun): Record<string, unknown> {
    const counts = run.steps.reduce<Record<WorkflowStepState, number>>(
      (acc, step) => {
        acc[step.state]++;
        return acc;
      },
      { pending: 0, running: 0, awaiting_approval: 0, succeeded: 0, failed: 0, skipped: 0 }
    );
    return {
      ...this.view(run),
      summary: {
        totalSteps: run.steps.length,
        counts,
        durationMs: (run.completedAt ?? Date.now()) - (run.startedAt ?? run.createdAt),
        resumable: run.state === 'paused',
        successful: run.state === 'completed',
      },
    };
  }

  private normalizeRun(raw: Record<string, unknown>, id: string): WorkflowRun {
    if (raw.id !== id) throw new Error(`Invalid workflow run file: ${id}`);
    if (raw.schemaVersion === 2) {
      const run = raw as unknown as WorkflowRun;
      if (
        !run.owner?.principalId ||
        !run.task?.objective ||
        !Array.isArray(run.proofPacks) ||
        !Number.isSafeInteger(run.revision) ||
        run.revision < 1 ||
        !/^[a-f0-9]{64}$/.test(run.integritySha256)
      ) {
        throw new Error(`Invalid workflow run file: ${id}`);
      }
      if (runIntegrity(run) !== run.integritySha256) {
        throw new Error(`Workflow state integrity check failed: ${id}`);
      }
      return run;
    }
    if (raw.schemaVersion === 1) {
      const legacy = raw as unknown as Omit<WorkflowRun, 'schemaVersion' | 'owner' | 'task' | 'proofPacks'> & { schemaVersion: 1 };
      return {
        ...legacy,
        schemaVersion: 2,
        revision: 0,
        integritySha256: '',
        owner: { principalId: 'legacy:unowned' },
        task: taskMetadata(legacy.definition),
        proofPacks: [],
      };
    }
    throw new Error(`Unsupported workflow schema for ${id}.`);
  }

  private clearStaleLock(lockPath: string): void {
    if (!existsSync(lockPath)) return;
    try {
      const metadata = JSON.parse(readFileSync(lockPath, 'utf8')) as {
        pid?: number;
        createdAt?: string;
      };
      if (
        !Number.isSafeInteger(metadata.pid) ||
        !metadata.createdAt ||
        !Number.isFinite(Date.parse(metadata.createdAt)) ||
        Date.now() - Date.parse(metadata.createdAt) <= STALE_LOCK_MS
      ) {
        return;
      }
      try {
        process.kill(metadata.pid!, 0);
        return;
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('code' in error) ||
          (error as NodeJS.ErrnoException).code !== 'ESRCH'
        ) {
          return;
        }
      }
      unlinkSync(lockPath);
    } catch {
      // Invalid or unreadable locks fail closed instead of being removed.
    }
  }

  private withRunLock<T>(id: string, operation: () => T): T {
    this.ensureStore();
    if (!/^wf_[a-z0-9]+$/i.test(id)) throw new Error('Invalid workflow run id.');
    const lockPath = join(this.runsDir, `${id}.lock`);
    this.clearStaleLock(lockPath);
    let descriptor: number | undefined;
    let ownsLock = false;
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
      ownsLock = true;
      writeSync(
        descriptor,
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      );
      closeSync(descriptor);
      descriptor = undefined;
      return operation();
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'EEXIST'
      ) {
        throw new Error(`Workflow is busy: ${id}`);
      }
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (ownsLock) {
        try {
          unlinkSync(lockPath);
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
            logger.warn(
              { workflowId: id, lockPath, err: error },
              'Workflow lock cleanup failed; future mutations remain fail-closed',
            );
          }
        }
      }
    }
  }

  private ensureStore(): void {
    mkdirSync(this.runsDir, { recursive: true });
    const ignore = join(this.root, '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n!.gitignore\n', 'utf8');
  }
}
