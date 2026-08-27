import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { ProcessManager } from '../../src/managers/process-manager.js';

async function waitForExit(manager: ProcessManager, sessionId: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const session = manager.list().find((s) => s.sessionId === sessionId);
    if (session && session.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('ProcessManager spawn failures', () => {
  it('a missing shell marks the session exited with the error in output instead of crashing the process', async () => {
    const manager = new ProcessManager();
    const missing = '/bin/definitely-missing-shell-folderforge';
    const session = manager.start('echo hello', tmpdir(), missing);
    await waitForExit(manager, session.sessionId);
    const after = manager.list().find((s) => s.sessionId === session.sessionId);
    expect(after?.status).toBe('exited');
    expect(after?.exitCode).toBeNull();
    const output = manager.read(session.sessionId).output;
    expect(output).toContain('failed to start');
    expect(output).toContain(missing);
    // Reaching this assertion at all proves the host process survived.
  });

  it('onExit listeners fire for spawn failures too', async () => {
    const manager = new ProcessManager();
    const session = manager.start('echo hello', tmpdir(), '/bin/definitely-missing-shell-folderforge');
    let fired = 0;
    manager.onExit(session.sessionId, () => {
      fired += 1;
    });
    await waitForExit(manager, session.sessionId);
    expect(fired).toBe(1);
  });

  it('a real shell still runs commands normally', async () => {
    const manager = new ProcessManager();
    const session = manager.start('echo spawn-ok', tmpdir(), '/bin/sh');
    await waitForExit(manager, session.sessionId);
    const after = manager.list().find((s) => s.sessionId === session.sessionId);
    expect(after?.status).toBe('exited');
    expect(after?.exitCode).toBe(0);
    expect(manager.read(session.sessionId).output).toContain('spawn-ok');
  });

  it('peek reads buffered output without consuming the read cursor', async () => {
    const manager = new ProcessManager();
    const session = manager.start('echo peek-me', tmpdir(), '/bin/sh');
    await waitForExit(manager, session.sessionId);
    const peeked = manager.peek(session.sessionId);
    expect(peeked.output).toContain('peek-me');
    expect(peeked.status).toBe('exited');
    expect(manager.read(session.sessionId).output).toContain('peek-me');
  });
});
