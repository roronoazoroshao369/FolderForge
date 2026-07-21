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
import { gameTools } from './game-tools.js';
import { agentTools } from './agent-tools.js';
import { pluginTools } from './plugin-tools.js';
import { workflowTools } from './workflow-tools.js';
import { artifactTools } from './artifact-tools.js';
import { distributedTools } from './distributed-tools.js';
import { marketplaceTools } from './marketplace-tools.js';
import { buildAdapterTools, buildAdapterToolsFor } from './adapter-tools.js';
import { logger } from '../core/logger.js';
import { capsuleTools } from './capsule-tools.js';
import { isolationTools } from './isolation-tools.js';
/**
 * Build the full tool registry with every group registered.
 */
export function buildRegistry(container) {
    const registry = new ToolRegistry(container);
    registry.registerAll([
        ...workspaceTools(),
        ...capsuleTools(),
        ...isolationTools(),
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
        ...agentTools(),
        ...pluginTools(),
        ...workflowTools(),
        ...artifactTools(),
        ...distributedTools(),
        ...marketplaceTools(),
        ...gameTools(),
    ]);
    // Expose the registry on the container so routing tools (workspace_route)
    // can switch the active tool subset at runtime.
    container.registry = registry;
    return registry;
}
const catalogRefreshRegistries = new WeakSet();
function subscribeToAdapterCatalogChanges(container, registry, activateNewTools) {
    if (catalogRefreshRegistries.has(registry))
        return;
    catalogRefreshRegistries.add(registry);
    const refreshes = new Map();
    container.adapters.onCatalogChanged((name) => {
        if (container.adapters.isFacade(name))
            return;
        const previous = refreshes.get(name) ?? Promise.resolve();
        const refresh = previous
            .catch(() => undefined)
            .then(async () => {
            if (!container.adapters.isEnabled(name))
                return;
            const replacements = await buildAdapterToolsFor(container, [name], { strict: true });
            const removed = registry.replaceWhere((tool) => tool.group === `adapter:${name}`, replacements, activateNewTools ? true : undefined);
            logger.info({ adapter: name, removed: removed.length, registered: replacements.length }, 'Refreshed direct child MCP tool wrappers');
        })
            .catch((error) => {
            logger.warn({ adapter: name, err: error instanceof Error ? error.message : String(error) }, 'Retaining previous direct child MCP wrappers after catalog refresh failure');
        })
            .finally(() => {
            if (refreshes.get(name) === refresh)
                refreshes.delete(name);
        });
        refreshes.set(name, refresh);
    });
}
/**
 * Discover and register tools exposed by enabled child MCP adapters (Serena,
 * Playwright, ...). Each child tool is namespaced (e.g. `serena__find_symbol`)
 * and routed through the normal policy + audit pipeline. Safe to call once after
 * {@link buildRegistry}; a no-op when no adapters are enabled.
 */
export async function registerAdapterTools(container, registry, activate = false) {
    subscribeToAdapterCatalogChanges(container, registry, activate);
    const adapterTools = await buildAdapterTools(container);
    registry.registerAll(adapterTools);
    if (activate)
        registry.activate(adapterTools.map((tool) => tool.name));
    const playwright = container.adapters.status().find((adapter) => adapter.name === 'playwright');
    if (!playwright?.enabled || !playwright.ready) {
        const removed = registry.unregisterWhere((tool) => tool.group === 'browser');
        if (removed.length > 0) {
            // Browser wrappers are capability claims. Do not advertise them when the
            // configured Playwright child is unavailable; diagnostics remain visible
            // through workspace_status/workspace_health and doctor.
        }
    }
    return adapterTools.length;
}
export { TASK_PRESETS } from './task-presets.js';
/**
 * Group-based presets used to keep the advertised tool surface small enough for
 * clients that cap the tool list (e.g. ~50 tools). Unlike TASK_PRESETS (which
 * pick individual tools for runtime routing), these select whole groups and are
 * applied once at startup so the very first `tools/list` is already trimmed.
 */
export const GROUP_PRESETS = {
    // Focused set for AI "vibe coding": read/edit, search, run, git, code intel.
    // Leaves out db, browser, coverage, security, memory to stay well under 50.
    vibe: ['workspace', 'workflow', 'agent', 'file', 'search', 'terminal', 'process', 'git', 'code', 'build'],
    // Same groups as `vibe`, but hard-capped to fit clients that reject more than
    // 50 tools. The cap is applied by PRESET_TOOL_CAP below; group order here also
    // sets keep-priority so the most useful groups survive the trim.
    // Pure folder-scoped coding set + UI testing via the browser group. The full
    // workspace group is not forced, but workspace_status and workspace_activate
    // remain pinned as minimal diagnosis/recovery controls. Docker is covered by
    // shell_exec, so no dedicated docker group is needed.
    //
    // Group order = keep-priority when the cap trims. Lower-level and infrequent tools dropped by
    // default to land at exactly 50 are declared in PRESET_DEFAULT_DISABLED:
    //   six rarely-used git tools; process_kill/process_write; run_coverage;
    //   file_patch/search_ast/project_detect_commands/parse_errors/run_build; and
    //   two symbol-insert edits. The five agent tools replace or compose these
    // lower-level capabilities for the common vibe-coding loop. Both the complete
    // agent and browser groups are pinned under cap pressure.
    'vibe-lite': ['workflow', 'agent', 'file', 'search', 'code', 'terminal', 'build', 'git', 'process', 'browser'],
    // Read-only exploration.
    readonly: ['workspace', 'workflow', 'agent', 'file', 'search', 'code'],
    // Everything (explicit opt-in to the full surface).
    full: [
        'workspace', 'workflow', 'agent', 'file', 'search', 'terminal', 'process', 'git', 'build',
        'memory', 'security', 'code', 'browser', 'db', 'pkg', 'format', 'coverage', 'plugin',
        'artifact', 'distributed', 'marketplace', 'game',
    ],
    // Godot game-dev focus: the coding essentials plus the `game` group, so an
    // agent can read/edit project files and drive the engine without the db /
    // coverage / pkg noise. Runtime tiers (later steps) join the same group.
    godot: [
        'workspace', 'workflow', 'agent', 'file', 'search', 'code', 'terminal', 'build', 'git',
        'process', 'browser', 'game',
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
 * Groups that must survive a preset cap intact. `vibe-lite` promises end-to-end
 * UI testing, so future additions in earlier groups must never silently evict a
 * browser wrapper from the advertised surface.
 */
export const PRESET_PINNED_GROUPS = {
    'vibe-lite': ['workflow', 'agent', 'browser', 'process'],
};
/**
 * Per-preset default tool removals, applied on top of group selection (and
 * before any user-supplied `disabled` list). For `vibe-lite` we deliberately
 * drop lower-level or infrequent tools so the surface lands at exactly 50.
 * The complete workflow, agent, and browser groups remain pinned; agent tools compose
 * the common analyze/context/patch/verify/summary workflow.
 */
export const PRESET_DEFAULT_DISABLED = {
    'vibe-lite': [
        'git_log',
        'git_blame',
        'git_stash',
        'git_fetch',
        'git_pull',
        'git_show',
        'process_kill',
        'process_write',
        'run_coverage',
        'file_patch',
        'search_ast',
        'project_detect_commands',
        'parse_errors',
        'run_build',
        'file_write',
        'search_files',
        'git_status',
        'run_test',
        'run_lint',
        'run_typecheck',
        'pkg_run',
        'git_reset',
        'git_branch',
        'git_checkout',
        'code_insert_before_symbol',
        'code_insert_after_symbol',
        'code_find_implementations',
        'code_rename_symbol',
    ],
};
/**
 * Presets that opt OUT of forcing the complete workspace group. A preset may
 * still retain a bounded recovery subset through PRESET_RECOVERY_TOOLS.
 */
export const PRESET_NO_FORCE_WORKSPACE = new Set(['vibe-lite']);
/** Minimal workspace controls kept even in folder-scoped presets for diagnosis and recovery. */
export const PRESET_RECOVERY_TOOLS = {
    'vibe-lite': ['workspace_status', 'workspace_activate'],
};
/**
 * Compute the set of tool names to advertise, given the full registry and a
 * filter spec. Returns null to mean "expose everything" (no filtering).
 *
 * Resolution order: enabledGroups (or preset's groups) -> add recovery/`enabled`
 * extras -> remove `disabled`. Most presets keep the complete workspace group;
 * bounded presets may retain only explicit recovery controls.
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
    const recoveryTools = opts.preset ? PRESET_RECOVERY_TOOLS[opts.preset] ?? [] : [];
    for (const name of recoveryTools)
        keep.add(name);
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
        const pinnedGroups = new Set(opts.preset ? PRESET_PINNED_GROUPS[opts.preset] ?? [] : []);
        const pinned = new Set([
            ...(forceWorkspace ? ['workspace'] : []),
            ...recoveryTools,
            ...all.filter((t) => pinnedGroups.has(t.group)).map((t) => t.name),
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
