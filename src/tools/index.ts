import type { Container } from '../core/container.js';
import { ToolRegistry } from './registry.js';
import { workspaceTools } from './workspace-tools.js';
import { fileTools } from './file-tools.js';
import { searchTools } from './search-tools.js';
import { terminalTools } from './terminal-tools.js';
import { processTools } from './process-tools.js';
import { gitTools } from './git-tools.js';
import { buildTools } from './build-tools.js';
import { memoryTools } from './memory-tools.js';
import { securityTools } from './security-tools.js';
import { codeTools } from './code-tools.js';
import { browserTools } from './browser-tools.js';
import { dbTools } from './db-tools.js';
import { pkgTools } from './pkg-tools.js';
import { formatTools } from './format-tools.js';
import { coverageTools } from './coverage-tools.js';
import { buildAdapterTools } from './adapter-tools.js';

/**
 * Build the full tool registry with every group registered.
 */
export function buildRegistry(container: Container): ToolRegistry {
  const registry = new ToolRegistry(container);
  registry.registerAll([
    ...workspaceTools(),
    ...fileTools(),
    ...searchTools(),
    ...terminalTools(),
    ...processTools(),
    ...gitTools(),
    ...buildTools(),
    ...memoryTools(),
    ...securityTools(),
    ...codeTools(),
    ...browserTools(),
    ...dbTools(),
    ...pkgTools(),
    ...formatTools(),
    ...coverageTools(),
  ]);
  // Expose the registry on the container so routing tools (workspace_route)
  // can switch the active tool subset at runtime.
  container.registry = registry;
  return registry;
}

/**
 * Discover and register tools exposed by enabled child MCP adapters (Serena,
 * Playwright, ...). Each child tool is namespaced (e.g. `serena__find_symbol`)
 * and routed through the normal policy + audit pipeline. Safe to call once after
 * {@link buildRegistry}; a no-op when no adapters are enabled.
 */
export async function registerAdapterTools(
  container: Container,
  registry: ToolRegistry
): Promise<number> {
  const adapterTools = await buildAdapterTools(container);
  registry.registerAll(adapterTools);
  return adapterTools.length;
}

/**
 * Curated tool subsets for task-based routing (section 9 of the spec).
 */
export const TASK_PRESETS: Record<string, string[]> = {
  explore: ['workspace_status', 'search_text', 'search_files', 'code_find_symbol', 'code_symbols_overview', 'file_read'],
  run_ui: ['process_start', 'process_read', 'browser_open', 'browser_snapshot', 'browser_console', 'browser_network'],
  fix_tests: ['run_test', 'code_diagnostics', 'file_patch', 'file_edit_block', 'shell_exec', 'git_diff'],
};

/**
 * Group-based presets used to keep the advertised tool surface small enough for
 * clients that cap the tool list (e.g. ~50 tools). Unlike TASK_PRESETS (which
 * pick individual tools for runtime routing), these select whole groups and are
 * applied once at startup so the very first `tools/list` is already trimmed.
 */
export const GROUP_PRESETS: Record<string, string[]> = {
  // Focused set for AI "vibe coding": read/edit, search, run, git, code intel.
  // Leaves out db, browser, coverage, security, memory to stay well under 50.
  vibe: ['workspace', 'file', 'search', 'terminal', 'process', 'git', 'code', 'build'],
  // Read-only exploration.
  readonly: ['workspace', 'file', 'search', 'code'],
  // Everything (explicit opt-in to the full surface).
  full: [
    'workspace', 'file', 'search', 'terminal', 'process', 'git', 'build',
    'memory', 'security', 'code', 'browser', 'db', 'pkg', 'format', 'coverage',
  ],
};

export interface ToolFilterOptions {
  /** Named group preset (e.g. "vibe"). Ignored when enabledGroups is set. */
  preset?: string | undefined;
  /** Explicit list of groups to keep. Overrides preset. */
  enabledGroups?: string[] | undefined;
  /** Tool names to drop after group filtering. */
  disabled?: string[] | undefined;
  /** Tool names to always keep (added back even if their group was excluded). */
  enabled?: string[] | undefined;
}

/**
 * Compute the set of tool names to advertise, given the full registry and a
 * filter spec. Returns null to mean "expose everything" (no filtering).
 *
 * Resolution order: enabledGroups (or preset's groups) -> add `enabled` extras
 * -> remove `disabled`. `workspace` is always kept so the agent can orient and
 * call workspace_route.
 */
export function resolveActiveTools(
  registry: ToolRegistry,
  opts: ToolFilterOptions
): string[] | null {
  const all = registry.listAll();
  const groups = opts.enabledGroups?.length
    ? opts.enabledGroups
    : opts.preset
      ? GROUP_PRESETS[opts.preset]
      : undefined;

  if (!groups && !opts.disabled?.length && !opts.enabled?.length) {
    return null; // nothing to filter -> expose all
  }

  const keepGroups = new Set([...(groups ?? all.map((t) => t.group)), 'workspace']);
  const keep = new Set(
    all.filter((t) => keepGroups.has(t.group)).map((t) => t.name)
  );
  for (const name of opts.enabled ?? []) keep.add(name);
  for (const name of opts.disabled ?? []) keep.delete(name);
  return [...keep];
}
