import { spawn } from 'node:child_process';
import { logger } from '../../core/logger.js';
import { terminateChildProcessTree } from '../../core/process-tree.js';
/**
 * Minimal JSON-RPC client over a child MCP server's stdio.
 * Implements just enough of the MCP wire protocol to initialize,
 * list tools, and call tools.
 */
export class StdioChildClient {
    command;
    args;
    env;
    cwd;
    inheritEnv;
    child = null;
    pending = new Map();
    nextId = 1;
    buffer = '';
    initialized = false;
    constructor(command, args, env = {}, cwd, inheritEnv = true) {
        this.command = command;
        this.args = args;
        this.env = env;
        this.cwd = cwd;
        this.inheritEnv = inheritEnv;
    }
    async start() {
        if (this.child)
            return;
        this.child = spawn(this.command, this.args, {
            cwd: this.cwd,
            env: this.inheritEnv ? { ...process.env, ...this.env } : { ...this.env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.child.stdout.on('data', (chunk) => this.onData(chunk));
        this.child.stderr.on('data', (chunk) => logger.debug({ child: this.command, msg: chunk.toString() }, 'child stderr'));
        this.child.on('exit', (code) => {
            logger.warn({ child: this.command, code }, 'child MCP exited');
            this.child = null;
            this.initialized = false;
            for (const p of this.pending.values())
                p.reject(new Error('child process exited'));
            this.pending.clear();
        });
        await this.request('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'folderforge', version: '0.1.0' },
        });
        this.notify('notifications/initialized', {});
        this.initialized = true;
    }
    onData(chunk) {
        this.buffer += chunk.toString('utf8');
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (!line)
                continue;
            try {
                const msg = JSON.parse(line);
                if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
                    const p = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    if (msg.error)
                        p.reject(new Error(msg.error.message));
                    else
                        p.resolve(msg.result);
                }
            }
            catch {
                // ignore non-JSON lines
            }
        }
    }
    notify(method, params) {
        if (!this.child)
            return;
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    }
    request(method, params, timeoutMs = 30000) {
        if (!this.child)
            return Promise.reject(new Error('child not started'));
        const id = this.nextId++;
        const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`child request timed out: ${method}`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (v) => {
                    clearTimeout(timer);
                    resolve(v);
                },
                reject: (e) => {
                    clearTimeout(timer);
                    reject(e);
                },
            });
            this.child.stdin.write(payload);
        });
    }
    async listTools() {
        const res = (await this.request('tools/list', {}));
        return res.tools ?? [];
    }
    async callTool(name, args) {
        return this.request('tools/call', { name, arguments: args });
    }
    isReady() {
        return this.initialized && this.child !== null;
    }
    stop() {
        const child = this.child;
        this.child = null;
        this.initialized = false;
        if (child)
            terminateChildProcessTree(child);
    }
}
