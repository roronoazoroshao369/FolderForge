import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createSoakEnvelope, parseSoakLog } from './runtime-soak-lib.mjs';

const RECORD_COUNT = 90_001;
const ACTIVE_DURATION_MS = 90_000_000;

function parseArgs(argv) {
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') {
      const value = argv[index + 1];
      if (!value) throw new Error('--output requires a path.');
      output = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { output };
}

const options = parseArgs(process.argv.slice(2));
const startedAt = performance.now();
const runId = 'folderforge-runtime-soak-volume-gate';
const lines = new Array(RECORD_COUNT);
let previousHash = null;
for (let sequence = 1; sequence <= RECORD_COUNT; sequence += 1) {
  const envelope = createSoakEnvelope({
    runId,
    sequence,
    previousHash,
    payload:
      sequence === 1
        ? {
            kind: 'run_start',
            recordedAt: '2026-07-21T00:00:00.000Z',
            activeElapsedMs: 0,
            config: { durationMs: 86_400_000, intervalMs: 1_000 },
          }
        : {
            kind: 'sample',
            sampleNumber: sequence - 1,
            activeElapsedMs: (sequence - 1) * 1_000,
          },
  });
  lines[sequence - 1] = JSON.stringify(envelope);
  previousHash = envelope.hash;
}

const encoded = `${lines.join('\n')}\n`;
const parsed = parseSoakLog(encoded);
if (parsed.records.length !== RECORD_COUNT) {
  throw new Error(`Expected ${RECORD_COUNT} records, got ${parsed.records.length}.`);
}
if (parsed.records.at(-1)?.payload.activeElapsedMs !== ACTIVE_DURATION_MS) {
  throw new Error('The final active duration does not match the full-day volume model.');
}
if (parsed.headHash !== previousHash) throw new Error('The parsed head hash changed.');

const report = {
  ok: true,
  schemaVersion: 1,
  records: parsed.records.length,
  samples: parsed.records.length - 1,
  activeElapsedMs: ACTIVE_DURATION_MS,
  encodedBytes: Buffer.byteLength(encoded),
  headHash: parsed.headHash,
  elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
  memory: process.memoryUsage(),
  limitation:
    'This gate proves evidence-chain volume handling only; it is not a 24-hour runtime reliability observation.',
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (options.output) {
  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, serialized, { encoding: 'utf8', mode: 0o600 });
}
process.stdout.write(serialized);
