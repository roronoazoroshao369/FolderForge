import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ToolPrincipal } from '../core/types.js';

export const VERIFICATION_CHECKS = ['typecheck', 'lint', 'test', 'build'] as const;
export type VerificationCheck = (typeof VERIFICATION_CHECKS)[number];
export type VerificationCheckStatus =
  | 'pending'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'unavailable';
export type VerificationRunState =
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'interrupted';
export type VerificationOverall =
  | 'passed'
  | 'failed'
  | 'unavailable'
  | 'incomplete';

export interface VerificationOwnerBinding {
  principalId: string;
  projectId?: string;
  clientId?: string;
}

export interface VerificationCheckResult {
  check: VerificationCheck;
  command: string | null;
  status: VerificationCheckStatus;
  reason?: string;
  exitCode?: number | null;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  errors?: unknown[];
  /** Backward-compatible mirrors; status is authoritative. */
  passed?: boolean;
  skipped?: boolean;
}

export interface VerificationRun {
  schemaVersion: 1;
  id: string;
  revision: number;
  integritySha256: string;
  projectRoot: string;
  owner: VerificationOwnerBinding;
  taskId?: string;
  packageManager: string | null;
  requested: VerificationCheck[];
  stopOnFailure: boolean;
  state: VerificationRunState;
  overall: VerificationOverall;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  executorPid?: number;
  results: VerificationCheckResult[];
}

export interface VerificationRunSummary {
  id: string;
  projectRoot: string;
  owner: VerificationOwnerBinding;
  taskId?: string;
  packageManager: string | null;
  requested: VerificationCheck[];
  state: VerificationRunState;
  overall: VerificationOverall;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  counts: Record<VerificationCheckStatus, number>;
}

const RUN_ID = /^verify_[a-f0-9]{16}$/;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function integrity(run: Omit<VerificationRun, 'integritySha256'>): string {
  return createHash('sha256').update(canonical(run)).digest('hex');
}

function ownerBinding(principal: ToolPrincipal): VerificationOwnerBinding {
  return {
    principalId: principal.id,
    ...(principal.projectId ? { projectId: principal.projectId } : {}),
    ...(principal.oauthClientId ? { clientId: principal.oauthClientId } : {}),
  };
}

function ownerMatches(owner: VerificationOwnerBinding, principal: ToolPrincipal): boolean {
  if (principal.role === 'admin') return true;
  if (owner.principalId !== principal.id) return false;
  if (owner.projectId && owner.projectId !== principal.projectId) return false;
  if (owner.clientId && owner.clientId !== principal.oauthClientId) return false;
  return true;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(
      error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code !== 'ESRCH',
    );
  }
}

function counts(results: VerificationCheckResult[]): Record<VerificationCheckStatus, number> {
  return results.reduce<Record<VerificationCheckStatus, number>>(
    (acc, result) => {
      acc[result.status] += 1;
      return acc;
    },
    { pending: 0, passed: 0, failed: 0, skipped: 0, unavailable: 0 },
  );
}

function overall(results: VerificationCheckResult[]): VerificationOverall {
  const summary = counts(results);
  if (summary.failed > 0) return 'failed';
  if (summary.unavailable > 0) return 'unavailable';
  if (summary.pending > 0 || summary.skipped > 0) return 'incomplete';
  return 'passed';
}

export class VerificationManager {
  private readonly root: string;
  private readonly runsDir: string;

  constructor(private readonly projectRoot: string) {
    this.root = join(projectRoot, '.folderforge', 'verifications');
    this.runsDir = join(this.root, 'runs');
    this.recoverInterrupted();
  }

  create(input: {
    principal: ToolPrincipal;
    packageManager: string | null;
    requested: VerificationCheck[];
    commands: Partial<Record<VerificationCheck, string>>;
    stopOnFailure: boolean;
  }): VerificationRun {
    if (input.requested.length < 1) throw new Error('Verification requires at least one check.');
    const now = new Date().toISOString();
    const run: VerificationRun = {
      schemaVersion: 1,
      id: `verify_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      revision: 0,
      integritySha256: '',
      projectRoot: this.projectRoot,
      owner: ownerBinding(input.principal),
      ...(input.principal.taskId ? { taskId: input.principal.taskId } : {}),
      packageManager: input.packageManager,
      requested: [...input.requested],
      stopOnFailure: input.stopOnFailure,
      state: 'running',
      overall: 'incomplete',
      createdAt: now,
      updatedAt: now,
      executorPid: process.pid,
      results: input.requested.map((check) => ({
        check,
        command: input.commands[check] ?? null,
        status: input.commands[check] ? 'pending' : 'unavailable',
        ...(input.commands[check]
          ? {}
          : { reason: 'No verification command was detected.', passed: false }),
      })),
    };
    this.save(run);
    return run;
  }

  get(id: string, principal?: ToolPrincipal): VerificationRun {
    if (!RUN_ID.test(id)) throw new Error('Invalid verification run id.');
    const path = this.runPath(id);
    if (!existsSync(path)) throw new Error(`Verification run not found: ${id}`);
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Verification run path is unsafe: ${id}`);
    }
    const run = this.validate(JSON.parse(readFileSync(path, 'utf8')) as unknown, id);
    if (principal && !ownerMatches(run.owner, principal)) {
      throw new Error(`Verification access denied for principal ${principal.id}.`);
    }
    return structuredClone(run);
  }

  list(principal?: ToolPrincipal, limit = 50): VerificationRunSummary[] {
    if (!existsSync(this.runsDir)) return [];
    return readdirSync(this.runsDir)
      .filter((name) => /^verify_[a-f0-9]{16}\.json$/.test(name))
      .map((name) => {
        try {
          const run = this.get(name.slice(0, -5));
          if (principal && !ownerMatches(run.owner, principal)) return null;
          return this.summary(run);
        } catch {
          return null;
        }
      })
      .filter((item): item is VerificationRunSummary => item !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.min(200, Math.max(1, Math.trunc(limit))));
  }

  checkpoint(run: VerificationRun): VerificationRun {
    if (run.projectRoot !== this.projectRoot) throw new Error('Verification project root mismatch.');
    run.overall = overall(run.results);
    this.save(run);
    return structuredClone(run);
  }

  finish(
    run: VerificationRun,
    state: Extract<VerificationRunState, 'completed' | 'cancelled' | 'interrupted'>,
  ): VerificationRun {
    run.state = state;
    run.overall = state === 'completed' ? overall(run.results) : 'incomplete';
    run.completedAt = new Date().toISOString();
    delete run.executorPid;
    this.save(run);
    return structuredClone(run);
  }

  summary(run: VerificationRun): VerificationRunSummary {
    return {
      id: run.id,
      projectRoot: run.projectRoot,
      owner: { ...run.owner },
      ...(run.taskId ? { taskId: run.taskId } : {}),
      packageManager: run.packageManager,
      requested: [...run.requested],
      state: run.state,
      overall: run.overall,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.completedAt ? { completedAt: run.completedAt } : {}),
      counts: counts(run.results),
    };
  }

  report(run: VerificationRun): Record<string, unknown> {
    return {
      ...this.summary(run),
      stopOnFailure: run.stopOnFailure,
      passed: run.overall === 'passed',
      completed: run.results.filter((result) => result.status !== 'pending').length,
      results: run.results.map((result) => structuredClone(result)),
    };
  }

  private save(run: VerificationRun): void {
    this.ensureStore();
    const path = this.runPath(run.id);
    if (existsSync(path)) {
      const current = this.validate(JSON.parse(readFileSync(path, 'utf8')) as unknown, run.id);
      if (current.revision !== run.revision) {
        throw new Error(
          `Verification state changed concurrently: expected revision ${run.revision}, current ${current.revision}.`,
        );
      }
    }
    run.revision += 1;
    run.updatedAt = new Date().toISOString();
    const { integritySha256: _oldIntegrity, ...unsigned } = run;
    run.integritySha256 = integrity(unsigned);
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  }

  private recoverInterrupted(): void {
    if (!existsSync(this.runsDir)) return;
    for (const name of readdirSync(this.runsDir).filter((entry) => /^verify_[a-f0-9]{16}\.json$/.test(entry))) {
      const id = name.slice(0, -5);
      const run = this.get(id);
      if (run.state !== 'running' || isProcessAlive(run.executorPid)) continue;
      for (const result of run.results) {
        if (result.status !== 'pending') continue;
        result.status = 'skipped';
        result.skipped = true;
        result.reason = 'Verification executor stopped before this check completed.';
      }
      this.finish(run, 'interrupted');
    }
  }

  private validate(value: unknown, id: string): VerificationRun {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Invalid verification run file: ${id}`);
    }
    const run = value as VerificationRun;
    if (
      run.schemaVersion !== 1 ||
      run.id !== id ||
      !RUN_ID.test(run.id) ||
      run.projectRoot !== this.projectRoot ||
      !Number.isSafeInteger(run.revision) ||
      run.revision < 1 ||
      !/^[a-f0-9]{64}$/.test(run.integritySha256) ||
      !run.owner?.principalId ||
      !Array.isArray(run.requested) ||
      run.requested.length < 1 ||
      run.requested.some((check) => !VERIFICATION_CHECKS.includes(check)) ||
      !['running', 'completed', 'cancelled', 'interrupted'].includes(run.state) ||
      !['passed', 'failed', 'unavailable', 'incomplete'].includes(run.overall) ||
      !isTimestamp(run.createdAt) ||
      !isTimestamp(run.updatedAt) ||
      (run.completedAt !== undefined && !isTimestamp(run.completedAt)) ||
      !Array.isArray(run.results) ||
      run.results.length !== run.requested.length
    ) {
      throw new Error(`Invalid verification run file: ${id}`);
    }
    const resultChecks = new Set<VerificationCheck>();
    for (const result of run.results) {
      if (
        !result ||
        !VERIFICATION_CHECKS.includes(result.check) ||
        resultChecks.has(result.check) ||
        !['pending', 'passed', 'failed', 'skipped', 'unavailable'].includes(result.status) ||
        (result.command !== null && typeof result.command !== 'string')
      ) {
        throw new Error(`Invalid verification result in ${id}.`);
      }
      resultChecks.add(result.check);
    }
    if (run.requested.some((check) => !resultChecks.has(check))) {
      throw new Error(`Verification result inventory mismatch: ${id}`);
    }
    const pending = run.results.some((result) => result.status === 'pending');
    if (run.state === 'running') {
      if (run.completedAt !== undefined || run.executorPid === undefined) {
        throw new Error(`Running verification lifecycle is invalid: ${id}`);
      }
    } else {
      if (pending || !run.completedAt || run.executorPid !== undefined) {
        throw new Error(`Terminal verification lifecycle is invalid: ${id}`);
      }
      if (run.state === 'completed' && run.overall !== overall(run.results)) {
        throw new Error(`Completed verification outcome is inconsistent: ${id}`);
      }
      if (run.state !== 'completed' && run.overall !== 'incomplete') {
        throw new Error(`Interrupted verification outcome must be incomplete: ${id}`);
      }
    }
    const { integritySha256, ...unsigned } = run;
    if (integrity(unsigned) !== integritySha256) {
      throw new Error(`Verification state integrity check failed: ${id}`);
    }
    return run;
  }

  private ensureStore(): void {
    for (const path of [this.root, this.runsDir]) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
        throw new Error(`Verification store path must not be a symbolic link: ${path}`);
      }
    }
    mkdirSync(this.runsDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      chmodSync(this.root, 0o700);
      chmodSync(this.runsDir, 0o700);
    }
    const ignore = join(this.root, '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n!.gitignore\n', { mode: 0o600 });
  }

  private runPath(id: string): string {
    return join(this.runsDir, `${id}.json`);
  }
}
