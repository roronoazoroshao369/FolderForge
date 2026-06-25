import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import {
  MessageBuffer,
  encodeMessage,
  isResponse,
  SYMBOL_KIND,
  lspSeverity,
  type JsonRpcId,
  type JsonRpcMessage,
} from '../lsp/protocol.js';
import type { LanguageServerDef, LspConfig } from '../core/types.js';

export type { LanguageServerDef, LspConfig };

/** Built-in language server definitions. Overridable via config. */
export const DEFAULT_LANGUAGE_SERVERS: LanguageServerDef[] = [
  {
    id: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],
    languageId: 'typescript',
  },
  {
    id: 'python',
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensions: ['py', 'pyi'],
    languageId: 'python',
  },
];

export interface LspManagerOptions {
  enabled: boolean;
  requestTimeoutMs: number;
  servers?: LanguageServerDef[];
}

export const DEFAULT_LSP_CONFIG: LspConfig = {
  enabled: true,
  requestTimeoutMs: 15_000,
};

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** A live, initialized language-server connection. */
class LspConnection {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  private buffer: MessageBuffer;
  private opened = new Set<string>();
  /** Latest published diagnostics per file URI. */
  readonly diagnostics = new Map<string, unknown[]>();
  private exited = false;

  constructor(
    private def: LanguageServerDef,
    private root: string,
    private requestTimeoutMs: number
  ) {
    this.child = spawn(def.command, def.args, { cwd: root }) as ChildProcessWithoutNullStreams;
    this.buffer = new MessageBuffer((msg) => this.onMessage(msg));
    this.child.stdout.on('data', (c: Buffer) => this.buffer.append(c));
    this.child.stderr.on('data', () => {}); // language servers log noisily; ignore
    this.child.on('exit', () => {
      this.exited = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`${this.def.id} language server exited`));
      }
      this.pending.clear();
    });
    this.child.on('error', () => {
      this.exited = true;
    });
  }

  private onMessage(msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    // Notification from the server.
    if ('method' in msg && msg.method === 'textDocument/publishDiagnostics') {
      const params = msg.params as { uri?: string; diagnostics?: unknown[] } | undefined;
      if (params?.uri) this.diagnostics.set(params.uri, params.diagnostics ?? []);
    }
    // Server->client requests (e.g. workspace/configuration) are answered with
    // a null result so the server doesn't stall waiting on us.
    if ('method' in msg && 'id' in msg) {
      this.send({ jsonrpc: '2.0', id: (msg as { id: JsonRpcId }).id, result: null });
    }
  }

  private send(msg: JsonRpcMessage): void {
    if (this.exited) return;
    this.child.stdin.write(encodeMessage(msg));
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error(`${this.def.id} server not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request ${method} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(this.root).href,
      capabilities: {
        textDocument: {
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          definition: {},
          references: {},
          rename: {},
          publishDiagnostics: {},
        },
        workspace: { symbol: {}, workspaceFolders: true },
      },
      workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: 'root' }],
    });
    this.notify('initialized', {});
  }

  /** Ensure a file is open on the server (didOpen once per URI). */
  ensureOpen(relativePath: string): string {
    const abs = isAbsolute(relativePath) ? relativePath : join(this.root, relativePath);
    const uri = pathToFileURL(abs).href;
    if (this.opened.has(uri)) return uri;
    let text = '';
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      text = '';
    }
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: this.def.languageId, version: 1, text },
    });
    this.opened.add(uri);
    return uri;
  }

  dispose(): void {
    try {
      this.send({ jsonrpc: '2.0', id: this.nextId++, method: 'shutdown', params: null });
      this.notify('exit', null);
    } catch {
      /* ignore */
    }
    try {
      this.child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    this.exited = true;
  }
}

/**
 * Manages native LSP connections, one per (language, projectRoot). Lazily
 * spawns and initializes a server on first use, reusing it afterwards. When the
 * configured binary is not installed, callers get a clear "unavailable" signal
 * and degrade gracefully (Serena adapter / regex search).
 */
export class LspManager {
  private connections = new Map<string, LspConnection>();
  private servers: LanguageServerDef[];

  constructor(private config: LspConfig = DEFAULT_LSP_CONFIG) {
    this.config = config ?? DEFAULT_LSP_CONFIG;
    this.servers = this.config.servers ?? DEFAULT_LANGUAGE_SERVERS;
  }

  /** Pick the server definition that handles a given file path, if any. */
  serverForPath(relativePath: string): LanguageServerDef | undefined {
    const ext = relativePath.split('.').pop()?.toLowerCase() ?? '';
    return this.servers.find((s) => s.extensions.includes(ext));
  }

  serverById(id: string): LanguageServerDef | undefined {
    return this.servers.find((s) => s.id === id);
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get (or lazily create + initialize) a connection for a language at a root.
   * Returns null if LSP is disabled or the binary cannot be spawned.
   */
  async ensure(def: LanguageServerDef, root: string): Promise<LspConnection | null> {
    if (!this.config.enabled) return null;
    const key = `${def.id}::${root}`;
    const existing = this.connections.get(key);
    if (existing) return existing;
    try {
      const conn = new LspConnection(def, root, this.config.requestTimeoutMs);
      await conn.initialize();
      this.connections.set(key, conn);
      return conn;
    } catch {
      return null; // binary missing or init failed -> caller falls back
    }
  }

  disposeAll(): void {
    for (const [, c] of this.connections) c.dispose();
    this.connections.clear();
  }
}

/** Normalize an LSP Location into a {file, line, column} record (1-based line). */
export function normalizeLocation(loc: unknown): { file: string; line: number; column: number } | null {
  const l = loc as { uri?: string; range?: { start?: { line?: number; character?: number } } };
  if (!l?.uri || !l.range?.start) return null;
  let file = l.uri;
  try {
    file = fileURLToPath(l.uri);
  } catch {
    /* keep raw uri */
  }
  return {
    file,
    line: (l.range.start.line ?? 0) + 1,
    column: (l.range.start.character ?? 0) + 1,
  };
}

/** Flatten a documentSymbol tree (hierarchical or flat) into named entries. */
export function flattenSymbols(symbols: unknown): Array<{ name: string; kind: string; line: number }> {
  const out: Array<{ name: string; kind: string; line: number }> = [];
  const visit = (nodes: unknown[]): void => {
    for (const n of nodes) {
      const s = n as {
        name?: string;
        kind?: number;
        range?: { start?: { line?: number } };
        location?: { range?: { start?: { line?: number } } };
        children?: unknown[];
      };
      if (s?.name) {
        const line =
          (s.range?.start?.line ?? s.location?.range?.start?.line ?? 0) + 1;
        out.push({ name: s.name, kind: SYMBOL_KIND[s.kind ?? 0] ?? 'symbol', line });
      }
      if (Array.isArray(s?.children)) visit(s.children);
    }
  };
  if (Array.isArray(symbols)) visit(symbols);
  return out;
}

/** Convert LSP diagnostics for a file into the shared error-item shape. */
export function normalizeDiagnostics(
  uri: string,
  diags: unknown[]
): Array<{ file: string; line: number; column: number; severity: string; message: string; code?: string }> {
  let file = uri;
  try {
    file = fileURLToPath(uri);
  } catch {
    /* keep raw uri */
  }
  return diags.map((d) => {
    const x = d as {
      severity?: number;
      message?: string;
      code?: string | number;
      range?: { start?: { line?: number; character?: number } };
    };
    return {
      file,
      line: (x.range?.start?.line ?? 0) + 1,
      column: (x.range?.start?.character ?? 0) + 1,
      severity: lspSeverity(x.severity),
      message: x.message ?? '',
      ...(x.code !== undefined ? { code: String(x.code) } : {}),
    };
  });
}

export type { LspConnection };
