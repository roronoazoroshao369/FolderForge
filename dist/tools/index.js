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
export function buildRegistry(container) {
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
export async function registerAdapterTools(container, registry) {
    const adapterTools = await buildAdapterTools(container);
    registry.registerAll(adapterTools);
    return adapterTools.length;
}
/**
 * Curated tool subsets for task-based routing (section 9 of the spec).
 */
export const TASK_PRESETS = {
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
export const GROUP_PRESETS = {
    // Focused set for AI "vibe coding": read/edit, search, run, git, code intel.
    // Leaves out db, browser, coverage, security, memory to stay well under 50.
    vibe: ['workspace', 'file', 'search', 'terminal', 'process', 'git', 'code', 'build'],
    // Same groups as `vibe`, but hard-capped to fit clients that reject more than
    // 50 tools. The cap is applied by PRESET_TOOL_CAP below; group order here also
    // sets keep-priority so the most useful groups survive the trim.
    // Pure folder-scoped coding set + UI testing via the browser group. No
    // workspace_* tools (the agent is pinned to a single folder via config, so
    // activate/switch/route are noise). Docker is covered by shell_exec, so no
    // dedicated docker group is needed. Listed in PRESET_NO_FORCE_WORKSPACE so the
    // always-keep-workspace rule is skipped for this preset only.
    //
    // Group order = keep-priority when the cap trims. The 9 tools dropped by
    // default to land at exactly 50 are declared in PRESET_DEFAULT_DISABLED:
    //   git_blame, git_stash, git_fetch, git_pull, git_show,
    //   process_kill, process_write,
    //   code_insert_before_symbol, code_insert_after_symbol
    // The whole browser group is intentionally kept (UI testing). To trim/keep
    // others, edit PRESET_DEFAULT_DISABLED or use `disabled`/`enabled` in config.
    'vibe-lite': ['file', 'search', 'code', 'terminal', 'build', 'git', 'process', 'browser'],
    // Read-only exploration.
    readonly: ['workspace', 'file', 'search', 'code'],
    // Everything (explicit opt-in to the full surface).
    full: [
        'workspace', 'file', 'search', 'terminal', 'process', 'git', 'build',
        'memory', 'security', 'code', 'browser', 'db', 'pkg', 'format', 'coverage',
    ],
};
/**
 * Hard tool-count ceilings for presets that must satisfy a client-side cap.
 * When a preset is listed here, resolveActiveTools trims its tool list down to
 * the limit after group selection, keeping tools in group-priority order.
 */
export const PRESET_TOOL_CAP = {
    'vibe-lite': 50,
};
/**
 * Per-preset default tool removals, applied on top of group selection (and
 * before any user-supplied `disabled` list). For `vibe-lite` we deliberately
 * drop the 9 least-useful-for-vibe-coding tools so the surface lands at exactly
 * 50 *and* the whole browser group survives (the automatic group-priority cap
 * would otherwise delete browser_* entirely). The cuts: rarely-used git
 * porcelain, two process controls, and two symbol-insert edits already covered
 * by file_patch / file_edit_block.
 */
export const PRESET_DEFAULT_DISABLED = {
    'vibe-lite': [
        'git_blame',
        'git_stash',
        'git_fetch',
        'git_pull',
        'git_show',
        'process_kill',
        'process_write',
        'code_insert_before_symbol',
        'code_insert_after_symbol',
    ],
};
/**
 * Presets that opt OUT of the "always keep the workspace group" rule. For these,
 * resolveActiveTools will not force-add the workspace group, and the cap logic
 * will not pin workspace tools. Use for fully folder-scoped setups where the
 * agent never needs workspace_activate/switch/route.
 */
export const PRESET_NO_FORCE_WORKSPACE = new Set(['vibe-lite']);
/**
 * Compute the set of tool names to advertise, given the full registry and a
 * filter spec. Returns null to mean "expose everything" (no filtering).
 *
 * Resolution order: enabledGroups (or preset's groups) -> add `enabled` extras
 * -> remove `disabled`. `workspace` is always kept so the agent can orient and
 * call workspace_route.
 */
export function resolveActiveTools(registry, opts) {
    const all = registry.listAll();
    const groups = opts.enabledGroups?.length
        ? opts.enabledGroups
        : opts.preset
            ? GROUP_PRESETS[opts.preset]
            : undefined;
    if (!groups && !opts.disabled?.length && !opts.enabled?.length) {
        return null; // nothing to filter -> expose all
    }
    const forceWorkspace = !(opts.preset && PRESET_NO_FORCE_WORKSPACE.has(opts.preset));
    const keepGroups = new Set([
        ...(groups ?? all.map((t) => t.group)),
        ...(forceWorkspace ? ['workspace'] : []),
    ]);
    const keep = new Set(all.filter((t) => keepGroups.has(t.group)).map((t) => t.name));
    for (const name of opts.enabled ?? [])
        keep.add(name);
    // Preset-level default removals first, then any explicit user `disabled` list.
    // Explicitly `enabled` tools are never auto-dropped by the preset defaults.
    const presetDisabled = opts.preset ? PRESET_DEFAULT_DISABLED[opts.preset] ?? [] : [];
    const enabledSet = new Set(opts.enabled ?? []);
    for (const name of presetDisabled)
        if (!enabledSet.has(name))
            keep.delete(name);
    for (const name of opts.disabled ?? [])
        keep.delete(name);
    // Apply a preset's hard tool-count cap, if any. Tools are kept in
    // group-priority order (the preset's group list defines the priority), so the
    // most useful groups survive when the surface is trimmed. Explicitly enabled
    // tools are always retained and never counted out.
    const cap = opts.preset ? PRESET_TOOL_CAP[opts.preset] : undefined;
    if (cap !== undefined && keep.size > cap) {
        const pinned = new Set([
            ...(forceWorkspace ? ['workspace'] : []),
            ...(opts.enabled ?? []),
        ]);
        const priority = groups ?? [];
        const groupRank = (g) => {
            const i = priority.indexOf(g);
            return i === -1 ? priority.length : i;
        };
        const ranked = all
            .filter((t) => keep.has(t.name))
            .sort((a, b) => groupRank(a.group) - groupRank(b.group));
        const capped = new Set();
        // Always keep pinned tools first, then fill up to the cap by priority.
        for (const t of ranked)
            if (pinned.has(t.name))
                capped.add(t.name);
        for (const t of ranked) {
            if (capped.size >= cap)
                break;
            capped.add(t.name);
        }
        return [...capped];
    }
    return [...keep];
}
