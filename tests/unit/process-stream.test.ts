import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { ProcessManager } from '../../src/managers/process-manager.js';
import { defaultShell, quoteShellArg } from '../../src/core/shell.js';

const SHELL = defaultShell();
const CWD = tmpdir();
const nodeCommand = (source: string): string =>
  [process.execPath, '-e', source]
    .map((value) => quoteShellArg(SHELL, value))
    .join(' ');
const delayedLine = nodeCommand("setTimeout(()=>console.log('later-line'),150)");
const keepAlive = nodeCommand('setTimeout(()=>{},5000)');

async function waitForExit(pm: ProcessManager, sessionId: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = pm.list().find((item) => item.sessionId === sessionId);
    if (session?.status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Managed process did not exit within ${timeoutMs}ms: ${sessionId}`);
}

describe('ProcessManager streaming (readUntil)', () => {
  it('drains buffered output immediately', async () => {
    const pm = new ProcessManager();
    const s = pm.start('echo hello-stream', CWD, SHELL);
    // Wait for the real exit event instead of assuming a fixed scheduler delay.
    await waitForExit(pm, s.sessionId);
    const out = await pm.readUntil(s.sessionId, 1000);
    expect(out.output).toContain('hello-stream');
    expect(out.done).toBe(true);
    pm.stop(s.sessionId);
  });

  it('blocks then resolves when new output arrives', async () => {
    const pm = new ProcessManager();
    const s = pm.start(delayedLine, CWD, SHELL);
    const started = Date.now();
    const out = await pm.readUntil(s.sessionId, 2000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(out.output).toContain('later-line');
    pm.stop(s.sessionId);
  });

  it('returns (possibly empty) after timeout without busy-waiting', async () => {
    const pm = new ProcessManager();
    const s = pm.start(keepAlive, CWD, SHELL);
    const started = Date.now();
    const out = await pm.readUntil(s.sessionId, 200);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(1000);
    expect(out.done).toBe(false);
    pm.kill(s.sessionId);
  });

  it('reports done once exited and drained', async () => {
    const pm = new ProcessManager();
    const s = pm.start('echo a', CWD, SHELL);
    await waitForExit(pm, s.sessionId);
    const first = await pm.readUntil(s.sessionId, 500);
    expect(first.output).toContain('a');
    const second = await pm.readUntil(s.sessionId, 200);
    expect(second.done).toBe(true);
    expect(second.output).toBe('');
  });

  it('wakes a long-poll when a managed process is stopped', async () => {
    const pm = new ProcessManager();
    const s = pm.start(keepAlive, CWD, SHELL);
    const started = Date.now();
    const pending = pm.readUntil(s.sessionId, 5000);
    setTimeout(() => pm.stop(s.sessionId), 100);
    const out = await pending;
    expect(Date.now() - started).toBeLessThan(1500);
    expect(out.status).toBe('killed');
    expect(out.done).toBe(true);
  });

  it('wakes immediately when the abort signal fires mid-wait (P6)', async () => {
    const pm = new ProcessManager();
    const s = pm.start(keepAlive, CWD, SHELL);
    const ac = new AbortController();
    const started = Date.now();
    // Cancel after ~100ms; the long-poll should resolve well before timeoutMs.
    setTimeout(() => ac.abort(), 100);
    const out = await pm.readUntil(s.sessionId, 5000, ac.signal);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expect(out.done).toBe(false);
    pm.kill(s.sessionId);
  });

  it('returns immediately when the signal is already aborted (P6)', async () => {
    const pm = new ProcessManager();
    const s = pm.start(keepAlive, CWD, SHELL);
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    const out = await pm.readUntil(s.sessionId, 5000, ac.signal);
    expect(Date.now() - started).toBeLessThan(100);
    expect(out.done).toBe(false);
    pm.kill(s.sessionId);
  });
});
