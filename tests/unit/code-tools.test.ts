import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { codeTools } from '../../src/tools/code-tools.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../../src/core/types.js';

/**
 * `code-tools` is the hybrid resolution layer (native LSP -> Serena child-MCP
 * -> regex fallback). Every branch is exercised here with injected fakes so no
 * language server or child MCP process is required.
 */

type Args = Record<string, unknown>;
type SerenaCall = { tool: string; args: Args };
type Responder = (method: string, params: Args) => unknown;

class FakeConnection {
  readonly requests: Array<{ method: string; params: Args }> = [];
  readonly diagnostics = new Map<string, unknown[]>();

  constructor(
    private readonly root: string,
    private readonly responder: Responder
  ) {}

  ensureOpen(relativePath: string): string {
    return pathToFileURL(join(this.root, relativePath)).href;
  }

  request(method: string, params: Args): Promise<unknown> {
    this.requests.push({ method, params });
    return Promise.resolve(this.responder(method, params));
  }
}

interface FakeOptions {
  projectRoot?: string;
  lsp?: {
    enabled?: boolean;
    connection?: FakeConnection | null;
    serverForPath?: unknown;
    serverById?: unknown;
  };
  serena?: { enabled?: boolean; result?: unknown; throws?: boolean };
}

function makeCtx(opts: FakeOptions = {}): { ctx: ToolContext; serenaCalls: SerenaCall[] } {
  const projectRoot = opts.projectRoot ?? tmpdir();
  const serenaCalls: SerenaCall[] = [];
  const lspOpts = opts.lsp;

  const callTool = (tool: string, args: Args): Promise<unknown> => {
    serenaCalls.push({ tool, args });
    if (opts.serena?.throws === true) return Promise.reject(new Error('serena exploded'));
    return Promise.resolve(opts.serena?.result ?? { echoed: tool });
  };

  const container = {
    adapters: {
      isEnabled: (name: string): boolean => name === 'serena' && opts.serena?.enabled === true,
      ensure: (): Promise<{ callTool: typeof callTool }> => Promise.resolve({ callTool }),
    },
    lsp: lspOpts
      ? {
          isEnabled: (): boolean => lspOpts.enabled !== false,
          serverForPath: (): unknown =>
            lspOpts.serverForPath === undefined ? { id: 'typescript' } : lspOpts.serverForPath,
          serverById: (): unknown =>
            lspOpts.serverById === undefined ? { id: 'typescript' } : lspOpts.serverById,
          ensure: (): Promise<FakeConnection | null> => Promise.resolve(lspOpts.connection ?? null),
        }
      : undefined,
  };

  return {
    ctx: { config: {} as ToolContext['config'], projectRoot, container },
    serenaCalls,
  };
}

const TOOLS = new Map<string, ToolDefinition>(codeTools().map((t) => [t.name, t]));

function call(name: string, args: Args, ctx: ToolContext): Promise<ToolResult> {
  const tool = TOOLS.get(name);
  if (!tool) throw new Error(`unregistered tool: ${name}`);
  return Promise.resolve(tool.handler(args, ctx));
}

const SAMPLE = [
  'export function alpha() {}',
  'export class Beta {}',
  'export const gamma = 1;',
  'export interface Delta {}',
  'export type Epsilon = string;',
  'export enum Zeta { A }',
  'def eta():',
  'class Theta:',
].join('\n');

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'folderforge-code-tools-'));
  writeFileSync(join(root, 'sample.ts'), SAMPLE, 'utf8');
});

describe('code tool registration', () => {
  it('registers the full semantic tool surface in the code group', () => {
    expect([...TOOLS.keys()]).toEqual([
      'code_symbols_overview',
      'code_find_symbol',
      'code_find_references',
      'code_find_definition',
      'code_find_implementations',
      'code_diagnostics',
      'code_replace_symbol_body',
      'code_insert_before_symbol',
      'code_insert_after_symbol',
      'code_rename_symbol',
    ]);
    for (const tool of TOOLS.values()) expect(tool.group).toBe('code');
  });

  it('marks only symbol-editing tools as mutating', () => {
    const mutating = [...TOOLS.values()].filter((t) => t.mutates).map((t) => t.name);
    expect(mutating).toEqual([
      'code_replace_symbol_body',
      'code_insert_before_symbol',
      'code_insert_after_symbol',
      'code_rename_symbol',
    ]);
  });

  it('publishes an output schema for diagnostics only', () => {
    expect(TOOLS.get('code_diagnostics')?.outputSchema).toBeDefined();
    expect(TOOLS.get('code_find_symbol')?.outputSchema).toBeUndefined();
  });
});

describe('code_symbols_overview', () => {
  it('rejects a call without relativePath', async () => {
    const { ctx } = makeCtx();
    const res = await call('code_symbols_overview', {}, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('relativePath is required');
  });

  it('falls back to regex extraction when no backend is available', async () => {
    const { ctx } = makeCtx({ projectRoot: root });
    const res = await call('code_symbols_overview', { relativePath: 'sample.ts' }, ctx);
    expect(res.ok).toBe(true);
    const data = res.data as { source: string; symbols: Array<{ name: string; kind: string }> };
    expect(data.source).toBe('regex');
    expect(data.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'function:alpha',
      'class:Beta',
      'variable:gamma',
      'interface:Delta',
      'type:Epsilon',
      'enum:Zeta',
      'function:eta',
      'class:Theta',
    ]);
  });

  it('returns an empty regex result for an unreadable file', async () => {
    const { ctx } = makeCtx({ projectRoot: root });
    const res = await call('code_symbols_overview', { relativePath: 'missing.ts' }, ctx);
    expect(res.ok).toBe(true);
    expect((res.data as { symbols: unknown[] }).symbols).toEqual([]);
  });

  it('prefers the native language server and flattens nested symbols', async () => {
    const conn = new FakeConnection(root, () => [
      {
        name: 'Beta',
        kind: 5,
        range: { start: { line: 1 } },
        children: [{ name: 'method', kind: 6, range: { start: { line: 2 } } }],
      },
    ]);
    const { ctx } = makeCtx({ projectRoot: root, lsp: { connection: conn } });
    const res = await call('code_symbols_overview', { relativePath: 'sample.ts' }, ctx);
    expect(res.ok).toBe(true);
    const data = res.data as { source: string; symbols: Array<{ name: string; line: number }> };
    expect(data.source).toBe('lsp');
    expect(data.symbols.map((s) => s.name)).toEqual(['Beta', 'method']);
    expect(data.symbols[1]?.line).toBe(3);
    expect(conn.requests[0]?.method).toBe('textDocument/documentSymbol');
  });

  it('routes to Serena with the mapped tool name when the adapter is enabled', async () => {
    const { ctx, serenaCalls } = makeCtx({ projectRoot: root, serena: { enabled: true } });
    const res = await call('code_symbols_overview', { relativePath: 'sample.ts' }, ctx);
    expect(res.ok).toBe(true);
    expect((res.data as { source: string }).source).toBe('serena');
    expect(serenaCalls[0]?.tool).toBe('get_symbols_overview');
  });

  it('surfaces a Serena failure instead of silently falling through', async () => {
    const { ctx } = makeCtx({ projectRoot: root, serena: { enabled: true, throws: true } });
    const res = await call('code_symbols_overview', { relativePath: 'sample.ts' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Serena call failed');
  });
});

describe('code_find_symbol', () => {
  it('rejects a call without namePath', async () => {
    const { ctx } = makeCtx();
    const res = await call('code_find_symbol', {}, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('namePath is required');
  });

  it('reports an actionable no-backend error', async () => {
    const { ctx } = makeCtx();
    const res = await call('code_find_symbol', { namePath: 'Beta' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('No semantic backend available');
    expect(res.error).toContain('search_ast');
  });

  it('queries the leaf name and drops matches without a location', async () => {
    const conn = new FakeConnection(root, () => [
      { name: 'Beta', location: { uri: pathToFileURL(join(root, 'sample.ts')).href, range: { start: { line: 1, character: 13 } } } },
      { name: 'Orphan' },
      { location: { uri: 'file:///x.ts', range: { start: { line: 0, character: 0 } } } },
    ]);
    const { ctx } = makeCtx({ projectRoot: root, lsp: { connection: conn } });
    const res = await call('code_find_symbol', { namePath: 'src/Beta' }, ctx);
    expect(res.ok).toBe(true);
    const data = res.data as { source: string; matches: Array<{ name: string; line: number; column: number }> };
    expect(data.source).toBe('lsp');
    expect(conn.requests[0]?.params).toMatchObject({ query: 'Beta' });
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0]).toMatchObject({ name: 'Beta', line: 2, column: 14 });
  });

  it('falls back to Serena when the language server cannot start', async () => {
    const { ctx, serenaCalls } = makeCtx({
      projectRoot: root,
      lsp: { connection: null, serverForPath: null, serverById: null },
      serena: { enabled: true },
    });
    const res = await call('code_find_symbol', { namePath: 'Beta' }, ctx);
    expect(res.ok).toBe(true);
    expect(serenaCalls[0]?.tool).toBe('find_symbol');
  });

  it('returns an empty match list when the server answers with a non-array', async () => {
    const conn = new FakeConnection(root, () => null);
    const { ctx } = makeCtx({ projectRoot: root, lsp: { connection: conn } });
    const res = await call('code_find_symbol', { namePath: 'Beta' }, ctx);
    expect((res.data as { matches: unknown[] }).matches).toEqual([]);
  });
});

describe('positional tools (references / definition / implementations)', () => {
  it('converts 1-based request coordinates and asks for the declaration', async () => {
    const conn = new FakeConnection(root, () => [
      { uri: pathToFileURL(join(root, 'sample.ts')).href, range: { start: { line: 4, character: 2 } } },
    ]);
    const { ctx } = makeCtx({ projectRoot: root, lsp: { connection: conn } });
    const res = await call('code_find_references', { relativePath: 'sample.ts', line: 3, column: 7 }, ctx);
    expect(res.ok).toBe(true);
    expect(conn.requests[0]?.method).toBe('textDocument/references');
    expect(conn.requests[0]?.params).toMatchObject({
      position: { line: 2, character: 6 },
      context: { includeDeclaration: true },
    });
    expect((res.data as { locations: Array<{ line: number }> }).locations[0]?.line).toBe(5);
  });

  it('clamps out-of-range coordinates to the start of the document', async () => {
    const conn = new FakeConnection(root, () => []);
    const { ctx } = makeCtx({ projectRoot: root, lsp: { connection: conn } });
    await call('code_find_definition', { relativePath: 'sample.ts', line: 0, column: 0 }, ctx);
    expect(conn.requests[0]?.params).toMatchObject({ position: { line: 0, character: 0 } });
  });

  it('locates the position from namePath when no line is supplied', async () => {
    const conn = new FakeConnection(root, () => []);
    const { ctx } = makeCtx({ projectRoot: root, lsp: { connection: conn } });
    await call('code_find_definition', { relativePath: 'sample.ts', namePath: 'src/Beta' }, ctx);
    expect(conn.requests[0]?.method).toBe('textDocument/definition');
    expect(conn.requests[0]?.params).toMatchObject({ position: { line: 1, character: 13 } });
  });

  it('keeps the default position when the file cannot be read for namePath lookup', async () => {
    const conn = new FakeConnection(root, () => []);
    const { ctx } = makeCtx({ projectRoot: root, lsp: { connection: conn } });
    await call('code_find_definition', { relativePath: 'missing.ts', namePath: 'Beta' }, ctx);
    expect(conn.requests[0]?.params).toMatchObject({ position: { line: 0, character: 0 } });
  });

  it('accepts an absolute path and the file alias', async () => {
    const conn = new FakeConnection(root, () => []);
    const { ctx } = makeCtx({ projectRoot: root, lsp: { connection: conn } });
    await call('code_find_implementations', { file: join(root, 'sample.ts'), namePath: 'Delta' }, ctx);
    expect(conn.requests[0]?.method).toBe('textDocument/implementation');
    expect(conn.requests[0]?.params).toMatchObject({ position: { line: 3, character: 17 } });
  });

  it('wraps a single non-array location result', async () => {
    const conn = new FakeConnection(root, () => ({
      uri: pathToFileURL(join(root, 'sample.ts')).href,
      range: { start: { line: 0, character: 0 } },
    }));
    const { ctx } = makeCtx({ projectRoot: root, lsp: { connection: conn } });
    const res = await call('code_find_definition', { relativePath: 'sample.ts', line: 1 }, ctx);
    expect((res.data as { locations: unknown[] }).locations).toHaveLength(1);
  });

  it('returns no locations when the server answers null', async () => {
    const conn = new FakeConnection(root, () => null);
    const { ctx } = makeCtx({ projectRoot: root, lsp: { connection: conn } });
    const res = await call('code_find_definition', { relativePath: 'sample.ts', line: 1 }, ctx);
    expect((res.data as { locations: unknown[] }).locations).toEqual([]);
  });

  it('routes to the mapped Serena tool when no file is supplied', async () => {
    const { ctx, serenaCalls } = makeCtx({ projectRoot: root, serena: { enabled: true } });
    const res = await call('code_find_references', { namePath: 'Beta' }, ctx);
    expect(res.ok).toBe(true);
    expect(serenaCalls[0]?.tool).toBe('find_referencing_symbols');
  });

  it('explains that a file is required when every backend declines', async () => {
    const { ctx } = makeCtx({ projectRoot: root });
    const res = await call('code_find_references', { namePath: 'Beta' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('needs a file (relativePath) for native LSP');
  });
});

describe('code_diagnostics', () => {
  it('normalizes push-based diagnostics from the language server', async () => {
    const conn = new FakeConnection(root, () => null);
    const uri = pathToFileURL(join(root, 'sample.ts')).href;
    conn.diagnostics.set(uri, [
      { severity: 1, message: 'boom', code: 2345, range: { start: { line: 4, character: 6 } } },
    ]);
    const { ctx } = makeCtx({ projectRoot: root, lsp: { connection: conn } });
    const res = await call('code_diagnostics', { relativePath: 'sample.ts' }, ctx);
    expect(res.ok).toBe(true);
    const data = res.data as { source: string; count: number; diagnostics: Array<{ line: number; column: number; code?: string }> };
    expect(data.source).toBe('lsp');
    expect(data.count).toBe(1);
    expect(data.diagnostics[0]).toMatchObject({ line: 5, column: 7, code: '2345' });
  });

  it('reports an empty set when the server published nothing', async () => {
    const conn = new FakeConnection(root, () => null);
    const { ctx } = makeCtx({ projectRoot: root, lsp: { connection: conn } });
    const res = await call('code_diagnostics', { relativePath: 'sample.ts' }, ctx);
    expect((res.data as { count: number }).count).toBe(0);
  });

  it('routes to Serena when no file is supplied', async () => {
    const { ctx, serenaCalls } = makeCtx({ projectRoot: root, serena: { enabled: true } });
    const res = await call('code_diagnostics', {}, ctx);
    expect(res.ok).toBe(true);
    expect(serenaCalls[0]?.tool).toBe('get_diagnostics');
  });

  it('degrades to an empty successful result with no backend at all', async () => {
    const { ctx } = makeCtx({ projectRoot: root });
    const res = await call('code_diagnostics', { relativePath: 'sample.ts' }, ctx);
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ source: 'none', count: 0, diagnostics: [] });
  });
});

describe('symbol-mutating tools', () => {
  it('renames through the native language server and returns the WorkspaceEdit', async () => {
    const conn = new FakeConnection(root, () => ({ changes: { 'file:///x.ts': [] } }));
    const { ctx } = makeCtx({ projectRoot: root, lsp: { connection: conn } });
    const res = await call(
      'code_rename_symbol',
      { relativePath: 'sample.ts', namePath: 'Beta', newName: 'Gamma' },
      ctx
    );
    expect(res.ok).toBe(true);
    const data = res.data as { source: string; workspaceEdit: unknown };
    expect(data.source).toBe('lsp');
    expect(data.workspaceEdit).toMatchObject({ changes: expect.anything() });
    expect(conn.requests[0]?.method).toBe('textDocument/rename');
    expect(conn.requests[0]?.params).toMatchObject({
      position: { line: 1, character: 13 },
      newName: 'Gamma',
    });
  });

  it('honours explicit coordinates for rename', async () => {
    const conn = new FakeConnection(root, () => ({}));
    const { ctx } = makeCtx({ projectRoot: root, lsp: { connection: conn } });
    await call('code_rename_symbol', { file: 'sample.ts', line: 6, column: 3, newName: 'Zed' }, ctx);
    expect(conn.requests[0]?.params).toMatchObject({ position: { line: 5, character: 2 } });
  });

  it('falls back to Serena when rename is missing a new name', async () => {
    const conn = new FakeConnection(root, () => ({}));
    const { ctx, serenaCalls } = makeCtx({
      projectRoot: root,
      lsp: { connection: conn },
      serena: { enabled: true },
    });
    const res = await call('code_rename_symbol', { relativePath: 'sample.ts', namePath: 'Beta' }, ctx);
    expect(res.ok).toBe(true);
    expect(conn.requests).toHaveLength(0);
    expect(serenaCalls[0]?.tool).toBe('rename_symbol');
  });

  it.each([
    ['code_replace_symbol_body', 'replace_symbol_body'],
    ['code_insert_before_symbol', 'insert_before_symbol'],
    ['code_insert_after_symbol', 'insert_after_symbol'],
  ])('delegates %s to the Serena adapter', async (toolName, serenaTool) => {
    const { ctx, serenaCalls } = makeCtx({ projectRoot: root, serena: { enabled: true } });
    const res = await call(toolName, { namePath: 'Beta', body: 'x' }, ctx);
    expect(res.ok).toBe(true);
    expect(serenaCalls[0]?.tool).toBe(serenaTool);
  });

  it('explains that body edits need the Serena adapter', async () => {
    const { ctx } = makeCtx({ projectRoot: root });
    const res = await call('code_replace_symbol_body', { namePath: 'Beta', body: 'x' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Body edits require the Serena adapter');
  });

  it('does not consult the language server when the manager is disabled', async () => {
    const conn = new FakeConnection(root, () => ({}));
    const { ctx } = makeCtx({
      projectRoot: root,
      lsp: { enabled: false, connection: conn },
      serena: { enabled: true },
    });
    await call('code_symbols_overview', { relativePath: 'sample.ts' }, ctx);
    expect(conn.requests).toHaveLength(0);
  });
});
