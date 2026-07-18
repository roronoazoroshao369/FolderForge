/**
 * Per-adapter sub-tool risk map for facade adapters (see docs/mcp-facade.md,
 * Step 3). When a large child MCP server is exposed through the two-tool facade
 * (`<adapter>__list_tools` + `<adapter>__call_tool`), each underlying sub-op is
 * still risk-classified and approval-gated individually. The dispatcher never
 * gets to lie about risk: the value is resolved here from the sub-tool's own
 * name, not from the caller's arguments.
 *
 * Resolution: a per-adapter override table wins; otherwise the conservative
 * fallback `MEDIUM` / `mutates: true` applies, so an unmapped child tool is
 * always treated as a mutating, policy-gated action rather than silently LOW.
 */

import type { RiskLevel } from '../../core/types.js';

export interface SubOpRisk {
  risk: RiskLevel;
  /** Whether the sub-op mutates state (drives readonly mode + destructiveHint). */
  mutates: boolean;
}

/**
 * Conservative fallback for any child tool not present in an adapter's override
 * table: treat it as a mutating MEDIUM action so policy mode + approval still
 * gate it. Matches the flat-namespacing default in adapter-tools.ts.
 */
export const DEFAULT_SUBOP_RISK: SubOpRisk = { risk: 'MEDIUM', mutates: true };

/**
 * Per-adapter risk overrides, keyed by adapter name then sub-tool name.
 *
 * Godot's 149-tool bands (docs/godot-mcp.md) are the authoritative source when a
 * Godot child MCP server is fronted by the facade; the table is intentionally
 * data-driven so those bands can be dropped in without touching the dispatcher.
 * Empty adapters simply fall back to DEFAULT_SUBOP_RISK for every sub-op.
 */
export const ADAPTER_RISK_MAPS: Record<string, Record<string, SubOpRisk>> = {
  // Test/example adapter overrides cover LOW/read-only, HIGH/approval, and
  // CRITICAL/deny paths through the facade regression suite. Real adapters (for
  // example a Godot child) register or ship their own complete risk bands.
  serena: {
    inspect_state: { risk: 'LOW', mutates: false },
    sensitive_write: { risk: 'HIGH', mutates: true },
    danger_eval: { risk: 'CRITICAL', mutates: true },
  },
};

/**
 * Resolve the risk + mutation classification for one facade sub-op. Never
 * throws; unknown adapter/tool combinations return {@link DEFAULT_SUBOP_RISK}.
 */
export function resolveSubOpRisk(adapter: string, tool: string): SubOpRisk {
  const runtime = RUNTIME_RISK_MAPS.get(adapter);
  return runtime?.tools[tool] ?? ADAPTER_RISK_MAPS[adapter]?.[tool] ?? runtime?.fallback ?? DEFAULT_SUBOP_RISK;
}

/** Runtime plugin risk maps registered from validated plugin manifests. */
const RUNTIME_RISK_MAPS = new Map<string, { fallback: SubOpRisk; tools: Record<string, SubOpRisk> }>();

export function registerAdapterRiskMap(
  adapter: string,
  fallback: SubOpRisk,
  tools: Record<string, SubOpRisk>
): void {
  RUNTIME_RISK_MAPS.set(adapter, { fallback: { ...fallback }, tools: { ...tools } });
}

export function unregisterAdapterRiskMap(adapter: string): void {
  RUNTIME_RISK_MAPS.delete(adapter);
}
