import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { execa } from 'execa';
import { simpleGit } from 'simple-git';
import { analyzeProject } from '../agent/project-analyzer.js';
import { buildCodeContext } from '../agent/code-context.js';
import type { PatchFileSnapshot, PatchTransactionView } from '../managers/patch-transaction-manager.js';
import type { ToolContentBlock, ToolDefinition, ToolPrincipal, ToolResult } from '../core/types.js';
import { detectCommands } from '../workspace/project-detector.js';
import { defineTool } from './registry.js';
import { simpleDiff } from './diff-util.js';
import { parseErrors } from './error-parser.js';
import { shellCommandArgs, shellSpawnOptions } from '../core/shell.js';
import {
  VERIFICATION_CHECKS,
  type VerificationCheck,
  type VerificationManager,
  type VerificationRun,
} from '../verification/verification-manager.js';
import { logger } from '../core/logger.js';
import { terminateChildProcessTree } from '../core/process-tree.js';
import {
  CHANGE_SUMMARY_OUTPUT_SCHEMA,
  CODE_CONTEXT_OUTPUT_SCHEMA,
  PATCH_TRANSACTION_OUTPUT_SCHEMA,
  PROJECT_ANALYZE_OUTPUT_SCHEMA,
  PROJECT_VERIFY_OUTPUT_SCHEMA,
} from './output-schemas.js';

const MAX_PATCH_FILES = 25;
const MAX_PATCH_FILE_BYTES = 256_000;
const MAX_PATCH_TOTAL_BYTES = 2_000_000;
const VERIFY_ORDER = VERIFICATION_CHECKS;
type VerifyCheck = VerificationCheck;

interface PatchOperation {
  path: string;
  oldText?: string;
  newText: string;
  expectedOccurrences?: number;
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

function boundedDiff(before: string, after: string, path: string): string {
  const beforeLines = before.split('\n').length;
  const afterLines = after.split('\n').length;
  if (beforeLines > 1200 || afterLines > 1200) {
    return [
      `--- ${path} (before)`,
      `+++ ${path} (after)`,
      `@@ large-file summary @@`,
      `before: ${Buffer.byteLength(before)} bytes / ${beforeLines} lines`,
      `after: ${Buffer.byteLength(after)} bytes / ${afterLines} lines`,
      'Detailed line diff omitted to keep the transaction preview bounded.',
    ].join('\n');
  }
  return simpleDiff(before, after, path);
}

function patchContent(view: PatchTransactionView, redact: (text: string) => string): ToolContentBlock[] {
  return view.files.map((file) => ({
    kind: 'resource' as const,
    uri: `folderforge://patch/${encodeURIComponent(view.id)}/${encodeURIComponent(file.path)}`,
    title: `${view.state}: ${file.path}`,
    mimeType: 'text/x-diff',
    text: redact(file.diff),
  }));
}

function normalizePatchOperations(args: Record<string, unknown>): PatchOperation[] {
  if (!Array.isArray(args.operations)) throw new Error('operations must be an array.');
  if (args.operations.length === 0 || args.operations.length > MAX_PATCH_FILES) {
    throw new Error(`operations must contain 1-${MAX_PATCH_FILES} files.`);
  }
  return args.operations.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`operations[${index}] must be an object.`);
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.path !== 'string' || !item.path.trim()) {
      throw new Error(`operations[${index}].path is required.`);
    }
    if (typeof item.newText !== 'string') {
      throw new Error(`operations[${index}].newText must be a string.`);
    }
    if (item.oldText !== undefined && typeof item.oldText !== 'string') {
      throw new Error(`operations[${index}].oldText must be a string when provided.`);
    }
    const expected = item.expectedOccurrences === undefined ? undefined : Number(item.expectedOccurrences);
    if (expected !== undefined && (!Number.isInteger(expected) || expected < 1)) {
      throw new Error(`operations[${index}].expectedOccurrences must be a positive integer.`);
    }
    return {
      path: item.path,
      newText: item.newText,
      ...(item.oldText !== undefined ? { oldText: item.oldText } : {}),
      ...(expected !== undefined ? { expectedOccurrences: expected } : {}),
    };
  });
}

function buildPatchSnapshots(
  operations: PatchOperation[],
  projectRoot: string,
  resolveSafe: (path: string) => string
): PatchFileSnapshot[] {
  const seen = new Set<string>();
  let totalBytes = 0;
  const files: PatchFileSnapshot[] = [];

  for (const operation of operations) {
    const absolutePath = resolveSafe(operation.path);
    const path = relative(projectRoot, absolutePath).split(sep).join('/');
    if (seen.has(absolutePath)) throw new Error(`Duplicate patch path: ${operation.path}`);
    seen.add(absolutePath);

    const existed = existsSync(absolutePath);
    const before = existed ? readFileSync(absolutePath, 'utf8') : '';
    let after: string;
    if (operation.oldText !== undefined) {
      const expected = operation.expectedOccurrences ?? 1;
      const actual = countOccurrences(before, operation.oldText);
      if (actual !== expected) {
        throw new Error(
          `${path}: found ${actual} occurrences of oldText, expected ${expected}. No files were changed.`
        );
      }
      after = before.split(operation.oldText).join(operation.newText);
    } else {
      after = operation.newText;
    }

    const beforeBytes = Buffer.byteLength(before);
    const afterBytes = Buffer.byteLength(after);
    if (beforeBytes > MAX_PATCH_FILE_BYTES || afterBytes > MAX_PATCH_FILE_BYTES) {
      throw new Error(`${path}: patch files are limited to ${MAX_PATCH_FILE_BYTES} bytes each.`);
    }
    totalBytes += beforeBytes + afterBytes;
    if (totalBytes > MAX_PATCH_TOTAL_BYTES) {
      throw new Error(`Patch transaction exceeds the ${MAX_PATCH_TOTAL_BYTES}-byte snapshot budget.`);
    }

    files.push({
      path,
      absolutePath,
      existed,
      before,
      after,
      diff: boundedDiff(before, after, path),
    });
  }
  return files;
}

async function patchTransaction(
  args: Record<string, unknown>,
  ctx: Parameters<ToolDefinition['handler']>[1]
): Promise<ToolResult> {
  const action = String(args.action ?? 'preview');
  const transactionId = typeof args.transactionId === 'string' ? args.transactionId : '';
  const force = args.force === true;
  const manager = ctx.container.patchTransactions;

  try {
    let view: PatchTransactionView;
    if (action === 'status') {
      if (!transactionId) return { ok: false, error: 'transactionId is required for status.' };
      view = manager.get(transactionId);
    } else if (action === 'rollback') {
      if (!transactionId) return { ok: false, error: 'transactionId is required for rollback.' };
      view = manager.rollback(transactionId, force);
    } else if (action === 'apply') {
      if (transactionId) {
        view = manager.apply(transactionId, force);
      } else {
        const operations = normalizePatchOperations(args);
        const files = buildPatchSnapshots(operations, ctx.projectRoot, (path) =>
          ctx.container.policy.path.resolveSafe(path, ctx.projectRoot)
        );
        const preview = manager.create(ctx.projectRoot, files);
        view = manager.apply(preview.id, force);
      }
    } else if (action === 'preview') {
      const operations = normalizePatchOperations(args);
      const files = buildPatchSnapshots(operations, ctx.projectRoot, (path) =>
        ctx.container.policy.path.resolveSafe(path, ctx.projectRoot)
      );
      view = manager.create(ctx.projectRoot, files);
    } else {
      return { ok: false, error: `Unknown action: ${action}. Use preview, apply, rollback, or status.` };
    }

    return {
      ok: true,
      data: view,
      content: patchContent(view, (text) => ctx.container.policy.secret.redact(text)),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function requestedChecks(args: Record<string, unknown>, available: Record<string, string>): VerifyCheck[] {
  if (args.checks === undefined) return VERIFY_ORDER.filter((check) => available[check]);
  if (!Array.isArray(args.checks)) throw new Error('checks must be an array.');
  const raw = args.checks.map(String);
  const invalid = [...new Set(raw.filter((value) => !VERIFY_ORDER.includes(value as VerifyCheck)))];
  if (invalid.length > 0) throw new Error(`Unknown verification checks: ${invalid.join(', ')}`);
  return VERIFY_ORDER.filter((check) => raw.includes(check));
}

function verificationPrincipal(ctx: Parameters<ToolDefinition['handler']>[1]): ToolPrincipal {
  return ctx.control?.principal ?? { id: 'agent:unknown', role: 'agent' };
}

function markPendingSkipped(
  run: VerificationRun,
  reason: string,
): void {
  for (const result of run.results) {
    if (result.status !== 'pending') continue;
    result.status = 'skipped';
    result.skipped = true;
    result.reason = reason;
  }
}

function commandUnavailable(exitCode: number | null | undefined, stderr: string): boolean {
  return (
    exitCode === 127 ||
    exitCode === 9009 ||
    /command not found|not recognized as an internal or external command/i.test(stderr)
  );
}

function verificationError(overall: string): string {
  if (overall === 'unavailable') {
    return 'Project verification is unavailable. Inspect the structured results for missing commands or executables.';
  }
  if (overall === 'incomplete') {
    return 'Project verification is incomplete. Inspect skipped checks and retry only when safe.';
  }
  return 'Project verification failed. Inspect the structured results.';
}

function uncertainVerification(run: VerificationRun, error: unknown): ToolResult {
  return {
    ok: false,
    error:
      `VERIFICATION_OUTCOME_UNCERTAIN: a check completed or may have partially completed, ` +
      `but durable verification evidence could not be checkpointed. Do not retry automatically. ${error instanceof Error ? error.message : String(error)}`,
    data: {
      id: run.id,
      state: run.state,
      overall: run.overall,
      requested: run.requested,
      results: run.results,
    },
  };
}

interface VerificationExecutionOptions {
  manager: VerificationManager;
  run: VerificationRun;
  stopOnFailure: boolean;
  timeout: number;
  maxOutput: number;
  cwd: string;
  shell: string;
  /** Run-scoped cancellation signal (linked to the request for sync runs). */
  signal: AbortSignal;
  redact: (text: string) => string;
  reportProgress?: (completed: number, total: number, message: string) => Promise<void>;
}

/**
 * Execute the persisted checks of a verification run in deterministic order,
 * checkpointing durable evidence after every check. Shared by the synchronous
 * (request-bound) path and detached async executions; cancellation flows
 * exclusively through the run-scoped `options.signal`.
 */
async function executeVerificationRun(
  options: VerificationExecutionOptions,
): Promise<ToolResult> {
  const { manager, stopOnFailure, timeout, maxOutput, signal, redact } = options;
  let run = options.run;
  for (let index = 0; index < run.results.length; index++) {
    const result = run.results[index]!;
    if (signal.aborted) {
      markPendingSkipped(run, 'Verification cancelled before this check ran.');
      try {
        run = manager.finish(run, 'cancelled');
      } catch (error) {
        return uncertainVerification(run, error);
      }
      return {
        ok: false,
        error: 'Verification cancelled.',
        data: manager.report(run),
      };
    }

    if (result.status === 'unavailable') {
      if (stopOnFailure) {
        for (const later of run.results.slice(index + 1)) {
          if (later.status !== 'pending') continue;
          later.status = 'skipped';
          later.skipped = true;
          later.reason = `Not run after unavailable ${result.check} check.`;
        }
        try {
          run = manager.finish(run, 'completed');
        } catch (error) {
          return uncertainVerification(run, error);
        }
        return { ok: false, error: verificationError(run.overall), data: manager.report(run) };
      }
      continue;
    }

    const command = result.command!;
    await options.reportProgress?.(index, run.results.length, `Running ${result.check}: ${command}`);
    const started = Date.now();
    try {
      // Detached on POSIX so the check runs in its own process group and an
      // abort terminates the whole tree (npm -> sh -> node), not just the
      // direct child — otherwise orphaned grandchildren keep stdio pipes open
      // and this await hangs until they exit on their own.
      const child = execa(
        options.shell,
        shellCommandArgs(options.shell, command),
        {
          cwd: options.cwd,
          timeout,
          reject: false,
          maxBuffer: maxOutput * 4,
          ...(process.platform !== 'win32' ? { detached: true as const } : {}),
          ...shellSpawnOptions(options.shell),
        }
      );
      // execa's ResultPromise is a ChildProcess at runtime, but its mapped
      // types do not satisfy the ChildProcess interface — narrow at the edge.
      const onAbort = (): void => terminateChildProcessTree(child as unknown as ChildProcess);
      signal.addEventListener('abort', onAbort, { once: true });
      // Covers an abort that landed between the loop-top check and the spawn.
      if (signal.aborted) onAbort();
      const sub = await child.finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
      const stdout = redact((sub.stdout ?? '').slice(0, maxOutput));
      const stderr = redact((sub.stderr ?? '').slice(0, maxOutput));
      const unavailable = commandUnavailable(sub.exitCode, stderr);
      const success = sub.exitCode === 0;
      result.exitCode = sub.exitCode ?? null;
      result.durationMs = Date.now() - started;
      result.stdout = stdout;
      result.stderr = stderr;
      result.errors = parseErrors(`${stdout}\n${stderr}`);
      result.status = success ? 'passed' : unavailable ? 'unavailable' : 'failed';
      result.passed = success;
      if (unavailable) result.reason = 'The verification executable or command is unavailable.';
      else if (!success && (sub as { timedOut?: boolean }).timedOut) {
        result.reason = `Verification timed out after ${timeout}ms.`;
      }
    } catch (error) {
      const message = redact(
        error instanceof Error ? error.message : String(error),
      );
      result.status = 'failed';
      result.passed = false;
      result.durationMs = Date.now() - started;
      result.stderr = message.slice(0, maxOutput);
      result.errors = parseErrors(message);
      result.reason = 'Verification command could not be executed.';
    }

    if (signal.aborted) {
      result.status = 'skipped';
      result.skipped = true;
      result.passed = false;
      result.reason = 'Verification cancelled while this check was running.';
    }
    try {
      run = manager.checkpoint(run);
    } catch (error) {
      return uncertainVerification(run, error);
    }
    if (signal.aborted) {
      markPendingSkipped(run, 'Verification cancelled before this check ran.');
      try {
        run = manager.finish(run, 'cancelled');
      } catch (error) {
        return uncertainVerification(run, error);
      }
      return { ok: false, error: 'Verification cancelled.', data: manager.report(run) };
    }
    if (result.status !== 'passed' && stopOnFailure) {
      markPendingSkipped(run, `Not run after ${result.check} ${result.status}.`);
      try {
        run = manager.finish(run, 'completed');
      } catch (error) {
        return uncertainVerification(run, error);
      }
      await options.reportProgress?.(
        run.results.length,
        run.results.length,
        run.overall === 'passed' ? 'Verification passed.' : 'Verification stopped.',
      );
      return { ok: false, error: verificationError(run.overall), data: manager.report(run) };
    }
  }

  try {
    run = manager.finish(run, 'completed');
  } catch (error) {
    return uncertainVerification(run, error);
  }
  await options.reportProgress?.(
    run.results.length,
    run.results.length,
    run.overall === 'passed' ? 'Verification passed.' : 'Verification completed with issues.',
  );
  const data = manager.report(run);
  return run.overall === 'passed'
    ? { ok: true, data }
    : { ok: false, error: verificationError(run.overall), data };
}

async function projectVerify(
  args: Record<string, unknown>,
  ctx: Parameters<ToolDefinition['handler']>[1]
): Promise<ToolResult> {
  const action = typeof args.action === 'string'
    ? args.action
    : args.dryRun === true
      ? 'plan'
      : 'run';
  const principal = verificationPrincipal(ctx);
  const manager = ctx.container.verifications;

  if (action === 'status') {
    try {
      const run = manager.get(String(args.id ?? ''), principal);
      return { ok: true, data: manager.report(run) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (action === 'list') {
    return {
      ok: true,
      data: {
        runs: manager.list(principal, Number(args.limit ?? 50)),
      },
    };
  }
  if (action === 'cancel') {
    const id = String(args.id ?? '');
    try {
      const run = manager.get(id, principal);
      if (run.state !== 'running') {
        return { ok: true, data: { ...manager.report(run), cancellation: 'not-required' } };
      }
      if (!manager.cancelExecution(run.id)) {
        return {
          ok: false,
          error:
            `Verification run ${run.id} is running but has no active executor in this process. ` +
            'It cannot be cancelled here; if its executor stopped, the next server start marks it interrupted.',
        };
      }
      // Cancellation is asynchronous: the executor loop observes the abort,
      // records skipped evidence, and finishes the run cancelled. Re-read for
      // the caller; polling via status/list observes the terminal state.
      const current = manager.get(run.id, principal);
      return { ok: true, data: { ...manager.report(current), cancellation: 'requested' } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (action !== 'run' && action !== 'plan') {
    return { ok: false, error: `Unknown project_verify action: ${action}.` };
  }

  if (args.async !== undefined && typeof args.async !== 'boolean') {
    return { ok: false, error: 'async must be a boolean when provided.' };
  }
  const wantsAsync = args.async === true;
  if (wantsAsync && action !== 'run') {
    return { ok: false, error: 'async is only supported with action=run.' };
  }

  const detected = detectCommands(ctx.projectRoot);
  const checks = requestedChecks(args, detected.scripts);
  if (checks.length === 0) {
    return { ok: false, error: 'No requested verification checks were recognized.', data: { detected } };
  }
  const plan = checks.map((check) => ({
    check,
    command: detected.scripts[check] ?? null,
    status: detected.scripts[check] ? 'available' : 'unavailable',
  }));
  if (action === 'plan') {
    return {
      ok: true,
      data: {
        dryRun: true,
        action: 'plan',
        packageManager: detected.packageManager,
        requested: checks,
        plan,
      },
    };
  }

  const stopOnFailure = args.stopOnFailure !== false;
  const timeout = Math.min(
    30 * 60 * 1000,
    Math.max(1000, Number(args.timeoutMs ?? ctx.config.terminal.defaultTimeoutMs))
  );
  const maxOutput = Math.min(
    ctx.config.terminal.maxOutputBytes,
    Math.max(1000, Number(args.maxOutputBytes ?? ctx.config.terminal.maxOutputBytes))
  );

  // Single-flight guard for detached runs. The check here and the register in
  // beginExecution below are fully synchronous, so two concurrent async
  // starts cannot both win.
  if (wantsAsync) {
    const active = manager.activeAsyncExecution();
    if (active !== null) {
      return {
        ok: false,
        error: `Another async verification is still running: ${active}. Poll its status or cancel it before starting a new one.`,
      };
    }
  }

  let run: VerificationRun;
  try {
    run = manager.create({
      principal,
      packageManager: detected.packageManager,
      requested: checks,
      commands: detected.scripts,
      stopOnFailure,
    });
  } catch (error) {
    return {
      ok: false,
      error: `Verification evidence store unavailable before execution: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let controller: AbortController;
  try {
    controller = manager.beginExecution(run.id, wantsAsync ? 'async' : 'sync');
  } catch (error) {
    // Defensive: the single-flight precheck above makes this unreachable for
    // async runs. Close the fresh run out instead of leaving it running.
    try {
      markPendingSkipped(run, 'Verification executor could not be registered.');
      manager.finish(run, 'cancelled');
    } catch {
      // Evidence-store failure surfaces on the next read; nothing else to do.
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const execOptions: VerificationExecutionOptions = {
    manager,
    run,
    stopOnFailure,
    timeout,
    maxOutput,
    cwd: ctx.projectRoot,
    shell: ctx.config.terminal.shell,
    signal: controller.signal,
    redact: (text: string) => ctx.container.policy.secret.redact(text),
    ...(wantsAsync || !ctx.control?.reportProgress
      ? {}
      : {
          reportProgress: async (completed: number, total: number, message: string) => {
            await ctx.control?.reportProgress?.(completed, total, message);
          },
        }),
  };

  if (wantsAsync) {
    // Detached execution: the run outlives this request. Terminal evidence is
    // the durable run record, observed via status/list — and an orphaned
    // rejection must never crash the host process.
    void (async () => {
      try {
        await executeVerificationRun(execOptions);
      } catch (error) {
        logger.error(
          { err: error instanceof Error ? error.message : String(error), verificationId: run.id },
          'Async verification executor failed unexpectedly',
        );
        try {
          const latest = manager.get(run.id);
          if (latest.state === 'running') {
            markPendingSkipped(latest, 'Verification executor failed before this check ran.');
            manager.finish(latest, 'interrupted');
          }
        } catch (persistError) {
          logger.error(
            {
              err: persistError instanceof Error ? persistError.message : String(persistError),
              verificationId: run.id,
            },
            'Unable to persist interrupted verification state',
          );
        }
      } finally {
        manager.endExecution(run.id);
      }
    })();
    return { ok: true, data: manager.report(run) };
  }

  // Synchronous execution keeps its historical contract: link the request
  // signal into the run controller so request cancellation still cancels the
  // run, and the response waits for the terminal state.
  const requestSignal = ctx.control?.signal;
  if (requestSignal) {
    if (requestSignal.aborted) {
      controller.abort();
    } else {
      requestSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }
  try {
    return await executeVerificationRun(execOptions);
  } finally {
    manager.endExecution(run.id);
  }
}

interface NumstatEntry {
  path: string;
  added: number | null;
  deleted: number | null;
  binary: boolean;
  staged: boolean;
}

function parseNumstat(text: string, staged: boolean): NumstatEntry[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [addedRaw, deletedRaw, ...pathParts] = line.split('\t');
      const parse = (value: string | undefined): number | null =>
        value && /^\d+$/.test(value) ? Number(value) : null;
      return {
        path: pathParts.join('\t'),
        added: parse(addedRaw),
        deleted: parse(deletedRaw),
        binary: addedRaw === '-' || deletedRaw === '-',
        staged,
      };
    });
}

function verificationHints(files: string[]): VerifyCheck[] {
  const hints = new Set<VerifyCheck>();
  if (files.some((file) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs)$/i.test(file))) {
    hints.add('test');
    hints.add('lint');
  }
  if (files.some((file) => /\.(ts|tsx)$/i.test(file) || /tsconfig.*\.json$/i.test(file))) hints.add('typecheck');
  if (files.some((file) => /package\.json|lock|vite|next|webpack|rollup|docker|\.github\/workflows/i.test(file))) {
    hints.add('build');
  }
  return VERIFY_ORDER.filter((check) => hints.has(check));
}

async function changeSummary(
  _args: Record<string, unknown>,
  ctx: Parameters<ToolDefinition['handler']>[1]
): Promise<ToolResult> {
  const git = simpleGit({ baseDir: ctx.projectRoot });
  try {
    const status = await git.status();
    const unstaged = parseNumstat(await git.raw(['diff', '--numstat']), false);
    const staged = parseNumstat(await git.raw(['diff', '--cached', '--numstat']), true);
    const files = [
      ...new Set([
        ...status.staged,
        ...status.modified,
        ...status.not_added,
        ...status.deleted,
        ...status.conflicted,
      ]),
    ];
    const totals = [...unstaged, ...staged].reduce(
      (acc, item) => {
        if (typeof item.added === 'number') acc.added += item.added;
        if (typeof item.deleted === 'number') acc.deleted += item.deleted;
        if (item.binary === true) acc.binary++;
        return acc;
      },
      { added: 0, deleted: 0, binary: 0 }
    );
    return {
      ok: true,
      data: {
        branch: status.current,
        clean: status.isClean(),
        ahead: status.ahead,
        behind: status.behind,
        files: {
          all: files,
          staged: status.staged,
          modified: status.modified,
          untracked: status.not_added,
          deleted: status.deleted,
          conflicted: status.conflicted,
        },
        numstat: { unstaged, staged, totals },
        suggestedChecks: verificationHints(files),
        commitReady: status.conflicted.length === 0 && status.staged.length > 0,
      },
    };
  } catch (error) {
    return { ok: false, error: `Unable to summarize Git changes: ${String(error)}` };
  }
}

export function agentTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'project_analyze',
      description:
        'Analyze the active project architecture, languages, frameworks, manifests, entrypoints, commands, source/test roots, and Git state.',
      group: 'agent',
      mutates: false,
      inputSchema: { type: 'object', properties: {} },
      outputSchema: PROJECT_ANALYZE_OUTPUT_SCHEMA,
      handler: async (_args, ctx) => ({
        ok: true,
        data: await analyzeProject(ctx.projectRoot, {
          resolveSafe: (path) => ctx.container.policy.path.resolveSafe(path, ctx.projectRoot),
          isDenied: (path) => ctx.container.policy.path.isDenied(path, ctx.projectRoot),
        }),
      }),
    }),
    defineTool({
      name: 'code_context',
      description:
        'Build a bounded, BM25-ranked context pack for a coding task, including relevant files, redacted snippets, and related tests.',
      group: 'agent',
      mutates: false,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Task, bug, feature, symbol, or behavior to investigate.' },
          glob: { type: 'string', description: 'Optional file glob limiting the context scan.' },
          maxResults: { type: 'integer', minimum: 1, maximum: 30 },
          maxFiles: { type: 'integer', minimum: 1, maximum: 2000 },
          includeTests: { type: 'boolean' },
        },
        required: ['query'],
      },
      outputSchema: CODE_CONTEXT_OUTPUT_SCHEMA,
      handler: async (args, ctx) => {
        try {
          return {
            ok: true,
            data: await buildCodeContext(ctx.projectRoot, {
              query: String(args.query ?? ''),
              ...(typeof args.glob === 'string' ? { glob: args.glob } : {}),
              ...(args.maxResults !== undefined ? { maxResults: Number(args.maxResults) } : {}),
              ...(args.maxFiles !== undefined ? { maxFiles: Number(args.maxFiles) } : {}),
              ...(args.includeTests !== undefined ? { includeTests: args.includeTests === true } : {}),
              redact: (text) => ctx.container.policy.secret.redact(text),
              isDenied: (path) => ctx.container.policy.path.isDenied(path, ctx.projectRoot),
              resolveSafe: (path) => ctx.container.policy.path.resolveSafe(path, ctx.projectRoot),
            }),
          };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    }),
    defineTool({
      name: 'patch_transaction',
      description:
        'Preview, atomically apply, inspect, or safely roll back a bounded multi-file text patch. Conflict checks prevent overwriting newer edits unless force=true.',
      group: 'agent',
      mutates: true,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['preview', 'apply', 'rollback', 'status'] },
          transactionId: { type: 'string' },
          force: { type: 'boolean' },
          operations: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_PATCH_FILES,
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                oldText: { type: 'string', description: 'Exact context to replace. Omit for a full-file write.' },
                newText: { type: 'string' },
                expectedOccurrences: { type: 'integer', minimum: 1 },
              },
              required: ['path', 'newText'],
            },
          },
        },
      },
      outputSchema: PATCH_TRANSACTION_OUTPUT_SCHEMA,
      handler: patchTransaction,
    }),
    defineTool({
      name: 'project_verify',
      description:
        'Plan, execute, cancel, list, or inspect durable owner-bound typecheck/lint/test/build verification runs with explicit passed/failed/skipped/unavailable evidence. Pass async:true with action=run to detach a long run from the request lifecycle and poll status/list for the terminal report; action=cancel stops a running run you own.',
      group: 'agent',
      mutates: true,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['run', 'plan', 'status', 'list', 'cancel'] },
          id: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          checks: { type: 'array', items: { type: 'string', enum: VERIFY_ORDER } },
          dryRun: { type: 'boolean', description: 'Backward-compatible alias for action=plan.' },
          stopOnFailure: { type: 'boolean' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 1800000 },
          maxOutputBytes: { type: 'integer', minimum: 1000 },
          async: {
            type: 'boolean',
            description:
              'With action=run, execute detached from the request lifecycle and return the running report immediately; poll status/list for the terminal result.',
          },
        },
        additionalProperties: false,
      },
      outputSchema: PROJECT_VERIFY_OUTPUT_SCHEMA,
      handler: projectVerify,
    }),
    defineTool({
      name: 'change_summary',
      description:
        'Summarize the current Git working tree with file categories, staged/unstaged line counts, conflicts, and suggested verification checks.',
      group: 'agent',
      mutates: false,
      inputSchema: { type: 'object', properties: {} },
      outputSchema: CHANGE_SUMMARY_OUTPUT_SCHEMA,
      handler: changeSummary,
    }),
  ];
}
