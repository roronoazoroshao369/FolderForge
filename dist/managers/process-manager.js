import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
/**
 * Manages long-running child processes (dev servers, watchers, compose).
 */
export class ProcessManager {
    sessions = new Map();
    maxBuffer = 1_000_000;
    start(command, cwd, shell) {
        const sessionId = `proc_${randomUUID().slice(0, 8)}`;
        const child = spawn(shell, ['-lc', command], {
            cwd,
            env: process.env,
        });
        const session = {
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
        const append = (chunk) => {
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
    read(sessionId) {
        const s = this.require(sessionId);
        const out = s.output.slice(s.cursor);
        s.cursor = s.output.length;
        return { output: out, status: s.status, cursor: s.cursor };
    }
    write(sessionId, input) {
        const s = this.require(sessionId);
        if (s.status !== 'running')
            throw new Error('Process is not running');
        s.child.stdin.write(input.endsWith('\n') ? input : input + '\n');
    }
    stop(sessionId) {
        const s = this.require(sessionId);
        if (s.status === 'running') {
            s.child.kill('SIGTERM');
            s.status = 'killed';
        }
        return this.publicView(s);
    }
    kill(sessionId) {
        const s = this.require(sessionId);
        if (s.status === 'running') {
            s.child.kill('SIGKILL');
            s.status = 'killed';
        }
        return this.publicView(s);
    }
    list() {
        return [...this.sessions.values()].map((s) => this.publicView(s));
    }
    isManaged(sessionId) {
        return this.sessions.has(sessionId);
    }
    require(sessionId) {
        const s = this.sessions.get(sessionId);
        if (!s)
            throw new Error(`Unknown process session: ${sessionId}`);
        return s;
    }
    publicView(s) {
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
