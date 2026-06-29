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
  git_fetch: 'MEDIUM',
  git_stash: 'MEDIUM',
  list_directory: 'LOW',
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
  approval_approve: 'LOW',
  approval_deny: 'LOW',

  // game (Godot) - read tier (Step 1). All file/engine introspection only.
  game_get_godot_version: 'LOW',
  game_get_project_info: 'LOW',
  game_read_scene: 'LOW',
  game_read_project_settings: 'LOW',
  game_list_project_files: 'LOW',
  game_read_file: 'LOW',

  // game (Godot) - edit tier (Step 2). Text-based mutations of project files.
  // HIGH for structural edits; CRITICAL for delete (data loss) and script
  // creation (introduces executable code). All gated by the approval queue.
  game_write_file: 'HIGH',
  game_create_directory: 'MEDIUM',
  game_rename_file: 'HIGH',
  game_create_scene: 'HIGH',
  game_add_node: 'HIGH',
  game_remove_node: 'HIGH',
  game_modify_node: 'HIGH',
  game_attach_script: 'HIGH',
  game_create_resource: 'HIGH',
  game_modify_project_settings: 'HIGH',
  game_set_main_scene: 'HIGH',
  game_delete_file: 'CRITICAL',
  game_create_script: 'CRITICAL',

  // game (Godot) - runtime read tier (Step 3). RUN channel over the TCP bridge.
  // Read-only introspection of the live game is LOW; pause/wait transiently
  // perturb the running process (MEDIUM); eval runs arbitrary GDScript in the
  // live process (CRITICAL, approval-gated).
  game_runtime_status: 'LOW',
  game_get_scene_tree: 'LOW',
  game_get_node_info: 'LOW',
  game_get_ui: 'LOW',
  game_get_performance: 'LOW',
  game_get_nodes_in_group: 'LOW',
  game_find_nodes_by_class: 'LOW',
  game_get_errors: 'LOW',
  game_get_logs: 'LOW',
  game_pause: 'MEDIUM',
  game_wait: 'MEDIUM',
  game_eval: 'CRITICAL',

  // game (Godot) - runtime mutation + input tier (Step 4). RUN channel.
  // Family 8 (node manipulation) + Family 9 (signals). Reads are LOW; live
  // state mutations are HIGH; arbitrary live invocation (call_method) is
  // CRITICAL (approval-gated).
  game_get_property: 'LOW',
  game_list_signals: 'LOW',
  game_await_signal: 'LOW',
  game_set_property: 'HIGH',
  game_instantiate_scene: 'HIGH',
  game_runtime_remove_node: 'HIGH',
  game_change_scene: 'HIGH',
  game_reparent_node: 'HIGH',
  game_connect_signal: 'HIGH',
  game_disconnect_signal: 'HIGH',
  game_emit_signal: 'HIGH',
  game_call_method: 'CRITICAL',

  // MEDIUM
  file_write: 'MEDIUM',
  file_patch: 'MEDIUM',
  file_edit_block: 'MEDIUM',
  file_move: 'MEDIUM',
  file_copy: 'MEDIUM',
  git_pull: 'HIGH',
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
