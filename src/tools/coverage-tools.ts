import { execa } from 'execa';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from './registry.js';
import type { ToolDefinition, ToolContext } from '../core/types.js';
import { detectProject } from '../workspace/project-detector.js';
import { parseErrors } from './error-parser.js';
import { COVERAGE_OUTPUT_SCHEMA } from './output-schemas.js';

/**
 * Coverage runner (Gap 5). Detects the test runner, runs it with coverage
 * enabled, then parses a machine-readable coverage report when one is produced
 * (Istanbul `coverage-summary.json` for JS/TS, `coverage.xml` for Python).
 */

interface CoverageCommand {
  argv: string[];
  /** Path (relative to root) to a JSON/XML report to parse after the run. */
  report?: { kind: 'istanbul-json' | 'cobertura-xml'; path: string };
}

export function detectCoverageCommand(root: string): CoverageCommand | null {
  const proj = detectProject(root);
  const has = (f: string) => existsSync(join(root, f));

  if (proj.languageHints.includes('typescript')) {
    const deps = readPkgDeps(root);
    if (deps.vitest) {
      return {
        argv: ['npx', 'vitest', 'run', '--coverage', '--coverage.reporter=json-summary'],
        report: { kind: 'istanbul-json', path: 'coverage/coverage-summary.json' },
      };
    }
    if (deps.jest) {
      return {
        argv: ['npx', 'jest', '--coverage', '--coverageReporters=json-summary'],
        report: { kind: 'istanbul-json', path: 'coverage/coverage-summary.json' },
      };
    }
  }
  if (has('pyproject.toml') || has('requirements.txt')) {
    return {
      argv: ['pytest', '--cov', '--cov-report=xml'],
      report: { kind: 'cobertura-xml', path: 'coverage.xml' },
    };
  }
  if (has('go.mod')) {
    return { argv: ['go', 'test', '-cover', './...'] };
  }
  if (has('Cargo.toml')) {
    return { argv: ['cargo', 'tarpaulin', '--out', 'Stdout'] };
  }
  return null;
}

function readPkgDeps(root: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return {};
  }
}

/** Parse an Istanbul json-summary into a flat total-percentage object. */
export function parseIstanbulSummary(json: string): Record<string, number> | null {
  try {
    const data = JSON.parse(json) as {
      total?: Record<string, { pct?: number }>;
    };
    const total = data.total;
    if (!total) return null;
    const out: Record<string, number> = {};
    for (const key of ['lines', 'statements', 'functions', 'branches']) {
      const pct = total[key]?.pct;
      if (typeof pct === 'number') out[key] = pct;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/** Parse Cobertura XML (pytest-cov) line-rate into a lines percentage. */
export function parseCoberturaXml(xml: string): Record<string, number> | null {
  const m = /line-rate="([0-9.]+)"/.exec(xml);
  if (!m) return null;
  const lines = Math.round(parseFloat(m[1]!) * 1000) / 10; // one decimal place
  const bm = /branch-rate="([0-9.]+)"/.exec(xml);
  const out: Record<string, number> = { lines };
  if (bm) out.branches = Math.round(parseFloat(bm[1]!) * 1000) / 10;
  return out;
}

export function coverageTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'run_coverage',
      description:
        'Run the test suite with coverage enabled and return a structured ' +
        'coverage summary (lines/branches/functions %) plus parsed failures.',
      group: 'build',
      mutates: false,
      inputSchema: { type: 'object', properties: {} },
      outputSchema: COVERAGE_OUTPUT_SCHEMA,
      handler: async (_a, ctx: ToolContext) => {
        const cmd = detectCoverageCommand(ctx.projectRoot);
        if (!cmd) return { ok: false, error: 'No coverage-capable test runner detected.' };

        const [bin, ...rest] = cmd.argv;
        const sub = await execa(bin!, rest, {
          cwd: ctx.projectRoot,
          timeout: ctx.config.terminal.defaultTimeoutMs,
          reject: false,
          maxBuffer: ctx.config.terminal.maxOutputBytes * 4,
        });
        const max = ctx.config.terminal.maxOutputBytes;
        const redact = ctx.container.policy.secret.redact;
        const stdout = redact((sub.stdout ?? '').slice(0, max));
        const stderr = redact((sub.stderr ?? '').slice(0, max));

        let summary: Record<string, number> | null = null;
        if (cmd.report) {
          const reportPath = join(ctx.projectRoot, cmd.report.path);
          if (existsSync(reportPath)) {
            try {
              const raw = readFileSync(reportPath, 'utf8');
              summary =
                cmd.report.kind === 'istanbul-json'
                  ? parseIstanbulSummary(raw)
                  : parseCoberturaXml(raw);
            } catch {
              summary = null;
            }
          }
        }

        return {
          ok: sub.exitCode === 0,
          data: {
            command: cmd.argv.join(' '),
            exitCode: sub.exitCode ?? null,
            summary,
            errors: parseErrors(`${stdout}\n${stderr}`),
            stdout,
            stderr,
          },
        };
      },
    }),
  ];
}
