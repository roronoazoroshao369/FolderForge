import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendSoakRecord,
  createSoakEnvelope,
  newSoakChain,
  parseSoakLog,
  verifySoakLog,
} from '../../scripts/runtime-soak-lib.mjs';

describe('runtime soak evidence chain', () => {
  let root: string;
  let logPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'folderforge-runtime-soak-chain-'));
    logPath = join(root, 'evidence.jsonl');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('persists and summarizes a complete hash-chained run', () => {
    const chain = newSoakChain('soak-test-run-0001');
    appendSoakRecord(logPath, chain, {
      kind: 'run_start',
      recordedAt: '2026-07-21T00:00:00.000Z',
      activeElapsedMs: 0,
      config: { durationMs: 1_000 },
    });
    appendSoakRecord(logPath, chain, {
      kind: 'segment_start',
      recordedAt: '2026-07-21T00:00:00.100Z',
      activeElapsedMs: 0,
    });
    appendSoakRecord(logPath, chain, {
      kind: 'sample',
      recordedAt: '2026-07-21T00:00:00.500Z',
      activeElapsedMs: 500,
      outlier: true,
      latencyMs: { total: 42, governance: 30, childList: 7, childCall: 5 },
      memory: { rssBytes: 100, heapUsedBytes: 50 },
    });
    appendSoakRecord(logPath, chain, {
      kind: 'run_complete',
      recordedAt: '2026-07-21T00:00:01.000Z',
      activeElapsedMs: 1_000,
      verdict: 'pass',
    });

    const verified = verifySoakLog(logPath);
    expect(verified.summary).toMatchObject({
      completed: true,
      samples: 1,
      failures: 0,
      outliers: 1,
      activeElapsedMs: 1_000,
      headHash: chain.headHash,
    });
    expect(verified.summary.latencyMs.total).toMatchObject({ min: 42, p50: 42, max: 42 });
  });

  it('rejects modified and truncated evidence', () => {
    const chain = newSoakChain('soak-test-run-0002');
    appendSoakRecord(logPath, chain, {
      kind: 'run_start',
      recordedAt: '2026-07-21T00:00:00.000Z',
      activeElapsedMs: 0,
      config: { durationMs: 1_000 },
    });
    appendSoakRecord(logPath, chain, {
      kind: 'sample',
      recordedAt: '2026-07-21T00:00:00.500Z',
      activeElapsedMs: 500,
      outlier: false,
      latencyMs: { total: 1 },
      memory: { rssBytes: 100, heapUsedBytes: 50 },
    });

    const original = readFileSync(logPath, 'utf8');
    const records = original.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const payload = records[1]!.payload as Record<string, unknown>;
    payload.activeElapsedMs = 999;
    writeFileSync(logPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    expect(() => verifySoakLog(logPath)).toThrow(/hash mismatch/i);

    writeFileSync(logPath, original.slice(0, -1));
    expect(() => verifySoakLog(logPath)).toThrow(/incomplete JSONL/i);
  });

  it('handles a large sample count without spreading records onto the stack', () => {
    const runId = 'soak-test-run-large';
    const lines: string[] = [];
    let previousHash: string | null = null;
    for (let sequence = 1; sequence <= 5_001; sequence += 1) {
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
                config: { durationMs: 86_400_000 },
              }
            : { kind: 'sample', activeElapsedMs: (sequence - 1) * 1_000 },
      });
      lines.push(JSON.stringify(envelope));
      previousHash = envelope.hash;
    }
    const parsed = parseSoakLog(`${lines.join('\n')}\n`);
    expect(parsed.records).toHaveLength(5_001);
    expect(parsed.records.at(-1)?.payload.activeElapsedMs).toBe(5_000_000);
  }, 10_000);
});
