import { readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import fg from 'fast-glob';
import { defineTool } from './registry.js';
import type { ToolDefinition } from '../core/types.js';

export function searchTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'search_files',
      description: 'Find files by name or glob pattern inside the workspace.',
      group: 'search',
      mutates: false,
      inputSchema: {
        type: 'object',
        properties: {
          glob: { type: 'string', description: 'Glob, e.g. src/**/*.ts' },
          limit: { type: 'number' },
        },
        required: ['glob'],
      },
      handler: async (args, ctx) => {
        const pattern = String(args.glob);
        const matches = await fg(pattern, {
          cwd: ctx.projectRoot,
          dot: false,
          ignore: ['**/node_modules/**', '**/.git/**'],
          onlyFiles: true,
        });
        const limit = Number(args.limit ?? 200);
        return { ok: true, data: { matches: matches.slice(0, limit), total: matches.length } };
      },
    }),

    defineTool({
      name: 'search_text',
      description: 'Search text/regex across files (ripgrep-style, native).',
      group: 'search',
      mutates: false,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          glob: { type: 'string' },
          caseSensitive: { type: 'boolean' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
      handler: async (args, ctx) => {
        const glob = String(args.glob ?? '**/*');
        const limit = Number(args.limit ?? 200);
        const flags = args.caseSensitive ? 'g' : 'gi';
        let re: RegExp;
        try {
          re = new RegExp(String(args.query), flags);
        } catch {
          // Treat as literal if invalid regex.
          re = new RegExp(escapeRegExp(String(args.query)), flags);
        }
        const files = await fg(glob, {
          cwd: ctx.projectRoot,
          ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
          onlyFiles: true,
          absolute: true,
        });
        const results: Array<{ file: string; line: number; text: string }> = [];
        for (const file of files) {
          if (results.length >= limit) break;
          try {
            if (statSync(file).size > 2_000_000) continue;
            const content = readFileSync(file, 'utf8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              re.lastIndex = 0;
              if (re.test(lines[i]!)) {
                results.push({
                  file: relative(ctx.projectRoot, file),
                  line: i + 1,
                  text: ctx.container.policy.secret.redact(lines[i]!.slice(0, 300)),
                });
                if (results.length >= limit) break;
              }
            }
          } catch {
            // skip unreadable/binary
          }
        }
        return { ok: true, data: { matches: results, count: results.length } };
      },
    }),

    defineTool({
      name: 'search_ast',
      description:
        'Structural search for code declarations (functions, classes, methods, ' +
        'interfaces, types, consts) by name across the workspace. Lightweight, ' +
        'regex-backed structural matching - no language server required.',
      group: 'search',
      mutates: false,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Symbol name or partial name to find.' },
          kind: {
            type: 'string',
            description: 'Restrict to one kind: function | class | method | interface | type | const',
            enum: ['function', 'class', 'method', 'interface', 'type', 'const'],
          },
          glob: { type: 'string', description: 'File glob to limit the search (default common source files).' },
          limit: { type: 'number' },
        },
        required: ['name'],
      },
      handler: async (args, ctx) => {
        const name = String(args.name);
        const kindFilter = args.kind === undefined ? null : String(args.kind);
        const glob = String(args.glob ?? '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,rb,c,h,cpp,cs}');
        const limit = Number(args.limit ?? 200);
        const escaped = escapeRegExp(name);

        // Structural declaration patterns. Each entry maps a kind to a regex whose
        // match indicates a declaration of `name`.
        const patterns: Array<{ kind: string; re: RegExp }> = [
          { kind: 'function', re: new RegExp(`\\b(?:async\\s+)?function\\s+(${escaped})\\b`) },
          { kind: 'function', re: new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+(${escaped})\\s*=\\s*(?:async\\s*)?\\(`) },
          { kind: 'function', re: new RegExp(`\\bdef\\s+(${escaped})\\s*\\(`) }, // python
          { kind: 'function', re: new RegExp(`\\bfunc\\s+(${escaped})\\s*\\(`) }, // go
          { kind: 'class', re: new RegExp(`\\bclass\\s+(${escaped})\\b`) },
          { kind: 'interface', re: new RegExp(`\\binterface\\s+(${escaped})\\b`) },
          { kind: 'type', re: new RegExp(`\\btype\\s+(${escaped})\\b`) },
          { kind: 'const', re: new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+(${escaped})\\b`) },
          { kind: 'method', re: new RegExp(`^\\s*(?:public|private|protected|static|async|\\s)*\\b(${escaped})\\s*\\(`) },
        ].filter((p) => !kindFilter || p.kind === kindFilter);

        const files = await fg(glob, {
          cwd: ctx.projectRoot,
          ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
          onlyFiles: true,
          absolute: true,
        });

        const results: Array<{ file: string; line: number; kind: string; text: string }> = [];
        for (const file of files) {
          if (results.length >= limit) break;
          try {
            if (statSync(file).size > 2_000_000) continue;
            const lines = readFileSync(file, 'utf8').split('\n');
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i]!;
              for (const { kind, re } of patterns) {
                if (re.test(line)) {
                  results.push({
                    file: relative(ctx.projectRoot, file),
                    line: i + 1,
                    kind,
                    text: line.trim().slice(0, 300),
                  });
                  break; // one hit per line is enough
                }
              }
              if (results.length >= limit) break;
            }
          } catch {
            // skip unreadable/binary
          }
        }
        return { ok: true, data: { matches: results, count: results.length } };
      },
    }),
  ];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
