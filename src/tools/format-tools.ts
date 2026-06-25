import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from './registry.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../core/types.js';
import { detectProject } from '../workspace/project-detector.js';

/**
 * Formatting tools (Gap 3). Detects the project's formatter from manifests and
 * either checks (read-only) or applies (mutating) formatting.
 *
 *   format_check  -> dry-run, reports files that would change (LOW)
 *   format_apply  -> writes formatted files (MEDIUM)
 */

export interface FormatterSpec {
  id: string;
  /** argv to *check* without writing. */
  check: string[];
  /** argv to *apply* (write) formatting. */
  apply: string[];
}

/**
 * Resolve the formatter for a project. Prefers explicit config files, then
 * language defaults. Returns null when none is detectable.
 */
export function detectFormatter(root: string): FormatterSpec | null {
  const has = (f: string) => existsSync(join(root, f));

  // JS/TS: prefer Prettier, then Biome.
  if (
    has('.prettierrc') ||
    has('.prettierrc.json') ||
    has('.prettierrc.js') ||
    has('prettier.config.js') ||
    has('.prettierrc.yaml')
  ) {
    return {
      id: 'prettier',
      check: ['npx', 'prettier', '--check', '.'],
      apply: ['npx', 'prettier', '--write', '.'],
    };
  }
  if (has('biome.json') || has('biome.jsonc')) {
    return {
      id: 'biome',
      check: ['npx', 'biome', 'check', '.'],
      apply: ['npx', 'biome', 'check', '--write', '.'],
    };
  }

  // Python: Ruff formatter, then Black.
  if (has('pyproject.toml') || has('ruff.toml') || has('.ruff.toml')) {
    return {
      id: 'ruff',
      check: ['ruff', 'format', '--check', '.'],
      apply: ['ruff', 'format', '.'],
    };
  }
  if (has('requirements.txt')) {
    return {
      id: 'black',
      check: ['black', '--check', '.'],
      apply: ['black', '.'],
    };
  }

  // Go / Rust.
  if (has('go.mod')) {
    return { id: 'gofmt', check: ['gofmt', '-l', '.'], apply: ['gofmt', '-w', '.'] };
  }
  if (has('Cargo.toml')) {
    return { id: 'rustfmt', check: ['cargo', 'fmt', '--', '--check'], apply: ['cargo', 'fmt'] };
  }

  // JS/TS fallback when package.json exists but no formatter config: try prettier.
  const proj = detectProject(root);
  if (proj.languageHints.includes('typescript')) {
    return {
      id: 'prettier',
      check: ['npx', 'prettier', '--check', '.'],
      apply: ['npx', 'prettier', '--write', '.'],
    };
  }
  return null;
}

async function runFmt(ctx: ToolContext, argv: string[]): Promise<ToolResult> {
  const [bin, ...rest] = argv;
  const sub = await execa(bin!, rest, {
    cwd: ctx.projectRoot,
    timeout: ctx.config.terminal.defaultTimeoutMs,
    reject: false,
    maxBuffer: ctx.config.terminal.maxOutputBytes * 4,
  });
  const max = ctx.config.terminal.maxOutputBytes;
  const redact = ctx.container.policy.secret.redact;
  return {
    ok: sub.exitCode === 0,
    data: {
      command: argv.join(' '),
      exitCode: sub.exitCode ?? null,
      stdout: redact((sub.stdout ?? '').slice(0, max)),
      stderr: redact((sub.stderr ?? '').slice(0, max)),
    },
  };
}

export function formatTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'format_check',
      description: 'Check formatting without writing (auto-detects Prettier/Biome/Ruff/Black/gofmt/rustfmt).',
      group: 'format',
      mutates: false,
      inputSchema: { type: 'object', properties: {} },
      handler: async (_a, ctx) => {
        const fmt = detectFormatter(ctx.projectRoot);
        if (!fmt) return { ok: false, error: 'No formatter detected for this project.' };
        const res = await runFmt(ctx, fmt.check);
        (res.data as Record<string, unknown>).formatter = fmt.id;
        // A non-zero exit from a check means "would reformat", not a hard error.
        return { ok: true, data: { ...(res.data as object), needsFormatting: !res.ok } };
      },
    }),
    defineTool({
      name: 'format_apply',
      description: 'Apply formatting in place (auto-detects the project formatter). Mutates files.',
      group: 'format',
      mutates: true,
      inputSchema: { type: 'object', properties: {} },
      handler: async (_a, ctx) => {
        const fmt = detectFormatter(ctx.projectRoot);
        if (!fmt) return { ok: false, error: 'No formatter detected for this project.' };
        const res = await runFmt(ctx, fmt.apply);
        (res.data as Record<string, unknown>).formatter = fmt.id;
        return res;
      },
    }),
  ];
}
