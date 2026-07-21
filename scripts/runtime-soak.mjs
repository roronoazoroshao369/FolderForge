import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { arch, cpus, hostname, platform, release } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  appendSoakRecord,
  canonicalizeSoakValue,
  loadSoakLog,
  newSoakChain,
  soakSha256,
  summarizeSoak,
  verifySoakLog,
} from './runtime-soak-lib.mjs';

const DEFAULT_OUTPUT_DIR = resolve('.folderforge-soak/runtime');
const DEFAULT_DURATION_MS = 60_000;
const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_FAULT_EVERY = 300;
const DEFAULT_OUTLIER_MS = 1_000;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_INTERVAL_MS = 60_000;
const FIXTURE_SERVER = resolve('tests/fixtures/fake-mcp-server.mjs');
const OUTPUT_MARKER_NAME = '.folderforge-runtime-soak.json';
const OUTPUT_MARKER = { schemaVersion: 1, kind: 'folderforge-runtime-soak-output' };

function usage() {
  return [
    'Usage: node scripts/runtime-soak.mjs [options]',
    '',
    'Options:',
    '  --output-dir <path>          Evidence directory (default: .folderforge-soak/runtime)',
    '  --duration-ms <n>            Active test duration (default: 60000)',
    '  --interval-ms <n>            Sample interval (default: 1000)',
    '  --fault-every <n>            Restart child every N samples; 0 disables (default: 300)',
    '  --outlier-ms <n>             Mark total latency at/above N ms as an outlier (default: 1000)',
    '  --max-failures <n>           Allowed unexpected failures before non-zero exit (default: 0)',
    '  --resume                     Continue a verified incomplete evidence chain',
    '  --verify                     Verify existing evidence and rewrite summary only',
    '  --reset                      Remove an existing incomplete output directory before a new run',
    '  --help                       Show this help',
    '',
    'The 24-hour profile is:',
    '  node scripts/runtime-soak.mjs --duration-ms 86400000 --interval-ms 1000 --fault-every 300',
  ].join('\n');
}

function parseInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    outputDir: DEFAULT_OUTPUT_DIR,
    durationMs: DEFAULT_DURATION_MS,
    intervalMs: DEFAULT_INTERVAL_MS,
    faultEvery: DEFAULT_FAULT_EVERY,
    outlierMs: DEFAULT_OUTLIER_MS,
    maxFailures: 0,
    resume: false,
    verify: false,
    reset: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      process.stdout.write(`${usage()}\n`);
      return null;
    }
    if (arg === '--resume' || arg === '--verify' || arg === '--reset') {
      options[arg.slice(2)] = true;
      continue;
    }
    if (
      arg === '--output-dir' ||
      arg === '--duration-ms' ||
      arg === '--interval-ms' ||
      arg === '--fault-every' ||
      arg === '--outlier-ms' ||
      arg === '--max-failures'
    ) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value.`);
      index += 1;
      if (arg === '--output-dir') options.outputDir = resolve(value);
      if (arg === '--duration-ms') options.durationMs = parseInteger(value, arg, 1_000, MAX_DURATION_MS);
      if (arg === '--interval-ms') options.intervalMs = parseInteger(value, arg, 50, MAX_INTERVAL_MS);
      if (arg === '--fault-every') options.faultEvery = parseInteger(value, arg, 0, 1_000_000);
      if (arg === '--outlier-ms') options.outlierMs = parseInteger(value, arg, 1, 600_000);
      if (arg === '--max-failures') options.maxFailures = parseInteger(value, arg, 0, 1_000_000);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.verify && (options.resume || options.reset)) {
    throw new Error('--verify cannot be combined with --resume or --reset.');
  }
  if (options.resume && options.reset) throw new Error('--resume cannot be combined with --reset.');
  return options;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function sha256File(path) {
  return soakSha256(readFileSync(path));
}

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function normalizePath(path) {
  return relative(process.cwd(), path).split(sep).join('/');
}

function readOutputMarker(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function ownsOutputDirectory(markerPath) {
  const marker = readOutputMarker(markerPath);
  return marker?.schemaVersion === OUTPUT_MARKER.schemaVersion && marker?.kind === OUTPUT_MARKER.kind;
}

function gitMetadata() {
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  return {
    commit: commit.status === 0 ? commit.stdout.trim() : null,
    workingTreeDirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
  };
}

function extractText(result) {
  return Array.isArray(result?.content)
    ? result.content
        .filter((entry) => entry?.type === 'text' && typeof entry.text === 'string')
        .map((entry) => entry.text)
        .join('\n')
    : '';
}

function sanitizeError(error, roots) {
  let message = error instanceof Error ? error.message : String(error);
  let stack = error instanceof Error ? error.stack ?? null : null;
  for (const root of roots.filter(Boolean).sort((left, right) => right.length - left.length)) {
    message = message.split(root).join('{{workRoot}}');
    if (stack) stack = stack.split(root).join('{{workRoot}}');
  }
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: message.slice(0, 2_000),
    stack: stack?.slice(0, 8_000) ?? null,
    diagnostic: error?.diagnostic ?? null,
  };
}

function configuredRun(options) {
  return {
    durationMs: options.durationMs,
    intervalMs: options.intervalMs,
    faultEvery: options.faultEvery,
    outlierMs: options.outlierMs,
    maxFailures: options.maxFailures,
  };
}

function assertResumeConfig(records, options) {
  const start = records[0]?.payload;
  if (start?.kind !== 'run_start') throw new Error('Existing soak evidence has no run_start record.');
  const expected = JSON.stringify(canonicalizeSoakValue(configuredRun(options)));
  const actual = JSON.stringify(canonicalizeSoakValue(start.config));
  if (actual !== expected) {
    throw new Error(`Resume configuration mismatch. Existing=${actual}; requested=${expected}.`);
  }
  if (records.some((record) => record.payload.kind === 'run_complete')) {
    throw new Error('The soak run is already complete and cannot be resumed.');
  }
}

function latestActiveElapsed(records) {
  return records.reduce(
    (maximum, record) => Math.max(maximum, Number(record.payload.activeElapsedMs ?? 0)),
    0,
  );
}

async function createGovernedRuntime(projectRoot) {
  const [{ loadConfig }, { Container }, { buildRegistry }] = await Promise.all([
    import('../dist/runtime/config.js'),
    import('../dist/runtime/container.js'),
    import('../dist/tools/index.js'),
  ]);
  const config = loadConfig({ projectRoot });
  config.policy.defaultMode = 'dev';
  config.audit.durability = 'required';
  config.adapters.serena.enabled = false;
  config.adapters.playwright.enabled = false;
  config.adapters.desktopCommander.enabled = false;
  const container = new Container(config);
  container.policy.setMode('dev');
  const registry = buildRegistry(container);
  const activated = await registry.callAgent(
    'workspace_activate',
    { path: projectRoot },
    { principal: { id: 'soak:runner', role: 'agent' } },
  );
  if (!activated.ok) throw new Error(`Could not activate soak workspace: ${activated.error ?? 'unknown error'}`);
  return { container, registry };
}

async function createChild(profileRoot) {
  const { StdioChildClient } = await import('../dist/adapters/child-mcp/client.js');
  const child = new StdioChildClient({
    adapter: 'runtime-soak-child',
    command: process.execPath,
    args: [FIXTURE_SERVER],
    cwd: profileRoot,
    env: {
      HOME: profileRoot,
      USERPROFILE: profileRoot,
      TMPDIR: join(profileRoot, 'tmp'),
      TEMP: join(profileRoot, 'tmp'),
      TMP: join(profileRoot, 'tmp'),
      NO_COLOR: '1',
    },
    inheritEnv: false,
    requestTimeoutMs: 10_000,
    heartbeatIntervalMs: 5_000,
    heartbeatTimeoutMs: 2_000,
  });
  await child.start();
  return child;
}

async function verifyGovernanceAudit(projectRoot) {
  const auditPath = join(projectRoot, '.folderforge', 'audit', 'audit.v2.jsonl');
  if (!existsSync(auditPath)) {
    return { ok: false, records: 0, headHash: null, issues: [{ code: 'missing', message: 'Audit file is missing.' }] };
  }
  const { verifyAuditChain } = await import('../dist/evidence/audit-chain.js');
  return verifyAuditChain(readFileSync(auditPath, 'utf8'));
}

function eventLoopMetrics(histogram) {
  const metrics = {
    minMs: Number.isFinite(histogram.min) ? Number((histogram.min / 1e6).toFixed(3)) : 0,
    meanMs: Number.isFinite(histogram.mean) ? Number((histogram.mean / 1e6).toFixed(3)) : 0,
    p95Ms: Number((histogram.percentile(95) / 1e6).toFixed(3)),
    p99Ms: Number((histogram.percentile(99) / 1e6).toFixed(3)),
    maxMs: Number.isFinite(histogram.max) ? Number((histogram.max / 1e6).toFixed(3)) : 0,
  };
  histogram.reset();
  return metrics;
}

async function verifyMode(paths) {
  const verified = verifySoakLog(paths.log);
  writePrivateJson(paths.summary, verified.summary);
  process.stdout.write(`${JSON.stringify({ integrityOk: true, ...verified.summary }, null, 2)}\n`);
}

async function run(options) {
  const paths = {
    outputDir: options.outputDir,
    log: join(options.outputDir, 'evidence.jsonl'),
    summary: join(options.outputDir, 'summary.json'),
    projectRoot: join(options.outputDir, 'project'),
    sentinel: join(options.outputDir, 'project', 'sentinel.txt'),
    marker: join(options.outputDir, OUTPUT_MARKER_NAME),
  };
  if (options.verify) {
    if (!existsSync(paths.log)) throw new Error(`No soak evidence exists at ${paths.log}.`);
    await verifyMode(paths);
    return;
  }
  if (options.reset && existsSync(options.outputDir)) {
    if (!ownsOutputDirectory(paths.marker)) {
      throw new Error(`Refusing to reset unowned directory: ${options.outputDir}`);
    }
    rmSync(options.outputDir, { recursive: true, force: true });
  }
  if (existsSync(options.outputDir) && !ownsOutputDirectory(paths.marker)) {
    throw new Error(`Output directory exists without a valid FolderForge soak marker: ${options.outputDir}`);
  }
  mkdirSync(options.outputDir, { recursive: true });
  if (!existsSync(paths.marker)) writePrivateJson(paths.marker, OUTPUT_MARKER);
  const existing = loadSoakLog(paths.log);
  if (existing.records.length > 0 && !options.resume) {
    throw new Error(`Soak evidence already exists at ${paths.log}; use --resume, --verify, or --reset.`);
  }
  if (existing.records.length === 0 && options.resume) {
    throw new Error(`Cannot resume because no soak evidence exists at ${paths.log}.`);
  }
  mkdirSync(join(paths.projectRoot, 'tmp'), { recursive: true });
  if (!existsSync(paths.sentinel)) {
    writeFileSync(paths.sentinel, 'FolderForge resumable runtime soak sentinel.\n', { encoding: 'utf8', mode: 0o600 });
  }

  const chain = existing.records.length > 0
    ? { ...existing, records: [...existing.records] }
    : newSoakChain();
  if (existing.records.length > 0) assertResumeConfig(existing.records, options);
  if (existing.records.length === 0) {
    appendSoakRecord(paths.log, chain, {
      kind: 'run_start',
      recordedAt: nowIso(),
      activeElapsedMs: 0,
      config: configuredRun(options),
      environment: {
        node: process.version,
        platform: platform(),
        release: release(),
        arch: arch(),
        hostnameHash: soakSha256(hostname()),
        logicalCpuCount: cpus().length,
      },
      source: {
        ...gitMetadata(),
        inputs: [
          normalizePath(fileURLToPath(import.meta.url)),
          normalizePath(resolve('scripts/runtime-soak-lib.mjs')),
          normalizePath(resolve('dist/adapters/child-mcp/client.js')),
          normalizePath(resolve('dist/tools/registry.js')),
          normalizePath(FIXTURE_SERVER),
        ].map((path) => ({ path, sha256: sha256File(resolve(path)) })),
      },
    });
  }

  const baseActiveElapsedMs = latestActiveElapsed(chain.records);
  const segmentStarted = performance.now();
  const segmentId = randomUUID();
  const initialSummary = summarizeSoak(chain.records);
  let sampleNumber = initialSummary.samples;
  let failureCount = initialSummary.failures;
  let child = null;
  let runtime = null;
  let stopSignal = null;
  const onSigint = () => {
    stopSignal = 'SIGINT';
  };
  const onSigterm = () => {
    stopSignal = 'SIGTERM';
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  const activeElapsed = () => baseActiveElapsedMs + (performance.now() - segmentStarted);
  appendSoakRecord(paths.log, chain, {
    kind: 'segment_start',
    segmentId,
    recordedAt: nowIso(),
    activeElapsedMs: Number(baseActiveElapsedMs.toFixed(3)),
    resumed: existing.records.length > 0,
    previousSamples: sampleNumber,
  });

  try {
    runtime = await createGovernedRuntime(paths.projectRoot);
    child = await createChild(paths.projectRoot);
    let nextSampleAt = performance.now();
    while (activeElapsed() < options.durationMs && stopSignal === null) {
      const delay = Math.max(0, nextSampleAt - performance.now());
      if (delay > 0) await sleep(delay);
      nextSampleAt += options.intervalMs;
      if (activeElapsed() >= options.durationMs || stopSignal !== null) break;
      sampleNumber += 1;

      if (options.faultEvery > 0 && sampleNumber > 1 && (sampleNumber - 1) % options.faultEvery === 0) {
        const faultStarted = performance.now();
        const oldPid = child?.pid() ?? null;
        await child?.stopAndWait(3_000);
        child = await createChild(paths.projectRoot);
        appendSoakRecord(paths.log, chain, {
          kind: 'fault',
          faultKind: 'planned_child_restart',
          segmentId,
          sampleNumber,
          recordedAt: nowIso(),
          activeElapsedMs: Number(activeElapsed().toFixed(3)),
          oldPid,
          newPid: child.pid() ?? null,
          recoveryMs: Number((performance.now() - faultStarted).toFixed(3)),
        });
      }

      const sampleStarted = performance.now();
      try {
        const governanceStarted = performance.now();
        const governance = await runtime.registry.callAgent(
          'file_read',
          { path: 'sentinel.txt' },
          { principal: { id: 'soak:runner', role: 'agent' } },
        );
        const governanceMs = performance.now() - governanceStarted;
        if (!governance.ok || !String(governance.data?.content ?? '').includes('resumable runtime soak sentinel')) {
          throw new Error(`Governed file_read failed: ${governance.error ?? 'invalid content'}`);
        }

        const listStarted = performance.now();
        const tools = await child.listTools();
        const childListMs = performance.now() - listStarted;
        if (!tools.some((tool) => tool.name === 'echo') || tools.length !== 2) {
          throw new Error(`Child catalog changed unexpectedly: ${tools.map((tool) => tool.name).join(', ')}`);
        }

        const token = `soak-${chain.runId}-${sampleNumber}`;
        const callStarted = performance.now();
        const childResult = await child.callTool('echo', { text: token });
        const childCallMs = performance.now() - callStarted;
        if (extractText(childResult) !== token) throw new Error('Child echo response did not match the request token.');

        const totalMs = performance.now() - sampleStarted;
        const memory = process.memoryUsage();
        appendSoakRecord(paths.log, chain, {
          kind: 'sample',
          segmentId,
          sampleNumber,
          recordedAt: nowIso(),
          activeElapsedMs: Number(activeElapsed().toFixed(3)),
          outlier: totalMs >= options.outlierMs,
          latencyMs: {
            total: Number(totalMs.toFixed(3)),
            governance: Number(governanceMs.toFixed(3)),
            childList: Number(childListMs.toFixed(3)),
            childCall: Number(childCallMs.toFixed(3)),
          },
          eventLoopDelay: eventLoopMetrics(histogram),
          memory: {
            rssBytes: memory.rss,
            heapTotalBytes: memory.heapTotal,
            heapUsedBytes: memory.heapUsed,
            externalBytes: memory.external,
            arrayBuffersBytes: memory.arrayBuffers,
          },
          governance: {
            ok: true,
            contentSha256: soakSha256(String(governance.data?.content ?? '')),
          },
          child: {
            protocolVersion: child.protocolVersion(),
            pid: child.pid() ?? null,
            toolCount: tools.length,
            transport: child.transportStats(),
          },
        });
      } catch (error) {
        failureCount += 1;
        appendSoakRecord(paths.log, chain, {
          kind: 'failure',
          failureKind: 'sample_failure',
          segmentId,
          sampleNumber,
          recordedAt: nowIso(),
          activeElapsedMs: Number(activeElapsed().toFixed(3)),
          error: sanitizeError(error, [paths.outputDir, process.cwd()]),
          child: child
            ? {
                ready: child.isReady(),
                pid: child.pid() ?? null,
                diagnostic: child.diagnostic(),
                transport: child.transportStats(),
              }
            : null,
        });
        try {
          await child?.stopAndWait(3_000);
        } catch {
          // The failure record above already preserves the primary error.
        }
        child = await createChild(paths.projectRoot).catch((restartError) => {
          appendSoakRecord(paths.log, chain, {
            kind: 'failure',
            failureKind: 'child_recovery_failure',
            segmentId,
            sampleNumber,
            recordedAt: nowIso(),
            activeElapsedMs: Number(activeElapsed().toFixed(3)),
            error: sanitizeError(restartError, [paths.outputDir, process.cwd()]),
          });
          failureCount += 1;
          return null;
        });
        if (!child) break;
      }
    }
  } catch (error) {
    failureCount += 1;
    appendSoakRecord(paths.log, chain, {
      kind: 'failure',
      failureKind: 'segment_failure',
      segmentId,
      sampleNumber,
      recordedAt: nowIso(),
      activeElapsedMs: Number(activeElapsed().toFixed(3)),
      error: sanitizeError(error, [paths.outputDir, process.cwd()]),
    });
  } finally {
    histogram.disable();
    try {
      await child?.stopAndWait(3_000);
    } catch (error) {
      failureCount += 1;
      appendSoakRecord(paths.log, chain, {
        kind: 'failure',
        failureKind: 'shutdown_failure',
        segmentId,
        sampleNumber,
        recordedAt: nowIso(),
        activeElapsedMs: Number(activeElapsed().toFixed(3)),
        error: sanitizeError(error, [paths.outputDir, process.cwd()]),
      });
    }
    appendSoakRecord(paths.log, chain, {
      kind: 'segment_end',
      segmentId,
      recordedAt: nowIso(),
      activeElapsedMs: Number(Math.min(activeElapsed(), options.durationMs).toFixed(3)),
      signal: stopSignal,
      samplesInSegment: sampleNumber - initialSummary.samples,
      failuresObserved: failureCount - initialSummary.failures,
    });
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }

  const durationReached = latestActiveElapsed(chain.records) >= options.durationMs;
  if (durationReached && stopSignal === null) {
    const audit = await verifyGovernanceAudit(paths.projectRoot);
    if (!audit.ok) {
      failureCount += 1;
      appendSoakRecord(paths.log, chain, {
        kind: 'failure',
        failureKind: 'audit_verification_failure',
        segmentId,
        sampleNumber,
        recordedAt: nowIso(),
        activeElapsedMs: Number(options.durationMs.toFixed(3)),
        audit: { records: audit.records, headHash: audit.headHash, issues: audit.issues },
      });
    }
    appendSoakRecord(paths.log, chain, {
      kind: 'run_complete',
      recordedAt: nowIso(),
      activeElapsedMs: Number(options.durationMs.toFixed(3)),
      audit: {
        ok: audit.ok,
        records: audit.records,
        headHash: audit.headHash,
        issues: audit.issues,
      },
      verdict: failureCount <= options.maxFailures && audit.ok ? 'pass' : 'fail',
    });
  }

  const verified = verifySoakLog(paths.log);
  writePrivateJson(paths.summary, verified.summary);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok:
          verified.summary.completed &&
          verified.summary.verdict === 'pass' &&
          verified.summary.failures <= options.maxFailures &&
          stopSignal === null,
        outputDir: paths.outputDir,
        evidence: basename(paths.log),
        summary: basename(paths.summary),
        ...verified.summary,
        interruptedBy: stopSignal,
      },
      null,
      2,
    )}\n`,
  );
  if (stopSignal !== null) {
    process.exitCode = stopSignal === 'SIGINT' ? 130 : 143;
  } else if (
    !verified.summary.completed ||
    verified.summary.verdict !== 'pass' ||
    verified.summary.failures > options.maxFailures
  ) {
    process.exitCode = 1;
  }
}

const options = parseArgs(process.argv.slice(2));
if (options !== null) {
  run(options).catch((error) => {
    process.stderr.write(`Runtime soak failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
