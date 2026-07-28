import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { verifySoakLog } from './runtime-soak-lib.mjs';

const DEFAULT_MINIMUM_DURATION_MS = 24 * 60 * 60 * 1_000;
const MAXIMUM_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const MINIMUM_SAMPLE_RATIO = 0.9;
const COMMIT_RE = /^[0-9a-f]{40}$/i;

function usage() {
  return [
    'Usage: node scripts/verify-production-soak.mjs [options]',
    '',
    'Options:',
    '  --evidence-dir <path>       Directory containing evidence.jsonl',
    '  --commit <sha>              Expected exact Git commit (default: checked-out HEAD)',
    '  --minimum-duration-ms <n>   Required active duration (default: 86400000)',
    '  --receipt <path>            Write a private machine-readable verification receipt',
    '  --help                      Show this help',
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
    evidenceDir: null,
    commit: null,
    minimumDurationMs: DEFAULT_MINIMUM_DURATION_MS,
    receipt: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      process.stdout.write(`${usage()}\n`);
      return null;
    }
    if (
      arg === '--evidence-dir' ||
      arg === '--commit' ||
      arg === '--minimum-duration-ms' ||
      arg === '--receipt'
    ) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value.`);
      index += 1;
      if (arg === '--evidence-dir') options.evidenceDir = resolve(value);
      if (arg === '--commit') options.commit = value;
      if (arg === '--minimum-duration-ms') {
        options.minimumDurationMs = parseInteger(value, arg, 1_000, MAXIMUM_DURATION_MS);
      }
      if (arg === '--receipt') options.receipt = resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.evidenceDir) throw new Error('--evidence-dir is required.');
  return options;
}

function checkedOutCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Could not resolve the checked-out Git commit.');
  return result.stdout.trim();
}

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function verify(options) {
  const expectedCommit = options.commit ?? checkedOutCommit();
  if (!COMMIT_RE.test(expectedCommit)) {
    throw new Error(`Expected commit must be a full 40-character SHA: ${expectedCommit}`);
  }

  const evidencePath = join(options.evidenceDir, 'evidence.jsonl');
  if (!existsSync(evidencePath)) throw new Error(`Missing runtime soak evidence: ${evidencePath}`);
  const verified = verifySoakLog(evidencePath);
  const start = verified.records.find((record) => record.payload.kind === 'run_start')?.payload ?? null;
  const completion = verified.records.findLast(
    (record) => record.payload.kind === 'run_complete',
  )?.payload ?? null;
  const intervalMs = Number(start?.config?.intervalMs);
  const expectedSamples = Number.isFinite(intervalMs) && intervalMs > 0
    ? Math.max(1, Math.floor((options.minimumDurationMs / intervalMs) * MINIMUM_SAMPLE_RATIO))
    : null;

  const issues = [];
  if (start === null) issues.push('evidence has no run_start record');
  if (start?.source?.commit !== expectedCommit) {
    issues.push(`evidence commit ${String(start?.source?.commit)} does not match ${expectedCommit}`);
  }
  if (start?.source?.workingTreeDirty !== false) {
    issues.push('soak did not start from a clean working tree');
  }
  if (Number(verified.summary.plannedDurationMs) < options.minimumDurationMs) {
    issues.push(`planned duration ${String(verified.summary.plannedDurationMs)}ms is below ${options.minimumDurationMs}ms`);
  }
  if (Number(verified.summary.activeElapsedMs) < options.minimumDurationMs) {
    issues.push(`active duration ${String(verified.summary.activeElapsedMs)}ms is below ${options.minimumDurationMs}ms`);
  }
  if (verified.summary.completed !== true || verified.summary.verdict !== 'pass') {
    issues.push(`soak is not complete with a pass verdict (${String(verified.summary.verdict)})`);
  }
  if (verified.summary.failures !== 0) {
    issues.push(`soak contains ${verified.summary.failures} unexpected failure record(s)`);
  }
  if (completion?.audit?.ok !== true) issues.push('governance audit verification did not pass');
  if (expectedSamples === null || verified.summary.samples < expectedSamples) {
    issues.push(
      `sample count ${verified.summary.samples} is below the required ${String(expectedSamples)}`,
    );
  }
  if (Number(start?.config?.faultEvery) > 0 && verified.summary.expectedFaults < 1) {
    issues.push('fault injection was configured but no expected fault was observed');
  }
  if (!verified.summary.headHash) issues.push('evidence chain has no head hash');

  if (issues.length > 0) {
    throw new Error(`Production soak verification failed:\n- ${issues.join('\n- ')}`);
  }

  const receipt = {
    schemaVersion: 1,
    kind: 'folderforge-production-soak-verification',
    verifiedAt: new Date().toISOString(),
    commit: expectedCommit,
    evidencePath: 'evidence.jsonl',
    minimumDurationMs: options.minimumDurationMs,
    minimumSampleRatio: MINIMUM_SAMPLE_RATIO,
    runId: verified.summary.runId,
    headHash: verified.summary.headHash,
    plannedDurationMs: verified.summary.plannedDurationMs,
    activeElapsedMs: verified.summary.activeElapsedMs,
    samples: verified.summary.samples,
    expectedFaults: verified.summary.expectedFaults,
    failures: verified.summary.failures,
    verdict: verified.summary.verdict,
    audit: {
      ok: completion.audit.ok,
      records: completion.audit.records,
      headHash: completion.audit.headHash,
    },
    environment: start.environment,
  };
  if (options.receipt) writePrivateJson(options.receipt, receipt);
  return receipt;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options !== null) process.stdout.write(`${JSON.stringify(verify(options), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
