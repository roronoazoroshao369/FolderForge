import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { shellCommandArgs, shellSpawnOptions } from '../core/shell.js';
import { terminateChildProcessTree } from '../core/process-tree.js';

export interface ProcessSession {
  sessionId: string;
  pid: number | undefined;
  command: string;
  cwd: string;
  status: 'running' | 'exited' | 'killed';
  exitCode: number | null;
  startedAt: number;
}

interface InternalSession extends ProcessSession {
  child: ChildProcessWithoutNullStreams;
  output: string;
  cursor: number;
  /** Resolvers waiting for new output or exit (long-poll / streaming tail). */
  waiters: Array<() => void>;
}

function wakeWaiters(session: InternalSession): void {
  const waiters = session.waiters;
  session.waiters = [];
  for (const wake of waiters) wake();
}

function hasExited(session: InternalSession): boolean {
  return session.child.exitCode !== null || session.child.signalCode !== null;
}

/**
 * Manages long-running child processes (dev servers, watchers, compose).
 *
 * POSIX sessions are spawned detached, making each child its own process-group
 * leader: termination signals the whole group, so a shell-wrapped command that
 * forked grandchildren (e.g. `npm run dev` spawning node) no longer leaves
 * orphans holding ports after a stop or a control-plane shutdown.
 */
export class ProcessManager {
  private sessions = new Map<string, InternalSession>();
  private maxBuffer = 1_000_000;
  private exitListeners = new Map<string, Set<() => void>>();

  start(command: string, cwd: string, shell: string, env?: Record<string, string>): ProcessSession {
    const sessionId = `proc_${randomUUID().slice(0, 8)}`;
    const child = spawn(shell, shellCommandArgs(shell, command), {
      cwd,
      // Optional per-session env overlay (e.g. a pasted OpenAI tunnel key):
      // merged over the process env, never placed in the command string.
      env: env ? { ...process.env, ...env } : process.env,
      // POSIX: one process group per session so tree-kill can target -pid.
      // Windows keeps its own console semantics; taskkill /T covers the tree.
      detached: process.platform !== 'win32',
      ...shellSpawnOptions(shell),
    }) as ChildProcessWithoutNullStreams;

    const session: InternalSession = {
      sessionId,
      pid: child.pid,
      command,
      cwd,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      child,
      output: '',
      cursor: 0,
      waiters: [],
    };

    const append = (chunk: Buffer) => {
      session.output += chunk.toString('utf8');
      if (session.output.length > this.maxBuffer) {
        session.output = session.output.slice(-this.maxBuffer);
      }
      wakeWaiters(session);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => {
      // A missing shell/binary (ENOENT) or permission error (EACCES) must never
      // crash the host process: surface it on the session instead of throwing
      // an unhandled 'error' event.
      const detail = error instanceof Error ? error.message : String(error);
      session.output += `[folderforge] failed to start: ${detail}\n`;
      session.status = session.status === 'killed' ? 'killed' : 'exited';
      session.exitCode = null;
      wakeWaiters(session);
      const listeners = this.exitListeners.get(sessionId);
      if (listeners) {
        this.exitListeners.delete(sessionId);
        for (const listener of listeners) listener();
      }
    });
    child.on('exit', (code) => {
      session.status = session.status === 'killed' ? 'killed' : 'exited';
      session.exitCode = code;
      wakeWaiters(session);
      const listeners = this.exitListeners.get(sessionId);
      if (listeners) {
        this.exitListeners.delete(sessionId);
        for (const listener of listeners) listener();
      }
    });

    this.sessions.set(sessionId, session);
    return this.publicView(session);
  }

  /**
   * Register a one-shot listener fired when the session's process exits.
   * Listeners are removed after firing. Returns an unsubscribe function; a
   * session that is unknown or already exited yields a no-op unsubscribe.
   */
  onExit(sessionId: string, listener: () => void): () => void {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'running') return () => {};
    let set = this.exitListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.exitListeners.set(sessionId, set);
    }
    const active = set;
    active.add(listener);
    return () => {
      active.delete(listener);
    };
  }

  read(sessionId: string): { output: string; status: string; cursor: number } {
    const s = this.require(sessionId);
    const out = s.output.slice(s.cursor);
    s.cursor = s.output.length;
    return { output: out, status: s.status, cursor: s.cursor };
  }

  /** Read buffered output WITHOUT advancing the read cursor (for UI viewers). */
  peek(sessionId: string, maxBytes = 16_000): { output: string; status: string } {
    const s = this.require(sessionId);
    return { output: s.output.slice(-maxBytes), status: s.status };
  }

  /**
   * Long-poll read: resolve as soon as new output is available or the process
   * exits, or after `timeoutMs` with whatever (possibly empty) output arrived.
   * This backs streaming tails without busy-waiting. `done` is true once the
   * process has exited and all buffered output has been drained.
   */
  readUntil(
    sessionId: string,
    timeoutMs = 2000,
    signal?: AbortSignal
  ): Promise<{ output: string; status: string; cursor: number; done: boolean }> {
    const s = this.require(sessionId);
    const drain = () => {
      const output = s.output.slice(s.cursor);
      s.cursor = s.output.length;
      const done = s.status !== 'running' && s.cursor >= s.output.length;
      return { output, status: s.status, cursor: s.cursor, done };
    };

    // Immediate return if there is already new output, the process is finished,
    // or the caller has already cancelled (the request).
    if (s.output.length > s.cursor || s.status !== 'running' || signal?.aborted) {
      return Promise.resolve(drain());
    }

    return new Promise((resolveOut) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', finish);
        resolveOut(drain());
      };
      const timer = setTimeout(finish, timeoutMs);
      // Wake immediately on cancellation so a long tail does not block the
      // client after it has cancelled the request.
      if (signal) signal.addEventListener('abort', finish, { once: true });
      s.waiters.push(finish);
    });
  }

  write(sessionId: string, input: string): void {
    const s = this.require(sessionId);
    if (s.status !== 'running') throw new Error('Process is not running');
    s.child.stdin.write(input.endsWith('\n') ? input : input + '\n');
  }

  stop(sessionId: string): ProcessSession {
    const s = this.require(sessionId);
    if (s.status === 'running') {
      s.status = 'killed';
      terminateChildProcessTree(s.child);
      wakeWaiters(s);
    }
    return this.publicView(s);
  }

  kill(sessionId: string): ProcessSession {
    const s = this.require(sessionId);
    if (s.status === 'running') {
      s.status = 'killed';
      terminateChildProcessTree(s.child, true);
      wakeWaiters(s);
    }
    return this.publicView(s);
  }

  /**
   * Stop EVERY running session (control-plane shutdown path): SIGTERM all
   * process trees, wait up to graceMs for exits, then escalate the survivors
   * to SIGKILL. Resolves once every session exited or escalation was sent.
   */
  async stopAllAndWait(graceMs = 1_500): Promise<void> {
    const running = [...this.sessions.values()].filter((s) => s.status === 'running');
    if (running.length === 0) return;
    for (const session of running) {
      session.status = 'killed';
      terminateChildProcessTree(session.child);
      wakeWaiters(session);
    }
    const deadline = Date.now() + Math.max(0, graceMs);
    while (running.some((s) => !hasExited(s))) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await Promise.race([
        Promise.allSettled(
          running.filter((s) => !hasExited(s)).map((s) => once(s.child, 'exit')),
        ),
        new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining))),
      ]);
    }
    const stubborn = running.filter((s) => !hasExited(s));
    for (const session of stubborn) {
      terminateChildProcessTree(session.child, true);
    }
    if (stubborn.length > 0) {
      // Give the OS a short, bounded beat to reap SIGKILLed processes before
      // the caller proceeds with shutdown.
      await Promise.race([
        Promise.allSettled(stubborn.map((s) => once(s.child, 'exit'))),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    }
  }

  list(): ProcessSession[] {
    return [...this.sessions.values()].map((s) => this.publicView(s));
  }

  isManaged(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  private require(sessionId: string): InternalSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown process session: ${sessionId}`);
    return s;
  }

  private publicView(s: InternalSession): ProcessSession {
    return {
      sessionId: s.sessionId,
      pid: s.pid,
      command: s.command,
      cwd: s.cwd,
      status: s.status,
      exitCode: s.exitCode,
      startedAt: s.startedAt,
    };
  }
}
