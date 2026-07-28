import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  appendSoakRecord,
  newSoakChain,
} from '../../scripts/runtime-soak-lib.mjs';

const SCRIPT = resolve('scripts/verify-production-soak.mjs');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function evidence(options: { commit?: string; dirty?: boolean; durationMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-production-soak-'));
  roots.push(root);
  const log = join(root, 'evidence.jsonl');
  const chain = newSoakChain();
  const durationMs = options.durationMs ?? 1_000;
  appendSoakRecord(log, chain, {
    kind: 'run_start',
    recordedAt: '2026-07-28T00:00:00.000Z',
    activeElapsedMs: 0,
    config: {
      durationMs,
      intervalMs: 500,
      faultEvery: 2,
      outlierMs: 1_000,
      maxFailures: 0,
    },
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    source: {
      commit: options.commit ?? COMMIT,
      workingTreeDirty: options.dirty ?? false,
      inputs: [],
    },
  });
  appendSoakRecord(log, chain, {
    kind: 'sample',
    recordedAt: '2026-07-28T00:00:00.500Z',
    activeElapsedMs: 500,
    latencyMs: { total: 1, governance: 1, childList: 1, childCall: 1 },
    memory: { rssBytes: 1, heapUsedBytes: 1 },
  });
  appendSoakRecord(log, chain, {
    kind: 'sample',
    recordedAt: '2026-07-28T00:00:01.000Z',
    activeElapsedMs: durationMs,
    latencyMs: { total: 1, governance: 1, childList: 1, childCall: 1 },
    memory: { rssBytes: 1, heapUsedBytes: 1 },
  });
  appendSoakRecord(log, chain, {
    kind: 'fault',
    recordedAt: '2026-07-28T00:00:01.000Z',
    activeElapsedMs: durationMs,
  });
  appendSoakRecord(log, chain, {
    kind: 'run_complete',
    recordedAt: '2026-07-28T00:00:01.000Z',
    activeElapsedMs: durationMs,
    verdict: 'pass',
    audit: { ok: true, records: 3, headHash: 'audit-head', issues: [] },
  });
  return root;
}

describe('production soak verifier', () => {
  it('accepts commit-bound clean evidence and writes a receipt', () => {
    const root = evidence();
    const receipt = join(root, 'receipt.json');
    const executed = spawnSync(
      process.execPath,
      [
        SCRIPT,
        '--evidence-dir',
        root,
        '--commit',
        COMMIT,
        '--minimum-duration-ms',
        '1000',
        '--receipt',
        receipt,
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(executed.status).toBe(0);
    expect(existsSync(receipt)).toBe(true);
    expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({
      kind: 'folderforge-production-soak-verification',
      commit: COMMIT,
      activeElapsedMs: 1_000,
      failures: 0,
      verdict: 'pass',
      audit: { ok: true },
    });
  });

  it('rejects evidence from another commit or a dirty tree', () => {
    const root = evidence({ dirty: true });
    const executed = spawnSync(
      process.execPath,
      [SCRIPT, '--evidence-dir', root, '--commit', 'f'.repeat(40), '--minimum-duration-ms', '1000'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(executed.status).not.toBe(0);
    expect(executed.stderr).toMatch(/does not match/);
    expect(executed.stderr).toMatch(/clean working tree/);
  });

  it('rejects a run shorter than the production threshold', () => {
    const root = evidence({ durationMs: 1_000 });
    const executed = spawnSync(
      process.execPath,
      [SCRIPT, '--evidence-dir', root, '--commit', COMMIT, '--minimum-duration-ms', '2000'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(executed.status).not.toBe(0);
    expect(executed.stderr).toMatch(/planned duration 1000ms is below 2000ms/);
    expect(executed.stderr).toMatch(/active duration 1000ms is below 2000ms/);
  });
});
