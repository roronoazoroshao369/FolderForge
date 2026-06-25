import { describe, it, expect } from 'vitest';
import {
  encodeMessage,
  MessageBuffer,
  parseContentLength,
  isResponse,
  SYMBOL_KIND,
  lspSeverity,
  type JsonRpcMessage,
} from '../../src/lsp/protocol.js';
import {
  flattenSymbols,
  normalizeLocation,
  normalizeDiagnostics,
  LspManager,
  DEFAULT_LANGUAGE_SERVERS,
} from '../../src/managers/lsp-manager.js';
import { pathToFileURL } from 'node:url';

/**
 * LSP transport + normalization tests (Gap 1). These exercise the framing and
 * payload-mapping logic without spawning a real language server, which keeps
 * them deterministic and offline.
 */

describe('LSP protocol framing', () => {
  it('encodes a message with a correct Content-Length header', () => {
    const buf = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const text = buf.toString('utf8');
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(text).toContain(`Content-Length: ${Buffer.byteLength(body)}`);
    expect(text).toContain('\r\n\r\n');
    expect(text.endsWith(body)).toBe(true);
  });

  it('parses Content-Length case-insensitively', () => {
    expect(parseContentLength('Content-Length: 42')).toBe(42);
    expect(parseContentLength('content-length:  7 ')).toBe(7);
    expect(parseContentLength('X-Other: 1')).toBe(null);
  });

  it('decodes a single complete frame', () => {
    const got: JsonRpcMessage[] = [];
    const mb = new MessageBuffer((m) => got.push(m));
    mb.append(encodeMessage({ jsonrpc: '2.0', id: 5, result: { ok: true } }));
    expect(got).toHaveLength(1);
    expect((got[0] as { id?: number }).id).toBe(5);
  });

  it('reassembles a frame split across chunks', () => {
    const got: JsonRpcMessage[] = [];
    const mb = new MessageBuffer((m) => got.push(m));
    const full = encodeMessage({ jsonrpc: '2.0', id: 9, result: 'hi' });
    mb.append(full.subarray(0, 10));
    expect(got).toHaveLength(0); // not complete yet
    mb.append(full.subarray(10));
    expect(got).toHaveLength(1);
    expect((got[0] as { result?: string }).result).toBe('hi');
  });

  it('splits multiple frames in one chunk', () => {
    const got: JsonRpcMessage[] = [];
    const mb = new MessageBuffer((m) => got.push(m));
    const a = encodeMessage({ jsonrpc: '2.0', id: 1, result: 'a' });
    const b = encodeMessage({ jsonrpc: '2.0', id: 2, result: 'b' });
    mb.append(Buffer.concat([a, b]));
    expect(got.map((m) => (m as { id?: number }).id)).toEqual([1, 2]);
  });

  it('recovers from a malformed header block without wedging', () => {
    const got: JsonRpcMessage[] = [];
    const mb = new MessageBuffer((m) => got.push(m));
    mb.append(Buffer.from('Bad-Header: x\r\n\r\n', 'ascii'));
    mb.append(encodeMessage({ jsonrpc: '2.0', id: 7, result: 'ok' }));
    expect(got).toHaveLength(1);
    expect((got[0] as { id?: number }).id).toBe(7);
  });

  it('classifies responses vs notifications', () => {
    expect(isResponse({ jsonrpc: '2.0', id: 1, result: 1 })).toBe(true);
    expect(isResponse({ jsonrpc: '2.0', method: 'foo' })).toBe(false);
  });
});

describe('LSP payload normalization', () => {
  it('maps symbol kinds and flattens hierarchical document symbols', () => {
    const symbols = [
      {
        name: 'Calculator',
        kind: 5,
        range: { start: { line: 0 } },
        children: [{ name: 'add', kind: 6, range: { start: { line: 3 } } }],
      },
    ];
    const flat = flattenSymbols(symbols);
    expect(flat).toEqual([
      { name: 'Calculator', kind: 'class', line: 1 },
      { name: 'add', kind: 'method', line: 4 },
    ]);
    expect(SYMBOL_KIND[12]).toBe('function');
  });

  it('normalizes a location to a 1-based file/line/column', () => {
    const loc = {
      uri: pathToFileURL('/tmp/x.ts').href,
      range: { start: { line: 9, character: 4 } },
    };
    const n = normalizeLocation(loc);
    expect(n).toEqual({ file: '/tmp/x.ts', line: 10, column: 5 });
  });

  it('maps diagnostic severities', () => {
    expect(lspSeverity(1)).toBe('error');
    expect(lspSeverity(2)).toBe('warning');
    expect(lspSeverity(3)).toBe('info');
    expect(lspSeverity(undefined)).toBe('info');
  });

  it('normalizes diagnostics into the shared error-item shape', () => {
    const uri = pathToFileURL('/tmp/y.ts').href;
    const out = normalizeDiagnostics(uri, [
      { severity: 1, message: 'boom', code: 'TS1', range: { start: { line: 0, character: 0 } } },
    ]);
    expect(out[0]).toMatchObject({ file: '/tmp/y.ts', line: 1, column: 1, severity: 'error', message: 'boom', code: 'TS1' });
  });
});

describe('LspManager routing', () => {
  it('selects a server by file extension', () => {
    const mgr = new LspManager({ enabled: true, requestTimeoutMs: 1000 });
    expect(mgr.serverForPath('src/a.ts')?.id).toBe('typescript');
    expect(mgr.serverForPath('app/main.py')?.id).toBe('python');
    expect(mgr.serverForPath('notes.txt')).toBeUndefined();
  });

  it('reports disabled when config.enabled is false', async () => {
    const mgr = new LspManager({ enabled: false, requestTimeoutMs: 1000 });
    expect(mgr.isEnabled()).toBe(false);
    const def = DEFAULT_LANGUAGE_SERVERS[0]!;
    expect(await mgr.ensure(def, '/tmp')).toBeNull();
  });

  it('returns null (graceful fallback) when the binary is missing', async () => {
    const mgr = new LspManager({
      enabled: true,
      requestTimeoutMs: 500,
      servers: [
        { id: 'fake', command: 'definitely-not-a-real-lsp-binary-xyz', args: [], extensions: ['zz'], languageId: 'zz' },
      ],
    });
    const def = mgr.serverForPath('a.zz')!;
    expect(await mgr.ensure(def, '/tmp')).toBeNull();
  });
});
