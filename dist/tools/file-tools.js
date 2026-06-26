import { readFileSync, writeFileSync, statSync, existsSync, unlinkSync, mkdirSync, renameSync, copyFileSync, cpSync, readdirSync, } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { defineTool } from './registry.js';
import { simpleDiff } from './diff-util.js';
const TEXT_LIMIT = 2_000_000;
function isProbablyBinary(buf) {
    const len = Math.min(buf.length, 8000);
    for (let i = 0; i < len; i++)
        if (buf[i] === 0)
            return true;
    return false;
}
export function fileTools() {
    return [
        defineTool({
            name: 'file_read',
            description: 'Read a text file within the workspace, with optional line offset/limit.',
            group: 'file',
            mutates: false,
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    offset: { type: 'number', description: 'Start line (0-based).' },
                    limit: { type: 'number', description: 'Max lines to return.' },
                },
                required: ['path'],
            },
            handler: async (args, ctx) => {
                const abs = ctx.container.policy.path.resolveSafe(String(args.path), ctx.projectRoot);
                const st = statSync(abs);
                if (st.size > TEXT_LIMIT) {
                    return { ok: false, error: `File too large (${st.size} bytes). Use offset/limit chunking.` };
                }
                const buf = readFileSync(abs);
                if (isProbablyBinary(buf)) {
                    return { ok: true, data: { binary: true, size: st.size, path: String(args.path) } };
                }
                let text = ctx.container.policy.secret.redact(buf.toString('utf8'));
                if (args.offset !== undefined || args.limit !== undefined) {
                    const lines = text.split('\n');
                    const start = Number(args.offset ?? 0);
                    const count = args.limit !== undefined ? Number(args.limit) : lines.length;
                    text = lines.slice(start, start + count).join('\n');
                }
                return { ok: true, data: { content: text, size: st.size } };
            },
        }),
        defineTool({
            name: 'file_read_many',
            description: 'Read multiple text files at once (bounded by count and bytes).',
            group: 'file',
            mutates: false,
            inputSchema: {
                type: 'object',
                properties: {
                    paths: { type: 'array', items: { type: 'string' } },
                    maxFiles: { type: 'number' },
                    maxBytes: { type: 'number' },
                },
                required: ['paths'],
            },
            handler: async (args, ctx) => {
                const paths = args.paths.slice(0, Number(args.maxFiles ?? 25));
                const maxBytes = Number(args.maxBytes ?? 500_000);
                let total = 0;
                const out = {};
                for (const p of paths) {
                    try {
                        const abs = ctx.container.policy.path.resolveSafe(p, ctx.projectRoot);
                        const buf = readFileSync(abs);
                        if (isProbablyBinary(buf)) {
                            out[p] = '[binary file omitted]';
                            continue;
                        }
                        if (total + buf.length > maxBytes) {
                            out[p] = '[skipped: byte budget exceeded]';
                            continue;
                        }
                        total += buf.length;
                        out[p] = ctx.container.policy.secret.redact(buf.toString('utf8'));
                    }
                    catch (err) {
                        out[p] = `[error: ${String(err)}]`;
                    }
                }
                return { ok: true, data: { files: out } };
            },
        }),
        defineTool({
            name: 'file_write',
            description: 'Create or overwrite a text file within the workspace. Returns a diff.',
            group: 'file',
            mutates: true,
            inputSchema: {
                type: 'object',
                properties: { path: { type: 'string' }, content: { type: 'string' } },
                required: ['path', 'content'],
            },
            handler: async (args, ctx) => {
                const abs = ctx.container.policy.path.resolveSafe(String(args.path), ctx.projectRoot);
                const before = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
                const after = String(args.content);
                mkdirSync(dirname(abs), { recursive: true });
                writeFileSync(abs, after, 'utf8');
                return { ok: true, diff: simpleDiff(before, after, String(args.path)), data: { written: true } };
            },
        }),
        defineTool({
            name: 'file_edit_block',
            description: 'Replace an exact text block in a file. Refuses on occurrence mismatch.',
            group: 'file',
            mutates: true,
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    oldText: { type: 'string' },
                    newText: { type: 'string' },
                    expectedOccurrences: { type: 'number' },
                },
                required: ['path', 'oldText', 'newText'],
            },
            handler: async (args, ctx) => {
                const abs = ctx.container.policy.path.resolveSafe(String(args.path), ctx.projectRoot);
                const before = readFileSync(abs, 'utf8');
                const oldText = String(args.oldText);
                const expected = args.expectedOccurrences !== undefined ? Number(args.expectedOccurrences) : 1;
                const count = before.split(oldText).length - 1;
                if (count === 0)
                    return { ok: false, error: 'oldText not found in file.' };
                if (count !== expected) {
                    return { ok: false, error: `Found ${count} occurrences, expected ${expected}. Refusing to edit.` };
                }
                const after = before.split(oldText).join(String(args.newText));
                writeFileSync(abs, after, 'utf8');
                return { ok: true, diff: simpleDiff(before, after, String(args.path)), data: { replaced: count } };
            },
        }),
        defineTool({
            name: 'file_patch',
            description: 'Apply a simple unified-style patch (single-file add/replace blocks).',
            group: 'file',
            mutates: true,
            inputSchema: {
                type: 'object',
                properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } },
                required: ['path', 'newText'],
            },
            handler: async (args, ctx) => {
                // Pragmatic patch: treat as edit_block when oldText present, else full write.
                const abs = ctx.container.policy.path.resolveSafe(String(args.path), ctx.projectRoot);
                const before = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
                let after;
                if (args.oldText) {
                    if (!before.includes(String(args.oldText)))
                        return { ok: false, error: 'Patch context not found.' };
                    after = before.replace(String(args.oldText), String(args.newText));
                }
                else {
                    after = String(args.newText);
                }
                mkdirSync(dirname(abs), { recursive: true });
                writeFileSync(abs, after, 'utf8');
                return { ok: true, diff: simpleDiff(before, after, String(args.path)), data: { patched: true } };
            },
        }),
        defineTool({
            name: 'file_move',
            description: 'Move or rename a file or directory within the workspace. Both source and ' +
                'destination are boundary-checked. Refuses to overwrite unless overwrite=true.',
            group: 'file',
            mutates: true,
            inputSchema: {
                type: 'object',
                properties: {
                    from: { type: 'string', description: 'Source path.' },
                    to: { type: 'string', description: 'Destination path.' },
                    overwrite: { type: 'boolean', description: 'Allow replacing an existing destination.' },
                },
                required: ['from', 'to'],
            },
            handler: async (args, ctx) => {
                const fromAbs = ctx.container.policy.path.resolveSafe(String(args.from), ctx.projectRoot);
                const toAbs = ctx.container.policy.path.resolveSafe(String(args.to), ctx.projectRoot);
                if (!existsSync(fromAbs))
                    return { ok: false, error: `Source does not exist: ${args.from}` };
                if (existsSync(toAbs) && args.overwrite !== true) {
                    return { ok: false, error: `Destination exists: ${args.to}. Pass overwrite=true to replace.` };
                }
                mkdirSync(dirname(toAbs), { recursive: true });
                renameSync(fromAbs, toAbs);
                return { ok: true, data: { moved: true, from: String(args.from), to: String(args.to) } };
            },
        }),
        defineTool({
            name: 'file_copy',
            description: 'Copy a file or directory within the workspace. Directories are copied ' +
                'recursively. Refuses to overwrite unless overwrite=true.',
            group: 'file',
            mutates: true,
            inputSchema: {
                type: 'object',
                properties: {
                    from: { type: 'string', description: 'Source path.' },
                    to: { type: 'string', description: 'Destination path.' },
                    overwrite: { type: 'boolean', description: 'Allow replacing an existing destination.' },
                },
                required: ['from', 'to'],
            },
            handler: async (args, ctx) => {
                const fromAbs = ctx.container.policy.path.resolveSafe(String(args.from), ctx.projectRoot);
                const toAbs = ctx.container.policy.path.resolveSafe(String(args.to), ctx.projectRoot);
                if (!existsSync(fromAbs))
                    return { ok: false, error: `Source does not exist: ${args.from}` };
                if (existsSync(toAbs) && args.overwrite !== true) {
                    return { ok: false, error: `Destination exists: ${args.to}. Pass overwrite=true to replace.` };
                }
                mkdirSync(dirname(toAbs), { recursive: true });
                const isDir = statSync(fromAbs).isDirectory();
                if (isDir) {
                    cpSync(fromAbs, toAbs, { recursive: true, force: args.overwrite === true });
                }
                else {
                    copyFileSync(fromAbs, toAbs);
                }
                return { ok: true, data: { copied: true, directory: isDir, from: String(args.from), to: String(args.to) } };
            },
        }),
        defineTool({
            name: 'list_directory',
            description: 'List the entries of a directory within the workspace. Returns files and ' +
                'subdirectories with type and size. Non-recursive by default.',
            group: 'file',
            mutates: false,
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Directory path (default workspace root).' },
                    recursive: { type: 'boolean', description: 'Recurse into subdirectories.' },
                    maxEntries: { type: 'number', description: 'Cap on returned entries (default 1000).' },
                },
            },
            handler: async (args, ctx) => {
                const target = args.path !== undefined ? String(args.path) : '.';
                const rootAbs = ctx.container.policy.path.resolveSafe(target, ctx.projectRoot);
                if (!existsSync(rootAbs))
                    return { ok: false, error: `Directory does not exist: ${target}` };
                if (!statSync(rootAbs).isDirectory())
                    return { ok: false, error: `Not a directory: ${target}` };
                const max = Number(args.maxEntries ?? 1000);
                const recursive = args.recursive === true;
                const entries = [];
                let truncated = false;
                const walk = (dir) => {
                    if (truncated)
                        return;
                    let names;
                    try {
                        names = readdirSync(dir).sort();
                    }
                    catch {
                        return;
                    }
                    for (const name of names) {
                        if (entries.length >= max) {
                            truncated = true;
                            return;
                        }
                        const abs = join(dir, name);
                        // Skip anything the path policy denies (secrets, node_modules, .git internals).
                        if (ctx.container.policy.path.isDenied(abs, ctx.projectRoot))
                            continue;
                        let st;
                        try {
                            st = statSync(abs);
                        }
                        catch {
                            continue;
                        }
                        const isDir = st.isDirectory();
                        entries.push({
                            path: relative(ctx.projectRoot, abs).split(sep).join('/'),
                            type: isDir ? 'dir' : 'file',
                            size: isDir ? 0 : st.size,
                        });
                        if (recursive && isDir)
                            walk(abs);
                    }
                };
                walk(rootAbs);
                return {
                    ok: true,
                    data: {
                        path: relative(ctx.projectRoot, rootAbs).split(sep).join('/') || '.',
                        recursive,
                        count: entries.length,
                        truncated,
                        entries,
                    },
                };
            },
        }),
        defineTool({
            name: 'file_delete',
            description: 'Delete a file within the workspace. Requires approval by default.',
            group: 'file',
            mutates: true,
            inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
            handler: async (args, ctx) => {
                const abs = ctx.container.policy.path.resolveSafe(String(args.path), ctx.projectRoot);
                if (!existsSync(abs))
                    return { ok: false, error: 'File does not exist.' };
                unlinkSync(abs);
                return { ok: true, data: { deleted: String(args.path) } };
            },
        }),
    ];
}
