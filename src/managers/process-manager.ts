import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

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
}

/**
 * Manages long-running child processes (dev servers, watchers, compose).
 */
export class ProcessManager {
  private sessions = new Map<string, InternalSession>();
  private maxBuffer = 1_000_000;

  start(command: string, cwd: string, shell: string): ProcessSession {
    const sessionId = `proc_${randomUUID().slice(0, 8)}`;
    const child = spawn(shell, ['-lc', command], {
      cwd,
      env: process.env,
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
    };

    const append = (chunk: Buffer) => {
      session.output += chunk.toString('utf8');
      if (session.output.length > this.maxBuffer) {
        session.output = session.output.slice(-this.maxBuffer);
      }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('exit', (code) => {
      session.status = session.status === 'killed' ? 'killed' : 'exited';
      session.exitCode = code;
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

  write(sessionId: string, input: string): void {
    const s = this.require(sessionId);
    if (s.status !== 'running') throw new Error('Process is not running');
    s.child.stdin.write(input.endsWith('\n') ? input : input + '\n');
  }

  stop(sessionId: string): ProcessSession {
    const s = this.require(sessionId);
    if (s.status === 'running') {
      s.child.kill('SIGTERM');
      s.status = 'killed';
    }
    return this.publicView(s);
  }

  kill(sessionId: string): ProcessSession {
    const s = this.require(sessionId);
    if (s.status === 'running') {
      s.child.kill('SIGKILL');
      s.status = 'killed';
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
