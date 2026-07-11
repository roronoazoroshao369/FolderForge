import { execa } from 'execa';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from './registry.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../core/types.js';
import { detectProject } from '../workspace/project-detector.js';
import { parseErrors } from './error-parser.js';

/**
 * Package-management tools (Gap 2). Each tool resolves the project's package
 * manager from on-disk manifests/lockfiles (never trusting client input for the
 * tool binary) and shells out through the configured shell, with secret
 * redaction and output capping consistent with build-tools.
 *
 * Risk model:
 *   pkg_list / pkg_outdated / pkg_audit  -> read-only (LOW)
 *   pkg_run                              -> runs an existing manifest script (MEDIUM)
 *   pkg_add / pkg_remove                 -> mutate the dependency tree (HIGH)
 */

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'pip' | 'cargo' | 'go' | null;

/** Detect the package manager for a project root (lockfile-first). */
export function detectPackageManager(root: string): PackageManager {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'package-lock.json'))) return 'npm';
  if (existsSync(join(root, 'package.json'))) return 'npm';
  if (existsSync(join(root, 'Cargo.toml'))) return 'cargo';
  if (existsSync(join(root, 'go.mod'))) return 'go';
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'requirements.txt'))) return 'pip';
  return null;
}

interface PmCommands {
  list: string[] | null;
  outdated: string[] | null;
  audit: string[] | null;
  add: (pkg: string, dev: boolean) => string[] | null;
  remove: (pkg: string) => string[] | null;
  run: ((script: string) => string[] | null) | null;
}

/** Map a package manager to its CLI verbs. `null` = unsupported for that op. */
function commandsFor(pm: PackageManager): PmCommands | null {
  switch (pm) {
    case 'npm':
      return {
        list: ['npm', 'ls', '--depth=0'],
        outdated: ['npm', 'outdated', '--json'],
        audit: ['npm', 'audit', '--json'],
        add: (p, dev) => ['npm', 'install', dev ? '--save-dev' : '--save', p],
        remove: (p) => ['npm', 'uninstall', p],
        run: (s) => ['npm', 'run', s],
      };
    case 'pnpm':
      return {
        list: ['pnpm', 'list', '--depth=0'],
        outdated: ['pnpm', 'outdated', '--format', 'json'],
        audit: ['pnpm', 'audit', '--json'],
        add: (p, dev) => ['pnpm', 'add', ...(dev ? ['-D'] : []), p],
        remove: (p) => ['pnpm', 'remove', p],
        run: (s) => ['pnpm', 'run', s],
      };
    case 'yarn':
      return {
        list: ['yarn', 'list', '--depth=0'],
        outdated: ['yarn', 'outdated', '--json'],
        audit: ['yarn', 'audit', '--json'],
        add: (p, dev) => ['yarn', 'add', ...(dev ? ['-D'] : []), p],
        remove: (p) => ['yarn', 'remove', p],
        run: (s) => ['yarn', 'run', s],
      };
    case 'pip':
      return {
        list: ['pip', 'list'],
        outdated: ['pip', 'list', '--outdated'],
        audit: ['pip-audit'], // optional tool; reports unavailable if missing
        add: (p) => ['pip', 'install', p],
        remove: (p) => ['pip', 'uninstall', '-y', p],
        run: null,
      };
    case 'cargo':
      return {
        list: ['cargo', 'tree', '--depth', '1'],
        outdated: ['cargo', 'outdated'],
        audit: ['cargo', 'audit'],
        add: (p, dev) => ['cargo', 'add', ...(dev ? ['--dev'] : []), p],
        remove: (p) => ['cargo', 'remove', p],
        run: null,
      };
    case 'go':
      return {
        list: ['go', 'list', '-m', 'all'],
        outdated: ['go', 'list', '-m', '-u', 'all'],
        audit: ['govulncheck', './...'],
        add: (p) => ['go', 'get', p],
        remove: (p) => ['go', 'get', `${p}@none`],
        run: null,
      };
    default:
      return null;
  }
}

/** A package spec must look like a dependency name/version, not a shell payload. */
function validatePkgSpec(spec: string): string | null {
  // Allow scoped names, versions, extras, and git/url-free specs.
  // Reject shell metacharacters to prevent argument-injection via the spec.
  if (!spec || spec.length > 214) return 'Package spec is empty or too long.';
  if (/[;&|`$(){}<>\n\r\\]/.test(spec)) return 'Package spec contains illegal characters.';
  if (/^\s|\s$/.test(spec)) return 'Package spec has leading/trailing whitespace.';
  return null;
}

export async function runPm(ctx: ToolContext, argv: string[]): Promise<ToolResult> {
  const [bin, ...rest] = argv;
  const sub = await execa(bin!, rest, {
    cwd: ctx.projectRoot,
    timeout: ctx.config.terminal.defaultTimeoutMs,
    reject: false,
    maxBuffer: ctx.config.terminal.maxOutputBytes * 4,
  });
  if (sub.exitCode === undefined && sub.failed && /ENOENT/.test(String(sub.shortMessage ?? ''))) {
    return { ok: false, error: `Command not found: ${bin}. Install it or pick another package manager.` };
  }
  const max = ctx.config.terminal.maxOutputBytes;
  const redact = ctx.container.policy.secret.redact;
  const stdout = redact((sub.stdout ?? '').slice(0, max));
  const stderr = redact((sub.stderr ?? '').slice(0, max));
  const exitCode = sub.exitCode ?? null;
  const data = { command: argv.join(' '), exitCode, stdout, stderr };
  if (exitCode !== 0) {
    return {
      ok: false,
      error: `${bin} exited with code ${exitCode ?? 'unknown'}.`,
      data,
    };
  }
  return { ok: true, data };
}

function withPm(
  build: (cmds: PmCommands, pm: Exclude<PackageManager, null>) => string[] | null
) {
  return async (ctx: ToolContext): Promise<{ argv: string[] } | ToolResult> => {
    const pm = detectPackageManager(ctx.projectRoot);
    if (!pm) {
      return { ok: false, error: 'No package manager detected (no package.json/pyproject/Cargo/go.mod).' };
    }
    const cmds = commandsFor(pm);
    if (!cmds) return { ok: false, error: `Unsupported package manager: ${pm}` };
    const argv = build(cmds, pm);
    if (!argv) return { ok: false, error: `Operation not supported for ${pm}.` };
    return { argv };
  };
}

export function pkgTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'pkg_list',
      description: 'List installed top-level dependencies (auto-detects the package manager).',
      group: 'pkg',
      mutates: false,
      inputSchema: { type: 'object', properties: {} },
      handler: async (_a, ctx) => {
        const r = await withPm((c) => c.list)(ctx);
        if ('ok' in r) return r;
        return runPm(ctx, r.argv);
      },
    }),
    defineTool({
      name: 'pkg_outdated',
      description: 'Report dependencies that have newer versions available.',
      group: 'pkg',
      mutates: false,
      inputSchema: { type: 'object', properties: {} },
      handler: async (_a, ctx) => {
        const r = await withPm((c) => c.outdated)(ctx);
        if ('ok' in r) return r;
        return runPm(ctx, r.argv);
      },
    }),
    defineTool({
      name: 'pkg_audit',
      description: 'Scan dependencies for known vulnerabilities.',
      group: 'pkg',
      mutates: false,
      inputSchema: { type: 'object', properties: {} },
      handler: async (_a, ctx) => {
        const r = await withPm((c) => c.audit)(ctx);
        if ('ok' in r) return r;
        return runPm(ctx, r.argv);
      },
    }),
    defineTool({
      name: 'pkg_run',
      description: 'Run a script defined in the project manifest (e.g. package.json scripts).',
      group: 'pkg',
      mutates: true,
      inputSchema: {
        type: 'object',
        properties: { script: { type: 'string', description: 'Script name as declared in the manifest.' } },
        required: ['script'],
      },
      handler: async (args, ctx) => {
        const script = String(args.script ?? '');
        const bad = validatePkgSpec(script);
        if (bad) return { ok: false, error: bad };
        // Guard: only allow scripts that actually exist in package.json.
        const proj = detectProject(ctx.projectRoot);
        if (proj.packageManagers.some((p) => ['npm', 'pnpm', 'yarn'].includes(p))) {
          try {
            const pkg = JSON.parse(
              readFileSync(join(ctx.projectRoot, 'package.json'), 'utf8')
            ) as { scripts?: Record<string, string> };
            if (!pkg.scripts || !(script in pkg.scripts)) {
              return { ok: false, error: `Script "${script}" is not defined in package.json.` };
            }
          } catch {
            /* fall through to attempt run */
          }
        }
        const r = await withPm((c) => (c.run ? c.run(script) : null))(ctx);
        if ('ok' in r) return r;
        const res = await runPm(ctx, r.argv);
        if (res.ok && res.data) {
          const d = res.data as { stdout?: string; stderr?: string };
          (res.data as Record<string, unknown>).errors = parseErrors(
            `${d.stdout ?? ''}\n${d.stderr ?? ''}`
          );
        }
        return res;
      },
    }),
    defineTool({
      name: 'pkg_add',
      description: 'Add a dependency. HIGH risk; mutates the dependency tree (requires approval per policy).',
      group: 'pkg',
      mutates: true,
      inputSchema: {
        type: 'object',
        properties: {
          package: { type: 'string', description: 'Dependency spec, e.g. "lodash" or "lodash@4".' },
          dev: { type: 'boolean', description: 'Install as a dev dependency.' },
        },
        required: ['package'],
      },
      handler: async (args, ctx) => {
        const spec = String(args.package ?? '');
        const bad = validatePkgSpec(spec);
        if (bad) return { ok: false, error: bad };
        const dev = Boolean(args.dev);
        const r = await withPm((c) => c.add(spec, dev))(ctx);
        if ('ok' in r) return r;
        return runPm(ctx, r.argv);
      },
    }),
    defineTool({
      name: 'pkg_remove',
      description: 'Remove a dependency. HIGH risk; mutates the dependency tree (requires approval per policy).',
      group: 'pkg',
      mutates: true,
      inputSchema: {
        type: 'object',
        properties: { package: { type: 'string' } },
        required: ['package'],
      },
      handler: async (args, ctx) => {
        const spec = String(args.package ?? '');
        const bad = validatePkgSpec(spec);
        if (bad) return { ok: false, error: bad };
        const r = await withPm((c) => c.remove(spec))(ctx);
        if ('ok' in r) return r;
        return runPm(ctx, r.argv);
      },
    }),
  ];
}
