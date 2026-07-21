import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBenchmarkArgs, redactBenchmarkText, runBenchmarkSuite } from '../../scripts/run-benchmarks.mjs';
import { loadResult } from '../../scripts/benchmark-lib.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('benchmark execution runner', () => {
  it('parses a no-shell harness contract and redacts common credentials', () => {
    const parsed = parseBenchmarkArgs([
      '--command', process.execPath,
      '--command-args-json', '["harness.mjs"]',
      '--system-name', 'FolderForge',
      '--system-version', '2.5.0',
      '--commit', 'abcdef123',
      '--agent', 'test-agent',
      '--model', 'test-model',
      '--runs', '1',
      '--env-allow', 'BENCHMARK_TEST_VALUE',
    ]);
    expect(parsed.commandArgs).toEqual(['harness.mjs']);
    expect(parsed.envAllow).toContain('BENCHMARK_TEST_VALUE');
    expect(redactBenchmarkText('Authorization: Bearer abc OPENAI_API_KEY=secret')).toContain('[REDACTED]');
    expect(redactBenchmarkText('Authorization: Bearer abc OPENAI_API_KEY=secret')).not.toContain('secret');
  });

  it('runs every frozen task, stores redacted evidence hashes, and writes a result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-benchmark-runner-'));
    roots.push(root);
    const output = join(root, 'result.json');
    const evidenceDir = join(root, 'evidence');
    const completed = await runBenchmarkSuite({
      manifest: resolve('benchmarks/tasks/agent-evaluation.json'),
      output,
      evidenceDir,
      runs: 5,
      timeoutMs: 30_000,
      command: process.execPath,
      commandArgs: [resolve('tests/fixtures/benchmark-harness.mjs')],
      system: { name: 'FolderForge', version: '2.5.0', commit: 'abcdef123', agent: 'test-agent', model: 'test-model' },
      keepWorkdirs: false,
      envAllow: [],
    });
    expect(completed.result.runs).toHaveLength(40);
    expect(completed.result.runs.every((run) => run.success && run.securityPass)).toBe(true);
    expect(completed.result.runs.every((run) => /^[a-f0-9]{64}$/.test(run.evidenceSha256))).toBe(true);
    expect(completed.result.runs.every((run) => typeof run.evidenceFile === 'string')).toBe(true);
    expect(() => loadResult(output, { verifyEvidence: true })).not.toThrow();
    const persisted = JSON.parse(readFileSync(output, 'utf8')) as {
      runs: Array<{ evidenceFile: string }>;
    };
    expect(persisted.runs).toHaveLength(40);

    const firstEvidence = resolve(root, persisted.runs[0]!.evidenceFile);
    writeFileSync(firstEvidence, '{"tampered":true}\n');
    expect(() => loadResult(output, { verifyEvidence: true })).toThrow(/does not match/i);

    persisted.runs[0]!.evidenceFile = '../outside.json';
    writeFileSync(output, JSON.stringify(persisted));
    expect(() => loadResult(output, { verifyEvidence: true })).toThrow(/escapes the result directory/i);
  }, 30_000);
});
