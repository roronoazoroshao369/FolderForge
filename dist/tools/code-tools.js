import { defineTool } from './registry.js';
/**
 * Semantic code tools route to the Serena child MCP server.
 * The mapping below translates FolderForge tool names to Serena tool names.
 */
const SERENA_MAP = {
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
async function routeToSerena(ctx, toolName, args) {
    if (!ctx.container.adapters.isEnabled('serena')) {
        return {
            ok: false,
            error: 'Serena adapter is disabled. Enable adapters.serena in config to use semantic code tools. ' +
                'As a fallback, use search_text and code_symbols_overview via ripgrep.',
        };
    }
    try {
        const client = await ctx.container.adapters.ensure('serena');
        const serenaTool = SERENA_MAP[toolName] ?? toolName;
        const result = await client.callTool(serenaTool, args);
        return { ok: true, data: result };
    }
    catch (err) {
        return { ok: false, error: `Serena call failed: ${String(err)}` };
    }
}
function codeTool(name, description, mutates, props) {
    return defineTool({
        name,
        description,
        group: 'code',
        mutates,
        inputSchema: { type: 'object', properties: props },
        handler: (args, ctx) => routeToSerena(ctx, name, args),
    });
}
export function codeTools() {
    return [
        codeTool('code_symbols_overview', 'List top-level symbols in a file (via Serena/LSP).', false, {
            relativePath: { type: 'string' },
        }),
        codeTool('code_find_symbol', 'Find a class/function/method/interface by name (via Serena/LSP).', false, {
            namePath: { type: 'string' },
        }),
        codeTool('code_find_references', 'Find references to a symbol (via Serena/LSP).', false, {
            namePath: { type: 'string' },
        }),
        codeTool('code_find_definition', 'Find a symbol definition (via Serena/LSP).', false, {
            namePath: { type: 'string' },
        }),
        codeTool('code_find_implementations', 'Find implementations of a symbol (via Serena/LSP).', false, {
            namePath: { type: 'string' },
        }),
        codeTool('code_diagnostics', 'Get LSP diagnostics for the project (via Serena/LSP).', false, {}),
        codeTool('code_replace_symbol_body', 'Replace the body of a symbol (via Serena/LSP).', true, {
            namePath: { type: 'string' },
            body: { type: 'string' },
        }),
        codeTool('code_insert_before_symbol', 'Insert code before a symbol (via Serena/LSP).', true, {
            namePath: { type: 'string' },
            body: { type: 'string' },
        }),
        codeTool('code_insert_after_symbol', 'Insert code after a symbol (via Serena/LSP).', true, {
            namePath: { type: 'string' },
            body: { type: 'string' },
        }),
        codeTool('code_rename_symbol', 'Rename a symbol across the project (via Serena/LSP).', true, {
            namePath: { type: 'string' },
            newName: { type: 'string' },
        }),
    ];
}
