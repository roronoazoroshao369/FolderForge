import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ToolContentBlock, ToolResult } from '../core/types.js';

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
  schemaVersion: 1;
  id: string;
  definition: WorkflowDefinition;
  definitionHash: string;
  projectRoot: string;
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

  create(definition: WorkflowDefinition): WorkflowRun {
    this.ensureStore();
    const now = Date.now();
    const run: WorkflowRun = {
      schemaVersion: 1,
      id: `wf_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      definition,
      definitionHash: simpleHash(stable(definition)),
      projectRoot: this.projectRoot,
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

  get(id: string): WorkflowRun {
    if (!/^wf_[a-z0-9]+$/i.test(id)) throw new Error('Invalid workflow run id.');
    const path = join(this.runsDir, `${id}.json`);
    if (!existsSync(path)) throw new Error(`Workflow run not found: ${id}`);
    const run = JSON.parse(readFileSync(path, 'utf8')) as WorkflowRun;
    if (run.schemaVersion !== 1 || run.id !== id) throw new Error(`Invalid workflow run file: ${id}`);
    return run;
  }

  list(limit = 50): WorkflowRunView[] {
    if (!existsSync(this.runsDir)) return [];
    return readdirSync(this.runsDir)
      .filter((name) => /^wf_[a-z0-9]+\.json$/i.test(name))
      .map((name) => {
        try {
          return this.view(this.get(name.slice(0, -5)));
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
    run.updatedAt = Date.now();
    const path = join(this.runsDir, `${run.id}.json`);
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify(run, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, path);
  }

  cancel(id: string): WorkflowRun {
    const run = this.get(id);
    if (['completed', 'failed', 'cancelled'].includes(run.state)) return run;
    run.state = 'cancelled';
    run.completedAt = Date.now();
    run.pauseReason = 'Cancelled by operator.';
    this.save(run);
    return run;
  }

  view(run: WorkflowRun): WorkflowRunView {
    return {
      id: run.id,
      name: run.definition.name,
      ...(run.definition.description ? { description: run.definition.description } : {}),
      definitionHash: run.definitionHash,
      projectRoot: run.projectRoot,
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

  private ensureStore(): void {
    mkdirSync(this.runsDir, { recursive: true });
    const ignore = join(this.root, '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n!.gitignore\n', 'utf8');
  }
}
