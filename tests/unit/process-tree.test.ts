import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

import {
  processCommandLine,
  terminateChildProcessTree,
  terminatePidTree,
} from '../../src/core/process-tree.js';

const itPosix = process.platform === 'win32' ? it.skip : it;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

function spawnDetached(command: string): ChildProcess {
  const child = spawn('sh', ['-c', command], {
    detached: true,
    stdio: 'ignore',
  });
  if (child.pid === undefined) throw new Error('test spawn returned no pid');
  return child;
}

describe('process-tree', () => {
  it('terminateChildProcessTree is a no-op for an already-exited child', () => {
    const fake = { exitCode: 0, signalCode: null } as unknown as ChildProcess;
    expect(() => terminateChildProcessTree(fake)).not.toThrow();
    expect(() => terminateChildProcessTree(fake, true)).not.toThrow();
  });

  itPosix('terminateChildProcessTree kills the whole POSIX group, including grandchildren', async () => {
    // Backgrounded grandchild: the shell does NOT exec it, so a plain
    // child.kill() would leave `sleep` orphaned. Group kill must reap both.
    const child = spawnDetached('sleep 30 & sleep 30 & wait');
    const pid = child.pid!;
    expect(groupAlive(pid)).toBe(true);

    terminateChildProcessTree(child, true);
    await once(child, 'exit');

    expect(await waitUntil(() => !pidAlive(pid))).toBe(true);
    expect(await waitUntil(() => !groupAlive(pid))).toBe(true);
  });

  itPosix('terminatePidTree reaps a detached orphan by pid', async () => {
    const child = spawnDetached('sleep 30');
    const pid = child.pid!;
    child.unref();

    terminatePidTree(pid, true);

    expect(await waitUntil(() => !pidAlive(pid))).toBe(true);
    expect(await waitUntil(() => !groupAlive(pid))).toBe(true);
  });

  itPosix('terminatePidTree falls back to the lone pid when it is not a group leader', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    const pid = child.pid!;

    terminatePidTree(pid, true);
    await once(child, 'exit');

    expect(await waitUntil(() => !pidAlive(pid))).toBe(true);
  });

  itPosix('terminatePidTree ignores an already-dead pid', () => {
    // Far beyond any realistic pid_max; must simply not throw.
    expect(() => terminatePidTree(99_999_999)).not.toThrow();
    expect(() => terminatePidTree(99_999_999, true)).not.toThrow();
  });

  it('processCommandLine reads the current process and refuses unknown pids', () => {
    if (process.platform === 'win32') {
      expect(processCommandLine(process.pid)).toBeUndefined();
      return;
    }
    const self = processCommandLine(process.pid);
    expect(typeof self).toBe('string');
    expect(self!.length).toBeGreaterThan(0);
    expect(self).toContain('node');
    expect(processCommandLine(99_999_999)).toBeUndefined();
  });
});
