/**
 * Minimal Language Server Protocol (LSP) transport primitives.
 *
 * LSP runs JSON-RPC 2.0 over a stream framed with HTTP-style headers:
 *
 *   Content-Length: <bytes>\r\n
 *   \r\n
 *   <utf8 json body>
 *
 * This module is intentionally transport-pure: it knows how to *encode* an
 * outgoing message and how to *incrementally decode* a byte stream into
 * complete messages. It spawns nothing and touches no filesystem, which keeps
 * the framing logic unit-testable without a real language server (the spawn /
 * lifecycle layer lives in `managers/lsp-manager.ts`).
 */

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Encode a JSON-RPC message into a framed LSP buffer (headers + body). */
export function encodeMessage(message: JsonRpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = `Content-Length: ${body.length}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}

/**
 * Incremental decoder for the LSP framing. Feed it raw chunks as they arrive on
 * the language server's stdout; it buffers partial frames and emits each
 * complete JSON-RPC message via the `onMessage` callback. A single chunk may
 * contain zero, one, or many messages, and a message may be split across
 * chunks; both cases are handled.
 */
export class MessageBuffer {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly onMessage: (msg: JsonRpcMessage) => void) {}

  append(chunk: Buffer): void {
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : Buffer.from(chunk);
    this.drain();
  }

  private drain(): void {
    // Loop because one append may complete several queued frames.
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return; // headers not fully received yet

      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const length = parseContentLength(header);
      if (length === null) {
        // Malformed header block: drop it and resync past the separator so a
        // single bad frame can't wedge the stream forever.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return; // body not fully received yet

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString('utf8');
      this.buffer = this.buffer.subarray(bodyEnd);

      let parsed: JsonRpcMessage | null = null;
      try {
        parsed = JSON.parse(body) as JsonRpcMessage;
      } catch {
        parsed = null; // skip a non-JSON body but keep draining
      }
      if (parsed) this.onMessage(parsed);
    }
  }
}

/** Parse the `Content-Length` value out of an LSP header block. */
export function parseContentLength(header: string): number | null {
  for (const line of header.split(/\r\n/)) {
    const m = /^Content-Length:\s*(\d+)\s*$/i.exec(line);
    if (m) {
      const n = Number(m[1]);
      return Number.isFinite(n) && n >= 0 ? n : null;
    }
  }
  return null;
}

/** Type guard: a message is a response when it carries an `id` and no `method`. */
export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && !('method' in msg);
}

/**
 * LSP SymbolKind enum (subset we surface). Maps numeric kinds returned by
 * documentSymbol / workspaceSymbol to human-readable names.
 */
export const SYMBOL_KIND: Record<number, string> = {
  1: 'file',
  2: 'module',
  3: 'namespace',
  4: 'package',
  5: 'class',
  6: 'method',
  7: 'property',
  8: 'field',
  9: 'constructor',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'constant',
  23: 'struct',
};

/** LSP DiagnosticSeverity -> our severity vocabulary. */
export function lspSeverity(n: number | undefined): 'error' | 'warning' | 'info' {
  if (n === 1) return 'error';
  if (n === 2) return 'warning';
  return 'info';
}
