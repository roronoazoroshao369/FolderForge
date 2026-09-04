import { describe, expect, it } from 'vitest';

import { ProcessManager } from '../../src/managers/process-manager.js';

const itPosix = process.platform === 'win32' ? it.skip : it;
const SHELL = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';

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

describe('ProcessManager', () => {
  itPosix('captures output and still applies the per-session env overlay', async () => {
    const pm = new ProcessManager();
    const session = pm.start('echo "ff-pm-$FF_PM_TEST"', process.cwd(), SHELL, {
      FF_PM_TEST: 'overlay-ok',
    });
    // Drain until the exit event lands: fresh output may wake readUntil while
    // the process is still mid-stream, which is not completion.
    let output = '';
    let done = false;
    for (let attempt = 0; attempt < 5 && !done; attempt += 1) {
      const drained = await pm.readUntil(session.sessionId, 1_000);
      output += drained.output;
      done = drained.done;
    }
    expect(done).toBe(true);
    expect(output).toContain('ff-pm-overlay-ok');
    expect(pm.read(session.sessionId).status).not.toBe('running');
  });

  itPosix('spawns each session as its own process-group leader', async () => {
    const pm = new ProcessManager();
    const session = pm.start('sleep 30', process.cwd(), SHELL);
    expect(session.pid).toBeDefined();
    const pid = session.pid!;
    // A resolvable negative-pid group proves the child leads its own group.
    expect(groupAlive(pid)).toBe(true);
    pm.kill(session.sessionId);
    expect(await waitUntil(() => !pidAlive(pid))).toBe(true);
  });

  itPosix('stop() kills the whole tree, including shell-forked grandchildren', async () => {
    const pm = new ProcessManager();
    const session = pm.start('sleep 31 & sleep 31 & wait', process.cwd(), SHELL);
    const pid = session.pid!;
    expect(groupAlive(pid)).toBe(true);

    pm.stop(session.sessionId);

    expect(pm.read(session.sessionId).status).toBe('killed');
    expect(await waitUntil(() => !pidAlive(pid))).toBe(true);
    // No orphan left behind: the whole process group is gone.
    expect(await waitUntil(() => !groupAlive(pid))).toBe(true);
  });

  itPosix('stopAllAndWait stops every running session and waits for the exits', async () => {
    const pm = new ProcessManager();
    const first = pm.start('sleep 32', process.cwd(), SHELL);
    const second = pm.start('sleep 32 & wait', process.cwd(), SHELL);

    await pm.stopAllAndWait(2_000);

    expect(pm.read(first.sessionId).status).toBe('killed');
    expect(pm.read(second.sessionId).status).toBe('killed');
    expect(await waitUntil(() => !pidAlive(first.pid!))).toBe(true);
    expect(await waitUntil(() => !pidAlive(second.pid!))).toBe(true);
    expect(await waitUntil(() => !groupAlive(first.pid!))).toBe(true);
    expect(await waitUntil(() => !groupAlive(second.pid!))).toBe(true);
  });

  it('stopAllAndWait resolves immediately when nothing is running', async () => {
    const pm = new ProcessManager();
    await expect(pm.stopAllAndWait()).resolves.toBeUndefined();
    const exited = pm.start('true', process.cwd(), SHELL);
    await pm.readUntil(exited.sessionId, 2_000);
    await expect(pm.stopAllAndWait()).resolves.toBeUndefined();
  });
});
