import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, platform, arch, cpus, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadManifest, sha256 } from './benchmark-lib.mjs';

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

export function machineFingerprint() {
  const cpu = cpus()[0]?.model?.trim() || 'unknown-cpu';
  return {
    os: `${platform()}-${arch()}`,
    hardware: `${cpu}|cpu=${cpus().length}|ram=${Math.round(totalmem() / (1024 ** 3))}GiB`,
  };
}

export function redactBenchmarkText(text) {
  return String(text)
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|NPM_TOKEN|GITHUB_TOKEN|TOKEN|SECRET|PASSWORD)\s*[=:]\s*[^\s"']+/gi, '$1=[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]');
}

function value(argv, index, option) {
  const next = argv[index + 1];
  if (next === undefined) throw new Error(`Missing value after ${option}`);
  return next;
}

export function parseBenchmarkArgs(argv) {
  const out = {
    manifest: resolve('benchmarks/tasks/agent-evaluation.json'),
    output: resolve('benchmarks/results/result.json'),
    evidenceDir: resolve('benchmarks/results/evidence'),
    runs: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    command: undefined,
    commandArgs: [],
    system: {},
    keepWorkdirs: false,
    envAllow: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--manifest': out.manifest = resolve(value(argv, i, arg)); i += 1; break;
      case '--output': out.output = resolve(value(argv, i, arg)); i += 1; break;
      case '--evidence-dir': out.evidenceDir = resolve(value(argv, i, arg)); i += 1; break;
      case '--runs': out.runs = Number(value(argv, i, arg)); i += 1; break;
      case '--timeout-ms': out.timeoutMs = Number(value(argv, i, arg)); i += 1; break;
      case '--command': out.command = value(argv, i, arg); i += 1; break;
      case '--command-args-json': {
        const parsed = JSON.parse(value(argv, i, arg)); i += 1;
        if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) throw new Error('--command-args-json must be a JSON string array.');
        out.commandArgs = parsed;
        break;
      }
      case '--system-name': out.system.name = value(argv, i, arg); i += 1; break;
      case '--system-version': out.system.version = value(argv, i, arg); i += 1; break;
      case '--commit': out.system.commit = value(argv, i, arg); i += 1; break;
      case '--agent': out.system.agent = value(argv, i, arg); i += 1; break;
      case '--model': out.system.model = value(argv, i, arg); i += 1; break;
      case '--env-allow': out.envAllow.push(...value(argv, i, arg).split(',').map((item) => item.trim()).filter(Boolean)); i += 1; break;
      case '--keep-workdirs': out.keepWorkdirs = true; break;
      default: throw new Error(`Unknown benchmark option: ${arg}`);
    }
  }
  if (!out.command) throw new Error('--command is required.');
  for (const key of ['name', 'version', 'commit', 'agent', 'model']) {
    if (typeof out.system[key] !== 'string' || !out.system[key].trim()) throw new Error(`--system-${key.replace('name', 'name').replace('version', 'version')} is required.`);
  }
  if (out.system.commit.length < 7) throw new Error('--commit must contain at least 7 characters.');
  if (out.runs !== undefined && (!Number.isSafeInteger(out.runs) || out.runs < 1 || out.runs > 100)) throw new Error('--runs must be 1-100.');
  if (!Number.isSafeInteger(out.timeoutMs) || out.timeoutMs < 1000 || out.timeoutMs > 24 * 60 * 60_000) throw new Error('--timeout-ms must be 1000-86400000.');
  return out;
}


function benchmarkEnvironment(explicitNames = []) {
  const portable = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'NODE_PATH'];
  const names = new Set([...portable, ...explicitNames]);
  const env = {};
  for (const name of names) {
    if (typeof process.env[name] === 'string') env[name] = process.env[name];
  }
  return env;
}

function copyFixture(fixture, workdir) {
  const source = resolve(fixture);
  if (!existsSync(source)) throw new Error(`Benchmark fixture does not exist: ${source}`);
  const target = join(workdir, basename(source));
  cpSync(source, target, { recursive: statSync(source).isDirectory(), force: false, errorOnExist: true });
  return target;
}

function boundedCollector() {
  let bytes = 0;
  let truncated = false;
  const chunks = [];
  return {
    push(chunk) {
      const buffer = Buffer.from(chunk);
      if (bytes >= MAX_LOG_BYTES) { truncated = true; return; }
      const kept = buffer.subarray(0, MAX_LOG_BYTES - bytes);
      chunks.push(kept);
      bytes += kept.length;
      if (kept.length < buffer.length) truncated = true;
    },
    text() { return redactBenchmarkText(Buffer.concat(chunks).toString('utf8')) + (truncated ? '\n[TRUNCATED]\n' : ''); },
  };
}

async function runHarness(command, commandArgs, env, cwd, timeoutMs) {
  const stdout = boundedCollector();
  const stderr = boundedCollector();
  const started = Date.now();
  const child = spawn(command, commandArgs, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
  timer.unref();
  const exit = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  clearTimeout(timer);
  return { ...exit, timedOut, durationMs: Date.now() - started, stdout: stdout.text(), stderr: stderr.text() };
}

function parseHarnessMetrics(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch { /* scan previous line */ }
  }
  throw new Error('Benchmark harness stdout must end with a JSON metrics object.');
}

function nonNegative(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export async function runBenchmarkSuite(options) {
  const { manifest, hash } = loadManifest(options.manifest);
  const runsPerTask = options.runs ?? Number(manifest.minimumRunsPerTask ?? 5);
  const machine = machineFingerprint();
  mkdirSync(options.evidenceDir, { recursive: true });
  mkdirSync(dirname(options.output), { recursive: true });
  const runs = [];
  for (const task of manifest.tasks) {
    for (let run = 1; run <= runsPerTask; run += 1) {
      const workdir = mkdtempSync(join(tmpdir(), `folderforge-benchmark-${task.id}-${run}-`));
      const evidenceRoot = join(options.evidenceDir, task.id, `run-${run}`);
      mkdirSync(evidenceRoot, { recursive: true });
      let fixturePath;
      let execution;
      let metrics;
      let runnerError;
      try {
        fixturePath = copyFixture(task.fixture, workdir);
        const taskPayload = { ...task, fixture: fixturePath };
        execution = await runHarness(
          options.command,
          options.commandArgs,
          {
            ...benchmarkEnvironment(options.envAllow),
            FOLDERFORGE_BENCHMARK_TASK_JSON: JSON.stringify(taskPayload),
            FOLDERFORGE_BENCHMARK_TASK_ID: task.id,
            FOLDERFORGE_BENCHMARK_RUN: String(run),
            FOLDERFORGE_BENCHMARK_WORKDIR: workdir,
            FOLDERFORGE_BENCHMARK_FIXTURE: fixturePath,
            FOLDERFORGE_BENCHMARK_EVIDENCE_DIR: evidenceRoot,
          },
          workdir,
          options.timeoutMs,
        );
        metrics = parseHarnessMetrics(execution.stdout);
      } catch (error) {
        runnerError = error instanceof Error ? error.message : String(error);
        execution ??= { code: null, signal: null, timedOut: false, durationMs: 0, stdout: '', stderr: '' };
        metrics = {};
      }
      const evidence = {
        schemaVersion: 1,
        taskId: task.id,
        run,
        fixture: task.fixture,
        command: options.command,
        commandArgs: options.commandArgs,
        exitCode: execution.code,
        signal: execution.signal,
        timedOut: execution.timedOut,
        durationMs: execution.durationMs,
        stdout: execution.stdout,
        stderr: execution.stderr,
        ...(runnerError ? { runnerError } : {}),
        reportedMetrics: metrics,
      };
      const evidenceText = JSON.stringify(evidence, null, 2) + '\n';
      const evidencePath = join(evidenceRoot, 'evidence.json');
      writeFileSync(evidencePath, evidenceText, { mode: 0o600 });
      const notes = [runnerError, typeof metrics.notes === 'string' ? metrics.notes : undefined]
        .filter(Boolean).join(' | ').slice(0, 2000);
      runs.push({
        taskId: task.id,
        run,
        success: execution.code === 0 && !execution.timedOut && metrics.success === true,
        securityPass: execution.code === 0 && !execution.timedOut && metrics.securityPass === true,
        durationMs: execution.durationMs,
        toolCalls: nonNegative(metrics.toolCalls),
        ...(Number.isSafeInteger(metrics.tokens) && metrics.tokens >= 0 ? { tokens: metrics.tokens } : {}),
        approvals: nonNegative(metrics.approvals),
        unintendedFiles: nonNegative(metrics.unintendedFiles),
        evidenceSha256: sha256(Buffer.from(evidenceText)),
        ...(notes ? { notes } : {}),
      });
      if (!options.keepWorkdirs) rmSync(workdir, { recursive: true, force: true });
    }
  }
  const result = {
    schemaVersion: 1,
    suite: manifest.suite,
    taskManifestSha256: hash,
    system: { ...options.system, ...machine },
    runs,
  };
  writeFileSync(options.output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  return { result, output: options.output, evidenceDir: options.evidenceDir, runId: randomUUID() };
}

async function main() {
  const options = parseBenchmarkArgs(process.argv.slice(2));
  const output = await runBenchmarkSuite(options);
  console.log(JSON.stringify({ ok: true, output: output.output, evidenceDir: output.evidenceDir, runs: output.result.runs.length }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exit(1); });
}
