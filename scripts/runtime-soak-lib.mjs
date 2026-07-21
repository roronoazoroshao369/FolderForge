import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const SOAK_SCHEMA_VERSION = 1;
const HASH_RE = /^sha256:[a-f0-9]{64}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function canonicalizeSoakValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeSoakValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeSoakValue(entry)]),
    );
  }
  return value;
}

export function soakSha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function soakEnvelopeHash(envelopeWithoutHash) {
  return soakSha256(JSON.stringify(canonicalizeSoakValue(envelopeWithoutHash)));
}

export function createSoakEnvelope({ runId, sequence, previousHash, payload }) {
  if (typeof runId !== 'string' || runId.length < 8) throw new Error('runId must be a non-empty stable identifier.');
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('sequence must be a positive safe integer.');
  if (sequence === 1 && previousHash !== null) throw new Error('The first soak record must use previousHash=null.');
  if (sequence > 1 && (typeof previousHash !== 'string' || !HASH_RE.test(previousHash))) {
    throw new Error('Non-initial soak records require a valid previousHash.');
  }
  if (!isPlainObject(payload) || typeof payload.kind !== 'string') {
    throw new Error('Soak payload must be an object with a kind.');
  }
  const unsigned = {
    schemaVersion: SOAK_SCHEMA_VERSION,
    runId,
    sequence,
    previousHash,
    payload: canonicalizeSoakValue(payload),
  };
  return { ...unsigned, hash: soakEnvelopeHash(unsigned) };
}

function validateEnvelope(record, expectedSequence, expectedPreviousHash, runId) {
  if (!isPlainObject(record)) throw new Error(`Soak record ${expectedSequence} is not an object.`);
  if (record.schemaVersion !== SOAK_SCHEMA_VERSION) {
    throw new Error(`Soak record ${expectedSequence} has unsupported schemaVersion.`);
  }
  if (record.runId !== runId) throw new Error(`Soak record ${expectedSequence} changed runId.`);
  if (record.sequence !== expectedSequence) {
    throw new Error(`Soak sequence mismatch: expected ${expectedSequence}, got ${String(record.sequence)}.`);
  }
  if (record.previousHash !== expectedPreviousHash) {
    throw new Error(`Soak chain mismatch at sequence ${expectedSequence}.`);
  }
  if (!isPlainObject(record.payload) || typeof record.payload.kind !== 'string') {
    throw new Error(`Soak record ${expectedSequence} has an invalid payload.`);
  }
  if (typeof record.hash !== 'string' || !HASH_RE.test(record.hash)) {
    throw new Error(`Soak record ${expectedSequence} has an invalid hash.`);
  }
  const unsigned = {
    schemaVersion: record.schemaVersion,
    runId: record.runId,
    sequence: record.sequence,
    previousHash: record.previousHash,
    payload: canonicalizeSoakValue(record.payload),
  };
  const expectedHash = soakEnvelopeHash(unsigned);
  if (record.hash !== expectedHash) {
    throw new Error(`Soak record ${expectedSequence} hash mismatch.`);
  }
  return { ...unsigned, hash: record.hash };
}

export function parseSoakLog(text) {
  const source = String(text ?? '');
  if (source.length === 0) {
    return { records: [], runId: null, headHash: null, nextSequence: 1 };
  }
  if (!source.endsWith('\n')) {
    throw new Error('Soak evidence ends with an incomplete JSONL record.');
  }
  const lines = source.split('\n');
  lines.pop();
  if (lines.some((line) => line.length === 0)) {
    throw new Error('Soak evidence contains an empty record.');
  }
  let runId = null;
  let previousHash = null;
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    let parsed;
    try {
      parsed = JSON.parse(lines[index]);
    } catch (error) {
      throw new Error(`Soak record ${index + 1} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (index === 0) {
      if (typeof parsed?.runId !== 'string' || parsed.runId.length < 8) {
        throw new Error('The first soak record has an invalid runId.');
      }
      runId = parsed.runId;
    }
    const validated = validateEnvelope(parsed, index + 1, previousHash, runId);
    records.push(validated);
    previousHash = validated.hash;
  }
  if (records[0]?.payload.kind !== 'run_start') {
    throw new Error('The first soak payload must be run_start.');
  }
  return {
    records,
    runId,
    headHash: previousHash,
    nextSequence: records.length + 1,
  };
}

export function loadSoakLog(path) {
  if (!existsSync(path)) return parseSoakLog('');
  return parseSoakLog(readFileSync(path, 'utf8'));
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (written <= 0) throw new Error('Could not append the complete soak evidence record.');
    offset += written;
  }
}

export function appendSoakRecord(path, chain, payload) {
  const envelope = createSoakEnvelope({
    runId: chain.runId,
    sequence: chain.nextSequence,
    previousHash: chain.headHash,
    payload,
  });
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a', 0o600);
  try {
    writeAll(fd, Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8'));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  chain.records.push(envelope);
  chain.headHash = envelope.hash;
  chain.nextSequence += 1;
  return envelope;
}

export function newSoakChain(runId = randomUUID()) {
  return { records: [], runId, headHash: null, nextSequence: 1 };
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Number(sorted[index].toFixed(3));
}

function metricSummary(values) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  return {
    count: finite.length,
    min: finite.length ? Number(finite[0].toFixed(3)) : null,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    p99: percentile(finite, 0.99),
    max: finite.length ? Number(finite.at(-1).toFixed(3)) : null,
  };
}

export function summarizeSoak(records) {
  const start = records.find((record) => record.payload.kind === 'run_start')?.payload ?? null;
  const samples = records.filter((record) => record.payload.kind === 'sample').map((record) => record.payload);
  const failures = records.filter((record) => record.payload.kind === 'failure').map((record) => record.payload);
  const faults = records.filter((record) => record.payload.kind === 'fault').map((record) => record.payload);
  const segments = records.filter((record) => record.payload.kind === 'segment_start').length;
  const completion = records.findLast((record) => record.payload.kind === 'run_complete')?.payload ?? null;
  const completed = completion !== null;
  const last = records.at(-1) ?? null;
  const activeElapsedMs = records.reduce(
    (maximum, record) => Math.max(maximum, Number(record.payload.activeElapsedMs ?? 0)),
    0,
  );
  const rss = samples.map((sample) => Number(sample.memory?.rssBytes)).filter(Number.isFinite);
  const heap = samples.map((sample) => Number(sample.memory?.heapUsedBytes)).filter(Number.isFinite);
  return {
    schemaVersion: SOAK_SCHEMA_VERSION,
    runId: records[0]?.runId ?? null,
    headHash: last?.hash ?? null,
    recordCount: records.length,
    startedAt: start?.recordedAt ?? null,
    lastRecordedAt: last?.payload.recordedAt ?? null,
    plannedDurationMs: start?.config?.durationMs ?? null,
    activeElapsedMs: Number(activeElapsedMs.toFixed(3)),
    completed,
    verdict: completion?.verdict ?? null,
    segments,
    samples: samples.length,
    failures: failures.length,
    expectedFaults: faults.length,
    outliers: samples.filter((sample) => sample.outlier === true).length,
    latencyMs: {
      total: metricSummary(samples.map((sample) => Number(sample.latencyMs?.total))),
      governance: metricSummary(samples.map((sample) => Number(sample.latencyMs?.governance))),
      childList: metricSummary(samples.map((sample) => Number(sample.latencyMs?.childList))),
      childCall: metricSummary(samples.map((sample) => Number(sample.latencyMs?.childCall))),
    },
    memory: {
      rssBytes: metricSummary(rss),
      heapUsedBytes: metricSummary(heap),
      rssDeltaBytes: rss.length >= 2 ? rss.at(-1) - rss[0] : 0,
      heapDeltaBytes: heap.length >= 2 ? heap.at(-1) - heap[0] : 0,
    },
    failureKinds: Object.fromEntries(
      [...new Set(failures.map((failure) => String(failure.failureKind ?? 'unknown')))]
        .sort()
        .map((kind) => [kind, failures.filter((failure) => String(failure.failureKind ?? 'unknown') === kind).length]),
    ),
  };
}

export function verifySoakLog(path) {
  const parsed = loadSoakLog(path);
  return { ...parsed, summary: summarizeSoak(parsed.records) };
}
