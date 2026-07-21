import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/runtime-soak.mjs');

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 45_000,
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code));
  });
}

async function waitForSample(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, 'utf8').includes('"kind":"sample"')) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for a sample in ${path}`);
}

describe.sequential('runtime soak runner', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'folderforge-runtime-soak-runner-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('completes governed samples, planned restarts, and evidence verification', () => {
    const output = join(root, 'soak output ünicode');
    const executed = run([
      '--output-dir',
      output,
      '--duration-ms',
      '2500',
      '--interval-ms',
      '200',
      '--fault-every',
      '2',
      '--outlier-ms',
      '1000',
    ]);

    expect(executed.status, executed.stderr).toBe(0);
    const report = JSON.parse(executed.stdout) as {
      completed: boolean;
      samples: number;
      failures: number;
      expectedFaults: number;
      segments: number;
    };
    expect(report).toMatchObject({ completed: true, failures: 0, segments: 1 });
    expect(report.samples).toBeGreaterThanOrEqual(2);
    expect(report.expectedFaults).toBeGreaterThanOrEqual(1);

    const verified = run(['--output-dir', output, '--verify']);
    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ completed: true, failures: 0 });
  }, 30_000);

  it.skipIf(process.platform === 'win32')(
    'resumes a verified incomplete chain after SIGTERM',
    async () => {
      const output = join(root, 'resume');
      const args = [
        SCRIPT,
        '--output-dir',
        output,
        '--duration-ms',
        '5000',
        '--interval-ms',
        '200',
        '--fault-every',
        '4',
      ];
      const child = spawn(process.execPath, args, {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await waitForSample(join(output, 'evidence.jsonl'));
      child.kill('SIGTERM');
      const firstCode = await waitForExit(child);
      expect(firstCode).toBe(143);

      const before = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8')) as {
        completed: boolean;
        samples: number;
        segments: number;
      };
      expect(before.completed).toBe(false);
      expect(before.samples).toBeGreaterThan(0);

      const resumed = run([
        '--output-dir',
        output,
        '--duration-ms',
        '5000',
        '--interval-ms',
        '200',
        '--fault-every',
        '4',
        '--resume',
      ]);
      expect(resumed.status, resumed.stderr).toBe(0);
      const after = JSON.parse(resumed.stdout) as {
        completed: boolean;
        failures: number;
        samples: number;
        segments: number;
      };
      expect(after.completed).toBe(true);
      expect(after.failures).toBe(0);
      expect(after.samples).toBeGreaterThan(before.samples);
      expect(after.segments).toBe(2);
    },
    40_000,
  );

  it('refuses to reset an unowned directory', () => {
    const output = join(root, 'ordinary-directory');
    writeFileSync(join(root, 'keep.txt'), 'keep');
    writeFileSync(output, 'not a directory');

    const executed = run(['--output-dir', output, '--duration-ms', '1000', '--reset']);
    expect(executed.status).not.toBe(0);
    expect(executed.stderr).toMatch(/refusing to reset unowned directory/i);
    expect(readFileSync(output, 'utf8')).toBe('not a directory');
    expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('keep');
  });
});
