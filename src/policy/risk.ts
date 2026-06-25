import type { RiskLevel } from '../core/types.js';

export const RISK_ORDER: Record<RiskLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/**
 * Default risk classification per tool name (section 8 of the spec).
 */
export const TOOL_RISK: Record<string, RiskLevel> = {
  // LOW
  file_read: 'LOW',
  file_read_many: 'LOW',
  search_files: 'LOW',
  search_text: 'LOW',
  search_ast: 'LOW',
  git_status: 'LOW',
  git_diff: 'LOW',
  git_log: 'LOW',
  git_show: 'LOW',
  git_blame: 'LOW',
  git_branch: 'LOW',
  run_test: 'LOW',
  run_lint: 'LOW',
  run_typecheck: 'LOW',
  run_coverage: 'LOW',
  pkg_list: 'LOW',
  pkg_outdated: 'LOW',
  pkg_audit: 'LOW',
  format_check: 'LOW',
  project_detect_commands: 'LOW',
  workspace_status: 'LOW',
  workspace_list: 'LOW',
  workspace_health: 'LOW',
  workspace_route: 'LOW',
  policy_get: 'LOW',
  policy_explain: 'LOW',
  policy_ratelimits: 'LOW',
  audit_recent: 'LOW',
  memory_list: 'LOW',
  memory_read: 'LOW',
  code_symbols_overview: 'LOW',
  code_find_symbol: 'LOW',
  code_find_references: 'LOW',
  code_find_definition: 'LOW',
  code_find_implementations: 'LOW',
  code_diagnostics: 'LOW',
  browser_snapshot: 'LOW',
  browser_console: 'LOW',
  browser_network: 'LOW',
  db_list_connections: 'LOW',
  db_list_tables: 'LOW',
  db_describe_table: 'LOW',
  db_query_readonly: 'LOW',
  db_explain: 'LOW',
  secret_scan: 'LOW',
  approval_status: 'LOW',

  // MEDIUM
  file_write: 'MEDIUM',
  file_patch: 'MEDIUM',
  file_edit_block: 'MEDIUM',
  workspace_activate: 'MEDIUM',
  workspace_switch: 'MEDIUM',
  workspace_deactivate: 'MEDIUM',
  workspace_onboard: 'MEDIUM',
  git_add: 'MEDIUM',
  git_checkout: 'MEDIUM',
  run_build: 'MEDIUM',
  pkg_run: 'MEDIUM',
  format_apply: 'MEDIUM',
  process_start: 'MEDIUM',
  process_read: 'LOW',
  process_tail: 'LOW',
  process_write: 'MEDIUM',
  process_stop: 'MEDIUM',
  process_list: 'LOW',
  memory_write: 'MEDIUM',
  memory_update: 'MEDIUM',
  code_replace_symbol_body: 'MEDIUM',
  code_insert_before_symbol: 'MEDIUM',
  code_insert_after_symbol: 'MEDIUM',
  code_rename_symbol: 'MEDIUM',
  browser_open: 'MEDIUM',
  browser_click: 'MEDIUM',
  browser_type: 'MEDIUM',
  browser_screenshot: 'MEDIUM',
  browser_close: 'MEDIUM',
  policy_set_mode: 'MEDIUM',
  db_connect: 'MEDIUM',
  shell_exec: 'MEDIUM', // re-classified per command at runtime

  // HIGH
  file_delete: 'HIGH',
  git_commit: 'HIGH',
  process_kill: 'HIGH',
  db_run_migration: 'HIGH',
  db_write: 'HIGH',
  pkg_add: 'HIGH',
  pkg_remove: 'HIGH',

  // CRITICAL
  git_push: 'CRITICAL',
  git_reset: 'CRITICAL',
  browser_eval: 'HIGH',
};
