import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { defineTool } from './registry.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../core/types.js';
import {
  flattenSymbols,
  normalizeLocation,
  normalizeDiagnostics,
  type LspConnection,
} from '../managers/lsp-manager.js';
import { DIAGNOSTICS_OUTPUT_SCHEMA } from './output-schemas.js';

/**
 * Semantic code tools. Resolution order (Gap 1, hybrid):
 *   1. Native LSP  - spawn the project's language server and speak JSON-RPC
 *      directly (LspManager). Authoritative, no external MCP needed.
 *   2. Serena child-MCP - if the LSP binary is unavailable but the Serena
 *      adapter is enabled, route there.
 *   3. Regex fallback - `search_ast` / `search_text` style structural search,
 *      always available, lower fidelity.
 *
 * Each tool reports `source` in its data so callers know which backend answered.
 */

const SERENA_MAP: Record<string, string> = {
  code_symbols_overview: 'get_symbols_overview',
  code_find_symbol: 'find_symbol',
  code_find_references: 'find_referencing_symbols',
  code_find_definition: 'find_symbol',
  code_find_implementations: 'find_symbol',
  code_diagnostics: 'get_diagnostics',
  code_replace_symbol_body: 'replace_symbol_body',
  code_insert_before_symbol: 'insert_before_symbol',
  code_insert_after_symbol: 'insert_after_symbol',
  code_rename_symbol: 'rename_symbol',
};

async function routeToSerena(
  ctx: ToolContext,
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult | null> {
  if (!ctx.container.adapters.isEnabled('serena')) return null;
  try {
    const client = await ctx.container.adapters.ensure('serena');
    const serenaTool = SERENA_MAP[toolName] ?? toolName;
    const result = await client.callTool(serenaTool, args);
    return { ok: true, data: { source: 'serena', result } };
  } catch (err) {
    return { ok: false, error: `Serena call failed: ${String(err)}` };
  }
}

/** Resolve a usable LSP connection for a file, or null if unavailable. */
async function lspForFile(ctx: ToolContext, relativePath: string): Promise<LspConnection | null> {
  const mgr = ctx.container.lsp;
  if (!mgr?.isEnabled?.()) return null;
  const def = mgr.serverForPath(relativePath);
  if (!def) return null;
  return mgr.ensure(def, ctx.projectRoot);
}

/** 0-based {line, character} position from a 1-based {line, column} request. */
function toLspPosition(args: Record<string, unknown>): { line: number; character: number } {
  const line = Math.max(0, Number(args.line ?? 1) - 1);
  const character = Math.max(0, Number(args.column ?? 1) - 1);
  return { line, character };
}

/**
 * Find the first declaration line of a named symbol in a file, so callers can
 * use the simpler `namePath` ergonomics (Serena-style) instead of supplying raw
 * line/column. Returns a 0-based position or null.
 */
function locateSymbol(absPath: string, name: string): { line: number; character: number } | null {
  let text: string;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  const leaf = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  const re = new RegExp(`\\b${leaf.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]!);
    if (m) return { line: i, character: m.index };
  }
  return null;
}

function absOf(ctx: ToolContext, relativePath: string): string {
  return isAbsolute(relativePath) ? relativePath : join(ctx.projectRoot, relativePath);
}

/** Standard "no backend" failure when native + Serena both decline. */
function noBackend(extra = ''): ToolResult {
  return {
    ok: false,
    error:
      'No semantic backend available. Install a language server (e.g. ' +
      'typescript-language-server, pyright) or enable adapters.serena. ' +
      'Fallback: use search_ast / search_text.' +
      (extra ? ` ${extra}` : ''),
  };
}

// --- handlers -------------------------------------------------------------

async function symbolsOverview(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const rel = String(args.relativePath ?? '');
  if (!rel) return { ok: false, error: 'relativePath is required.' };
  const conn = await lspForFile(ctx, rel);
  if (conn) {
    const uri = conn.ensureOpen(rel);
    const result = await conn.request('textDocument/documentSymbol', {
      textDocument: { uri },
    });
    return { ok: true, data: { source: 'lsp', symbols: flattenSymbols(result) } };
  }
  const serena = await routeToSerena(ctx, 'code_symbols_overview', args);
  return serena ?? noBackend();
}

async function findSymbol(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const name = String(args.namePath ?? '');
  if (!name) return { ok: false, error: 'namePath is required.' };
  const mgr = ctx.container.lsp;
  if (mgr?.isEnabled?.()) {
    // workspace/symbol needs a live server; pick any configured one we can start.
    const def = mgr.serverForPath('x.ts') ?? mgr.serverById('typescript');
    const conn = def ? await mgr.ensure(def, ctx.projectRoot) : null;
    if (conn) {
      const leaf = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
      const result = await conn.request('workspace/symbol', { query: leaf });
      const matches = (Array.isArray(result) ? result : [])
        .map((s) => {
          const x = s as { name?: string; location?: unknown; kind?: number };
          const loc = normalizeLocation(x.location);
          return x.name && loc ? { name: x.name, ...loc } : null;
        })
        .filter(Boolean);
      return { ok: true, data: { source: 'lsp', matches } };
    }
  }
  const serena = await routeToSerena(ctx, 'code_find_symbol', args);
  return serena ?? noBackend();
}

/** definition / references / implementations all share the position dance. */
function positionalTool(
  lspMethod: 'textDocument/definition' | 'textDocument/references' | 'textDocument/implementation',
  serenaName: string
) {
  return async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const rel = String(args.relativePath ?? args.file ?? '');
    if (rel) {
      const conn = await lspForFile(ctx, rel);
      if (conn) {
        const uri = conn.ensureOpen(rel);
        // Allow either explicit line/column or a symbol name to locate.
        let pos = toLspPosition(args);
        if (args.line === undefined && args.namePath) {
          const found = locateSymbol(absOf(ctx, rel), String(args.namePath));
          if (found) pos = found;
        }
        const params: Record<string, unknown> = {
          textDocument: { uri },
          position: pos,
        };
        if (lspMethod === 'textDocument/references') {
          params.context = { includeDeclaration: true };
        }
        const result = await conn.request(lspMethod, params);
        const arr = Array.isArray(result) ? result : result ? [result] : [];
        const locations = arr.map(normalizeLocation).filter(Boolean);
        return { ok: true, data: { source: 'lsp', locations } };
      }
    }
    const serena = await routeToSerena(ctx, serenaName, args);
    return serena ?? noBackend('This tool needs a file (relativePath) for native LSP.');
  };
}

async function diagnostics(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const rel = String(_args.relativePath ?? '');
  const mgr = ctx.container.lsp;
  if (rel && mgr?.isEnabled?.()) {
    const conn = await lspForFile(ctx, rel);
    if (conn) {
      const uri = conn.ensureOpen(rel);
      // publishDiagnostics is push-based; give the server a brief moment.
      await new Promise((r) => setTimeout(r, 400));
      const diags = conn.diagnostics.get(uri) ?? [];
      const normalized = normalizeDiagnostics(uri, diags);
      return {
        ok: true,
        data: { source: 'lsp', diagnostics: normalized, count: normalized.length },
      };
    }
  }
  const serena = await routeToSerena(ctx, 'code_diagnostics', _args);
  return serena ?? { ok: true, data: { source: 'none', diagnostics: [], count: 0 } };
}

async function mutatingSymbol(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  // Native LSP rename is supported; body insert/replace are delegated to Serena
  // (which performs the AST edit). Native rename uses textDocument/rename.
  if (toolName === 'code_rename_symbol') {
    const rel = String(args.relativePath ?? args.file ?? '');
    const newName = String(args.newName ?? '');
    if (rel && newName) {
      const conn = await lspForFile(ctx, rel);
      if (conn) {
        const uri = conn.ensureOpen(rel);
        let pos = toLspPosition(args);
        if (args.line === undefined && args.namePath) {
          const found = locateSymbol(absOf(ctx, rel), String(args.namePath));
          if (found) pos = found;
        }
        const edit = await conn.request('textDocument/rename', {
          textDocument: { uri },
          position: pos,
          newName,
        });
        return { ok: true, data: { source: 'lsp', workspaceEdit: edit } };
      }
    }
  }
  const serena = await routeToSerena(ctx, toolName, args);
  return serena ?? noBackend('Body edits require the Serena adapter.');
}

// --- registration ---------------------------------------------------------

function readTool(
  name: string,
  description: string,
  props: Record<string, unknown>,
  handler: ToolDefinition['handler'],
  outputSchema?: Record<string, unknown>
): ToolDefinition {
  return defineTool({
    name,
    description,
    group: 'code',
    mutates: false,
    inputSchema: { type: 'object', properties: props },
    ...(outputSchema ? { outputSchema } : {}),
    handler,
  });
}

function writeTool(
  name: string,
  description: string,
  props: Record<string, unknown>,
  handler: ToolDefinition['handler']
): ToolDefinition {
  return defineTool({
    name,
    description,
    group: 'code',
    mutates: true,
    inputSchema: { type: 'object', properties: props },
    handler,
  });
}

export function codeTools(): ToolDefinition[] {
  return [
    readTool(
      'code_symbols_overview',
      'List symbols declared in a file (native LSP, Serena fallback).',
      { relativePath: { type: 'string' } },
      symbolsOverview
    ),
    readTool(
      'code_find_symbol',
      'Find a class/function/method/interface by name across the workspace (native LSP, Serena fallback).',
      { namePath: { type: 'string' } },
      findSymbol
    ),
    readTool(
      'code_find_references',
      'Find references to a symbol at a file position or by name (native LSP, Serena fallback).',
      { relativePath: { type: 'string' }, namePath: { type: 'string' }, line: { type: 'number' }, column: { type: 'number' } },
      positionalTool('textDocument/references', 'code_find_references')
    ),
    readTool(
      'code_find_definition',
      'Jump to a symbol definition at a file position or by name (native LSP, Serena fallback).',
      { relativePath: { type: 'string' }, namePath: { type: 'string' }, line: { type: 'number' }, column: { type: 'number' } },
      positionalTool('textDocument/definition', 'code_find_definition')
    ),
    readTool(
      'code_find_implementations',
      'Find implementations of an interface/abstract symbol (native LSP, Serena fallback).',
      { relativePath: { type: 'string' }, namePath: { type: 'string' }, line: { type: 'number' }, column: { type: 'number' } },
      positionalTool('textDocument/implementation', 'code_find_implementations')
    ),
    readTool(
      'code_diagnostics',
      'Get language-server diagnostics for a file (native LSP, Serena fallback).',
      { relativePath: { type: 'string' } },
      diagnostics,
      DIAGNOSTICS_OUTPUT_SCHEMA
    ),
    writeTool(
      'code_replace_symbol_body',
      'Replace the body of a symbol (via Serena adapter).',
      { namePath: { type: 'string' }, body: { type: 'string' } },
      (a, c) => mutatingSymbol('code_replace_symbol_body', a, c)
    ),
    writeTool(
      'code_insert_before_symbol',
      'Insert code before a symbol (via Serena adapter).',
      { namePath: { type: 'string' }, body: { type: 'string' } },
      (a, c) => mutatingSymbol('code_insert_before_symbol', a, c)
    ),
    writeTool(
      'code_insert_after_symbol',
      'Insert code after a symbol (via Serena adapter).',
      { namePath: { type: 'string' }, body: { type: 'string' } },
      (a, c) => mutatingSymbol('code_insert_after_symbol', a, c)
    ),
    writeTool(
      'code_rename_symbol',
      'Rename a symbol across the project (native LSP rename, Serena fallback). Returns a WorkspaceEdit.',
      { relativePath: { type: 'string' }, namePath: { type: 'string' }, line: { type: 'number' }, column: { type: 'number' }, newName: { type: 'string' } },
      (a, c) => mutatingSymbol('code_rename_symbol', a, c)
    ),
  ];
}
