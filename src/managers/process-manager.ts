import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

/**
 * Manages long-running child processes (dev servers, watchers, compose).
 */
export class ProcessManager {
  private sessions = new Map<string, InternalSession>();
  private maxBuffer = 1_000_000;

  start(command: string, cwd: string, shell: string): ProcessSession {
    const sessionId = `proc_${randomUUID().slice(0, 8)}`;
    const child = spawn(shell, shellCommandArgs(shell, command), {
      cwd,
      env: process.env,
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
    child.on('exit', (code) => {
      session.status = session.status === 'killed' ? 'killed' : 'exited';
      session.exitCode = code;
      wakeWaiters(session);
    });

    this.sessions.set(sessionId, session);
    return this.publicView(session);
  }

  read(sessionId: string): { output: string; status: string; cursor: number } {
    const s = this.require(sessionId);
    const out = s.output.slice(s.cursor);
    s.cursor = s.output.length;
    return { output: out, status: s.status, cursor: s.cursor };
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
    // or the caller has already cancelled (P6).
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
