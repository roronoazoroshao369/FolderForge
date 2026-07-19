import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const TASK_MANIFEST = resolve('benchmarks/tasks/agent-evaluation.json');

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function loadManifest() {
  const raw = readFileSync(TASK_MANIFEST);
  const manifest = JSON.parse(raw.toString('utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.tasks) || !manifest.tasks.length) {
    throw new Error('Invalid benchmark task manifest.');
  }
  const ids = new Set();
  for (const task of manifest.tasks) {
    if (!task || typeof task.id !== 'string' || ids.has(task.id)) {
      throw new Error(`Invalid or duplicate benchmark task id: ${String(task?.id)}`);
    }
    ids.add(task.id);
  }
  return { manifest, hash: sha256(raw) };
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer.`);
}

export function validateResult(result, source = '<memory>') {
  const { manifest, hash } = loadManifest();
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`${source}: result must be an object.`);
  if (result.schemaVersion !== 1) throw new Error(`${source}: schemaVersion must be 1.`);
  if (result.suite !== manifest.suite) throw new Error(`${source}: suite must be ${manifest.suite}.`);
  if (result.taskManifestSha256 !== hash) throw new Error(`${source}: task manifest hash does not match.`);
  const system = result.system;
  if (!system || typeof system !== 'object' || Array.isArray(system)) throw new Error(`${source}: system is required.`);
  for (const key of ['name', 'version', 'commit', 'agent', 'model', 'os', 'hardware']) nonEmpty(system[key], `${source}: system.${key}`);
  if (!Array.isArray(result.runs)) throw new Error(`${source}: runs must be an array.`);

  const taskIds = new Set(manifest.tasks.map((task) => task.id));
  const seen = new Set();
  const counts = new Map([...taskIds].map((id) => [id, 0]));
  for (const [index, run] of result.runs.entries()) {
    const prefix = `${source}: runs[${index}]`;
    if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error(`${prefix} must be an object.`);
    if (!taskIds.has(run.taskId)) throw new Error(`${prefix}.taskId is not in the task manifest.`);
    if (!Number.isSafeInteger(run.run) || run.run < 1) throw new Error(`${prefix}.run must be >= 1.`);
    const identity = `${run.taskId}:${run.run}`;
    if (seen.has(identity)) throw new Error(`${source}: duplicate run ${identity}.`);
    seen.add(identity);
    if (typeof run.success !== 'boolean' || typeof run.securityPass !== 'boolean') {
      throw new Error(`${prefix}: success and securityPass must be booleans.`);
    }
    for (const key of ['durationMs', 'toolCalls', 'approvals', 'unintendedFiles']) integer(run[key], `${prefix}.${key}`);
    if (run.tokens !== undefined) integer(run.tokens, `${prefix}.tokens`);
    if (run.evidenceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(run.evidenceSha256)) {
      throw new Error(`${prefix}.evidenceSha256 must be lowercase SHA-256.`);
    }
    if (run.notes !== undefined && (typeof run.notes !== 'string' || run.notes.length > 2000)) {
      throw new Error(`${prefix}.notes must be at most 2000 characters.`);
    }
    counts.set(run.taskId, counts.get(run.taskId) + 1);
  }

  const minimum = Number(manifest.minimumRunsPerTask ?? 5);
  for (const [taskId, count] of counts) {
    if (count < minimum) throw new Error(`${source}: ${taskId} has ${count} runs; minimum is ${minimum}.`);
  }
  return { manifest, hash, result };
}

export function loadResult(path) {
  return validateResult(JSON.parse(readFileSync(path, 'utf8')), path);
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarize(result) {
  const total = result.runs.length;
  const sum = (key) => result.runs.reduce((value, run) => value + Number(run[key] ?? 0), 0);
  const hasTokens = result.runs.every((run) => Number.isSafeInteger(run.tokens));
  return {
    label: `${result.system.name} ${result.system.version}`,
    successRate: total ? result.runs.filter((run) => run.success).length / total : 0,
    securityRate: total ? result.runs.filter((run) => run.securityPass).length / total : 0,
    medianDurationMs: median(result.runs.map((run) => run.durationMs)),
    averageToolCalls: total ? sum('toolCalls') / total : 0,
    averageTokens: hasTokens && total ? sum('tokens') / total : null,
    averageApprovals: total ? sum('approvals') / total : 0,
    unintendedFiles: sum('unintendedFiles'),
    runs: total,
    hardware: `${result.system.os}|${result.system.hardware}`,
  };
}
