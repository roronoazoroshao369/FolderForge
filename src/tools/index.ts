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
