import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from '../../core/logger.js';

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/**
 * Minimal JSON-RPC client over a child MCP server's stdio.
 * Implements just enough of the MCP wire protocol to initialize,
 * list tools, and call tools.
 */
export class StdioChildClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = '';
  private initialized = false;

  constructor(
    private command: string,
    private args: string[],
    private env: Record<string, string> = {}
  ) {}

  async start(): Promise<void> {
    if (this.child) return;
    this.child = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.stderr.on('data', (chunk: Buffer) =>
      logger.debug({ child: this.command, msg: chunk.toString() }, 'child stderr')
    );
    this.child.on('exit', (code) => {
      logger.warn({ child: this.command, code }, 'child MCP exited');
      this.child = null;
      this.initialized = false;
      for (const p of this.pending.values()) p.reject(new Error('child process exited'));
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

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
        if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      } catch {
        // ignore non-JSON lines
      }
    }
  }

  private notify(method: string, params: unknown): void {
    if (!this.child) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  request(method: string, params: unknown, timeoutMs = 30000): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error('child not started'));
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
      this.child!.stdin.write(payload);
    });
  }

  async listTools(): Promise<
    Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
  > {
    const res = (await this.request('tools/list', {})) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    };
    return res.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args });
  }

  isReady(): boolean {
    return this.initialized && this.child !== null;
  }

  stop(): void {
    this.child?.kill('SIGTERM');
    this.child = null;
    this.initialized = false;
  }
}
