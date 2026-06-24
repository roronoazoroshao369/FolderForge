import { readFileSync, writeFileSync, statSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { defineTool } from './registry.js';
import type { ToolDefinition } from '../core/types.js';
import { simpleDiff } from './diff-util.js';

const TEXT_LIMIT = 2_000_000;

function isProbablyBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

export function fileTools(): ToolDefinition[] {
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
        const paths = (args.paths as string[]).slice(0, Number(args.maxFiles ?? 25));
        const maxBytes = Number(args.maxBytes ?? 500_000);
        let total = 0;
        const out: Record<string, string> = {};
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
          } catch (err) {
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
        if (count === 0) return { ok: false, error: 'oldText not found in file.' };
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
        let after: string;
        if (args.oldText) {
          if (!before.includes(String(args.oldText))) return { ok: false, error: 'Patch context not found.' };
          after = before.replace(String(args.oldText), String(args.newText));
        } else {
          after = String(args.newText);
        }
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, after, 'utf8');
        return { ok: true, diff: simpleDiff(before, after, String(args.path)), data: { patched: true } };
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
        if (!existsSync(abs)) return { ok: false, error: 'File does not exist.' };
        unlinkSync(abs);
        return { ok: true, data: { deleted: String(args.path) } };
      },
    }),
  ];
}
