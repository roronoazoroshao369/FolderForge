import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface TaskManifest {
  suite: string;
  minimumRunsPerTask: number;
  tasks: Array<{ id: string }>;
}

function result(name: string, hardware: string): Record<string, unknown> {
  const manifestPath = resolve('benchmarks/tasks/agent-evaluation.json');
  const raw = readFileSync(manifestPath);
  const manifest = JSON.parse(raw.toString('utf8')) as TaskManifest;
  const runs = manifest.tasks.flatMap((task) =>
    Array.from({ length: manifest.minimumRunsPerTask }, (_, index) => ({
      taskId: task.id,
      run: index + 1,
      success: index !== 0,
      securityPass: true,
      durationMs: 1000 + index,
      toolCalls: 10 + index,
      tokens: 1000 + index,
      approvals: 1,
      unintendedFiles: 0,
      evidenceSha256: 'a'.repeat(64),
    }))
  );
  return {
    schemaVersion: 1,
    suite: manifest.suite,
    taskManifestSha256: createHash('sha256').update(raw).digest('hex'),
    system: {
      name,
      version: '1.0.0',
      commit: 'abcdef1234567890',
      agent: 'fixture-agent',
      model: 'fixture-model',
      os: 'linux',
      hardware,
    },
    runs,
  };
}

describe('benchmark result validation and comparison scripts', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'folderforge-benchmark-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts complete immutable-manifest results and renders a comparison', () => {
    const first = join(root, 'first.json');
    const second = join(root, 'second.json');
    writeFileSync(first, JSON.stringify(result('FolderForge', 'same-machine')));
    writeFileSync(second, JSON.stringify(result('Comparator', 'same-machine')));

    const validated = spawnSync(
      process.execPath,
      ['scripts/validate-benchmark-results.mjs', first, second],
      { cwd: process.cwd(), encoding: 'utf8' }
    );
    expect(validated.status).toBe(0);
    expect(validated.stdout).toContain('valid (40 runs');

    const compared = spawnSync(
      process.execPath,
      ['scripts/compare-benchmarks.mjs', '--allow-unverified', first, second],
      { cwd: process.cwd(), encoding: 'utf8' }
    );
    expect(compared.status).toBe(0);
    expect(compared.stdout).toContain('| FolderForge 1.0.0 | 40 | 80.0% | 100.0% |');
    expect(compared.stdout).toContain('Latency is comparable');
  });

  it('rejects missing runs, duplicate identities, and stale manifest hashes', () => {
    const invalid = result('Invalid', 'machine') as {
      taskManifestSha256: string;
      runs: Array<Record<string, unknown>>;
    };
    invalid.taskManifestSha256 = 'b'.repeat(64);
    invalid.runs.push({ ...invalid.runs[0] });
    const path = join(root, 'invalid.json');
    writeFileSync(path, JSON.stringify(invalid));

    const executed = spawnSync(
      process.execPath,
      ['scripts/validate-benchmark-results.mjs', path],
      { cwd: process.cwd(), encoding: 'utf8' }
    );
    expect(executed.status).not.toBe(0);
    expect(executed.stderr).toMatch(/task manifest hash does not match/i);
  });

  it('hides latency when hardware declarations differ', () => {
    const first = join(root, 'first.json');
    const second = join(root, 'second.json');
    writeFileSync(first, JSON.stringify(result('One', 'machine-a')));
    writeFileSync(second, JSON.stringify(result('Two', 'machine-b')));

    const compared = spawnSync(
      process.execPath,
      ['scripts/compare-benchmarks.mjs', '--allow-unverified', first, second],
      { cwd: process.cwd(), encoding: 'utf8' }
    );
    expect(compared.status).toBe(0);
    expect(compared.stdout).toContain('| One 1.0.0 | 40 | 80.0% | 100.0% | n/a* |');
    expect(compared.stdout).toContain('Latency is hidden');
  });
});
