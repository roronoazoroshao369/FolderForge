/**
 * FolderForge tool-schema lock (1.0 freeze).
 *
 * This file is the SOURCE OF TRUTH for the public native tool surface at 1.0. Tool
 * names and their `mutates` / `risk` contract are frozen here. Any change that
 * renames a tool, removes one, or alters its mutation/risk classification is a
 * BREAKING change: it must be a major-version bump and an intentional edit to
 * this file.
 *
 * NOTE: some tools (e.g. `parse_errors`) are internal helpers but still live in
 * the native registry. They are frozen here because the schema-lock guard is
 * intentionally strict: CI should catch any accidental changes to the live tool
 * catalog.
 *
 * Adding a brand-new tool is backwards-compatible: register it, then add an
 * entry here. The guard test (`tests/unit/schema-lock.test.ts`) fails if the
 * live registry and this lock ever diverge, so accidental renames/removals are
 * caught in CI.
 *
 * DO NOT edit casually. Treat edits to this file as API changes.
 */

import type { RiskLevel } from '../core/types.js';

export interface FrozenTool {
  /** Stable public tool name. Renaming is a breaking change. */
  name: string;
  /** Whether the tool mutates workspace/system state. */
  mutates: boolean;
  /** Frozen default risk classification (shell_exec is re-classified per call). */
  risk: RiskLevel;
}

/**
 * The frozen 1.0 native tool catalog. Child-MCP adapter tools (namespaced,
 * e.g. `serena__find_symbol`) are intentionally NOT part of the frozen surface
 * because they are discovered dynamically from external servers.
 */
export const FROZEN_TOOLS: readonly FrozenTool[] = [
  // --- workspace ---
  { name: 'workspace_status', mutates: false, risk: 'LOW' },
  { name: 'workspace_list', mutates: false, risk: 'LOW' },
  { name: 'workspace_health', mutates: false, risk: 'LOW' },
  { name: 'workspace_route', mutates: false, risk: 'LOW' },
  { name: 'workspace_activate', mutates: true, risk: 'MEDIUM' },
  { name: 'workspace_switch', mutates: true, risk: 'MEDIUM' },
  { name: 'workspace_deactivate', mutates: true, risk: 'MEDIUM' },
  { name: 'workspace_onboard', mutates: true, risk: 'MEDIUM' },
  { name: 'project_detect_commands', mutates: false, risk: 'LOW' },

  // --- files ---
  { name: 'file_read', mutates: false, risk: 'LOW' },
  { name: 'file_read_many', mutates: false, risk: 'LOW' },
  { name: 'file_write', mutates: true, risk: 'MEDIUM' },
  { name: 'file_patch', mutates: true, risk: 'MEDIUM' },
  { name: 'file_edit_block', mutates: true, risk: 'MEDIUM' },
  { name: 'file_move', mutates: true, risk: 'MEDIUM' },
  { name: 'file_copy', mutates: true, risk: 'MEDIUM' },
  { name: 'list_directory', mutates: false, risk: 'LOW' },
  { name: 'file_delete', mutates: true, risk: 'HIGH' },

  // --- search ---
  { name: 'search_files', mutates: false, risk: 'LOW' },
  { name: 'search_text', mutates: false, risk: 'LOW' },
  { name: 'search_ast', mutates: false, risk: 'LOW' },

  // --- terminal ---
  { name: 'shell_exec', mutates: true, risk: 'MEDIUM' },

  // --- processes ---
  { name: 'process_start', mutates: true, risk: 'MEDIUM' },
  { name: 'process_read', mutates: false, risk: 'LOW' },
  { name: 'process_tail', mutates: false, risk: 'LOW' },
  { name: 'process_write', mutates: true, risk: 'MEDIUM' },
  { name: 'process_stop', mutates: true, risk: 'MEDIUM' },
  { name: 'process_list', mutates: false, risk: 'LOW' },
  { name: 'process_kill', mutates: true, risk: 'HIGH' },

  // --- git ---
  { name: 'git_status', mutates: false, risk: 'LOW' },
  { name: 'git_diff', mutates: false, risk: 'LOW' },
  { name: 'git_log', mutates: false, risk: 'LOW' },
  { name: 'git_show', mutates: false, risk: 'LOW' },
  { name: 'git_blame', mutates: false, risk: 'LOW' },
  { name: 'git_branch', mutates: false, risk: 'LOW' },
  { name: 'git_fetch', mutates: true, risk: 'MEDIUM' },
  { name: 'git_pull', mutates: true, risk: 'HIGH' },
  { name: 'git_stash', mutates: true, risk: 'MEDIUM' },
  { name: 'git_add', mutates: true, risk: 'MEDIUM' },
  { name: 'git_checkout', mutates: true, risk: 'MEDIUM' },
  { name: 'git_commit', mutates: true, risk: 'HIGH' },
  { name: 'git_push', mutates: true, risk: 'CRITICAL' },
  { name: 'git_reset', mutates: true, risk: 'CRITICAL' },

  // --- build / quality ---
  { name: 'run_test', mutates: false, risk: 'LOW' },
  { name: 'run_lint', mutates: false, risk: 'LOW' },
  { name: 'run_typecheck', mutates: false, risk: 'LOW' },
  { name: 'run_build', mutates: true, risk: 'MEDIUM' },
  { name: 'run_coverage', mutates: false, risk: 'LOW' },
  // NOTE: parse_errors is an internal helper tool used by build/quality tooling.
  // It is part of the native registry and therefore frozen for 1.0.
  { name: 'parse_errors', mutates: false, risk: 'MEDIUM' },

  // --- packages (Gap 2) ---
  { name: 'pkg_list', mutates: false, risk: 'LOW' },
  { name: 'pkg_outdated', mutates: false, risk: 'LOW' },
  { name: 'pkg_audit', mutates: false, risk: 'LOW' },
  { name: 'pkg_run', mutates: true, risk: 'MEDIUM' },
  { name: 'pkg_add', mutates: true, risk: 'HIGH' },
  { name: 'pkg_remove', mutates: true, risk: 'HIGH' },

  // --- formatting (Gap 3) ---
  { name: 'format_check', mutates: false, risk: 'LOW' },
  { name: 'format_apply', mutates: true, risk: 'MEDIUM' },

  // --- memory ---
  { name: 'memory_list', mutates: false, risk: 'LOW' },
  { name: 'memory_read', mutates: false, risk: 'LOW' },
  { name: 'memory_write', mutates: true, risk: 'MEDIUM' },
  { name: 'memory_update', mutates: true, risk: 'MEDIUM' },

  // --- code intelligence ---
  { name: 'code_symbols_overview', mutates: false, risk: 'LOW' },
  { name: 'code_find_symbol', mutates: false, risk: 'LOW' },
  { name: 'code_find_references', mutates: false, risk: 'LOW' },
  { name: 'code_find_definition', mutates: false, risk: 'LOW' },
  { name: 'code_find_implementations', mutates: false, risk: 'LOW' },
  { name: 'code_diagnostics', mutates: false, risk: 'LOW' },
  { name: 'code_replace_symbol_body', mutates: true, risk: 'MEDIUM' },
  { name: 'code_insert_before_symbol', mutates: true, risk: 'MEDIUM' },
  { name: 'code_insert_after_symbol', mutates: true, risk: 'MEDIUM' },
  { name: 'code_rename_symbol', mutates: true, risk: 'MEDIUM' },

  // --- browser ---
  { name: 'browser_snapshot', mutates: false, risk: 'LOW' },
  { name: 'browser_console', mutates: false, risk: 'LOW' },
  { name: 'browser_network', mutates: false, risk: 'LOW' },
  { name: 'browser_open', mutates: true, risk: 'MEDIUM' },
  { name: 'browser_click', mutates: true, risk: 'MEDIUM' },
  { name: 'browser_type', mutates: true, risk: 'MEDIUM' },
  { name: 'browser_screenshot', mutates: true, risk: 'MEDIUM' },
  { name: 'browser_close', mutates: true, risk: 'MEDIUM' },
  { name: 'browser_eval', mutates: true, risk: 'HIGH' },

  // --- database ---
  { name: 'db_list_connections', mutates: false, risk: 'LOW' },
  { name: 'db_list_tables', mutates: false, risk: 'LOW' },
  { name: 'db_describe_table', mutates: false, risk: 'LOW' },
  { name: 'db_query_readonly', mutates: false, risk: 'LOW' },
  { name: 'db_explain', mutates: false, risk: 'LOW' },
  { name: 'db_connect', mutates: true, risk: 'MEDIUM' },
  { name: 'db_run_migration', mutates: true, risk: 'HIGH' },
  { name: 'db_write', mutates: true, risk: 'HIGH' },

  // --- security ---
  { name: 'secret_scan', mutates: false, risk: 'LOW' },

  // --- policy / audit / approvals ---
  { name: 'policy_get', mutates: false, risk: 'LOW' },
  { name: 'policy_explain', mutates: false, risk: 'LOW' },
  { name: 'policy_ratelimits', mutates: false, risk: 'LOW' },
  { name: 'policy_set_mode', mutates: true, risk: 'MEDIUM' },
  { name: 'audit_recent', mutates: false, risk: 'LOW' },
  // NOTE: audit_export and approval_request are not in TOOL_RISK, so they fall
  // back to the defineTool default of MEDIUM. They are frozen here at their
  // ACTUAL runtime risk to keep the lock truthful. Reclassifying them to LOW is
  // a deliberate, separate change (see docs/roadmap.md post-1.0 notes).
  { name: 'audit_export', mutates: false, risk: 'MEDIUM' },
  { name: 'approval_status', mutates: false, risk: 'LOW' },
  { name: 'approval_approve', mutates: true, risk: 'LOW' },
  { name: 'approval_deny', mutates: true, risk: 'LOW' },
  { name: 'approval_request', mutates: false, risk: 'MEDIUM' },

  // --- game (Godot) - read tier (Step 1) ---
  { name: 'game_get_godot_version', mutates: false, risk: 'LOW' },
  { name: 'game_get_project_info', mutates: false, risk: 'LOW' },
  { name: 'game_read_scene', mutates: false, risk: 'LOW' },
  { name: 'game_read_project_settings', mutates: false, risk: 'LOW' },
  { name: 'game_list_project_files', mutates: false, risk: 'LOW' },
  { name: 'game_read_file', mutates: false, risk: 'LOW' },

  // --- game (Godot) - edit tier (Step 2) ---
  { name: 'game_write_file', mutates: true, risk: 'HIGH' },
  { name: 'game_delete_file', mutates: true, risk: 'CRITICAL' },
  { name: 'game_create_directory', mutates: true, risk: 'MEDIUM' },
  { name: 'game_rename_file', mutates: true, risk: 'HIGH' },
  { name: 'game_create_scene', mutates: true, risk: 'HIGH' },
  { name: 'game_add_node', mutates: true, risk: 'HIGH' },
  { name: 'game_remove_node', mutates: true, risk: 'HIGH' },
  { name: 'game_modify_node', mutates: true, risk: 'HIGH' },
  { name: 'game_attach_script', mutates: true, risk: 'HIGH' },
  { name: 'game_create_script', mutates: true, risk: 'CRITICAL' },
  { name: 'game_create_resource', mutates: true, risk: 'HIGH' },
  { name: 'game_modify_project_settings', mutates: true, risk: 'HIGH' },

  // --- game (Godot) - runtime read tier (Step 3) ---
  { name: 'game_runtime_status', mutates: false, risk: 'LOW' },
  { name: 'game_get_scene_tree', mutates: false, risk: 'LOW' },
  { name: 'game_get_node_info', mutates: false, risk: 'LOW' },
  { name: 'game_get_ui', mutates: false, risk: 'LOW' },
  { name: 'game_get_performance', mutates: false, risk: 'LOW' },
  { name: 'game_get_nodes_in_group', mutates: false, risk: 'LOW' },
  { name: 'game_find_nodes_by_class', mutates: false, risk: 'LOW' },
  { name: 'game_get_errors', mutates: false, risk: 'LOW' },
  { name: 'game_get_logs', mutates: false, risk: 'LOW' },
  { name: 'game_pause', mutates: true, risk: 'MEDIUM' },
  { name: 'game_wait', mutates: true, risk: 'MEDIUM' },
  { name: 'game_eval', mutates: true, risk: 'CRITICAL' },

  // --- game (Godot) - runtime mutation + input tier (Step 4) ---
  // Family 8: runtime node manipulation
  { name: 'game_get_property', mutates: false, risk: 'LOW' },
  { name: 'game_set_property', mutates: true, risk: 'HIGH' },
  { name: 'game_call_method', mutates: true, risk: 'CRITICAL' },
  { name: 'game_instantiate_scene', mutates: true, risk: 'HIGH' },
  { name: 'game_runtime_remove_node', mutates: true, risk: 'HIGH' },
  { name: 'game_change_scene', mutates: true, risk: 'HIGH' },
  { name: 'game_reparent_node', mutates: true, risk: 'HIGH' },
  // Family 9: runtime signals
  { name: 'game_connect_signal', mutates: true, risk: 'HIGH' },
  { name: 'game_disconnect_signal', mutates: true, risk: 'HIGH' },
  { name: 'game_emit_signal', mutates: true, risk: 'HIGH' },
  { name: 'game_list_signals', mutates: false, risk: 'LOW' },
  { name: 'game_await_signal', mutates: false, risk: 'LOW' },
  // Family 5 + 14: runtime input injection
  { name: 'game_screenshot', mutates: false, risk: 'LOW' },
  { name: 'game_input_state', mutates: false, risk: 'LOW' },
  { name: 'game_click', mutates: true, risk: 'MEDIUM' },
  { name: 'game_key_press', mutates: true, risk: 'MEDIUM' },
  { name: 'game_mouse_move', mutates: true, risk: 'MEDIUM' },
  { name: 'game_key_hold', mutates: true, risk: 'MEDIUM' },
  { name: 'game_key_release', mutates: true, risk: 'MEDIUM' },
  { name: 'game_scroll', mutates: true, risk: 'MEDIUM' },
  { name: 'game_mouse_drag', mutates: true, risk: 'MEDIUM' },
  { name: 'game_gamepad', mutates: true, risk: 'MEDIUM' },
  { name: 'game_touch', mutates: true, risk: 'MEDIUM' },
  { name: 'game_input_action', mutates: true, risk: 'MEDIUM' },
  // Family 10 + 22: runtime animation
  { name: 'game_play_animation', mutates: true, risk: 'MEDIUM' },
  { name: 'game_tween_property', mutates: true, risk: 'MEDIUM' },
  { name: 'game_animation_tree', mutates: true, risk: 'MEDIUM' },
  { name: 'game_animation_control', mutates: true, risk: 'MEDIUM' },
  { name: 'game_skeleton_ik', mutates: true, risk: 'MEDIUM' },
  // Family 23: advanced audio
  { name: 'game_audio_effect', mutates: true, risk: 'MEDIUM' },
  { name: 'game_audio_bus_layout', mutates: true, risk: 'MEDIUM' },
  { name: 'game_audio_spatial', mutates: true, risk: 'MEDIUM' },
  // Family 19: system & window
  { name: 'game_os_info', mutates: false, risk: 'LOW' },
  { name: 'game_time_scale', mutates: true, risk: 'MEDIUM' },
  { name: 'game_window', mutates: true, risk: 'HIGH' },
  { name: 'game_process_mode', mutates: true, risk: 'HIGH' },
  { name: 'game_world_settings', mutates: true, risk: 'HIGH' },
  { name: 'game_script', mutates: true, risk: 'CRITICAL' },
  // Family 25: UI controls
  { name: 'game_ui_control', mutates: true, risk: 'MEDIUM' },
  { name: 'game_ui_text', mutates: true, risk: 'MEDIUM' },
  { name: 'game_ui_popup', mutates: true, risk: 'MEDIUM' },
  { name: 'game_ui_tree', mutates: true, risk: 'MEDIUM' },
  { name: 'game_ui_item_list', mutates: true, risk: 'MEDIUM' },
  { name: 'game_ui_tabs', mutates: true, risk: 'MEDIUM' },
  { name: 'game_ui_menu', mutates: true, risk: 'MEDIUM' },
  { name: 'game_ui_range', mutates: true, risk: 'MEDIUM' },
  // Family 16: advanced runtime (Step 5a)
  { name: 'game_get_camera', mutates: false, risk: 'LOW' },
  { name: 'game_raycast', mutates: false, risk: 'LOW' },
  { name: 'game_get_audio', mutates: false, risk: 'LOW' },
  { name: 'game_navigate_path', mutates: false, risk: 'LOW' },
  { name: 'game_serialize_state', mutates: false, risk: 'LOW' },
  { name: 'game_audio_play', mutates: true, risk: 'MEDIUM' },
  { name: 'game_audio_bus', mutates: true, risk: 'MEDIUM' },
  { name: 'game_create_timer', mutates: true, risk: 'MEDIUM' },
  { name: 'game_debug_draw', mutates: true, risk: 'MEDIUM' },
  { name: 'game_set_camera', mutates: true, risk: 'HIGH' },
  { name: 'game_spawn_node', mutates: true, risk: 'HIGH' },
  { name: 'game_set_shader_param', mutates: true, risk: 'HIGH' },
  { name: 'game_tilemap', mutates: true, risk: 'HIGH' },
  { name: 'game_add_collision', mutates: true, risk: 'HIGH' },
  { name: 'game_environment', mutates: true, risk: 'HIGH' },
  { name: 'game_manage_group', mutates: true, risk: 'HIGH' },
  { name: 'game_set_particles', mutates: true, risk: 'HIGH' },
  { name: 'game_create_animation', mutates: true, risk: 'HIGH' },
  { name: 'game_physics_body', mutates: true, risk: 'HIGH' },
  { name: 'game_create_joint', mutates: true, risk: 'HIGH' },
  { name: 'game_bone_pose', mutates: true, risk: 'HIGH' },
  { name: 'game_ui_theme', mutates: true, risk: 'HIGH' },
  { name: 'game_viewport', mutates: true, risk: 'HIGH' },
  // Family 18: networking (Step 5b)
  { name: 'game_http_request', mutates: true, risk: 'CRITICAL' },
  { name: 'game_websocket', mutates: true, risk: 'CRITICAL' },
  { name: 'game_multiplayer', mutates: true, risk: 'CRITICAL' },
  { name: 'game_rpc', mutates: true, risk: 'CRITICAL' },
  // Family 20: 3D rendering & geometry (Step 5b)
  { name: 'game_csg', mutates: true, risk: 'HIGH' },
  { name: 'game_multimesh', mutates: true, risk: 'HIGH' },
  { name: 'game_procedural_mesh', mutates: true, risk: 'HIGH' },
  { name: 'game_light_3d', mutates: true, risk: 'HIGH' },
  { name: 'game_mesh_instance', mutates: true, risk: 'HIGH' },
  { name: 'game_gridmap', mutates: true, risk: 'HIGH' },
  { name: 'game_3d_effects', mutates: true, risk: 'HIGH' },
  { name: 'game_gi', mutates: true, risk: 'HIGH' },
  { name: 'game_path_3d', mutates: true, risk: 'HIGH' },
  { name: 'game_sky', mutates: true, risk: 'HIGH' },
  { name: 'game_camera_attributes', mutates: true, risk: 'HIGH' },
  { name: 'game_navigation_3d', mutates: true, risk: 'HIGH' },
  { name: 'game_physics_3d', mutates: true, risk: 'HIGH' },
  // Family 21: 2D systems (Step 5b)
  { name: 'game_canvas', mutates: true, risk: 'HIGH' },
  { name: 'game_canvas_draw', mutates: true, risk: 'HIGH' },
  { name: 'game_light_2d', mutates: true, risk: 'HIGH' },
  { name: 'game_parallax', mutates: true, risk: 'HIGH' },
  { name: 'game_shape_2d', mutates: true, risk: 'HIGH' },
  { name: 'game_path_2d', mutates: true, risk: 'HIGH' },
  { name: 'game_physics_2d', mutates: true, risk: 'HIGH' },
  // Family 26: rendering & resources (Step 5b)
  { name: 'game_render_settings', mutates: true, risk: 'HIGH' },
  { name: 'game_resource', mutates: true, risk: 'HIGH' },


  { name: 'game_set_main_scene', mutates: true, risk: 'HIGH' },
] as const;

/** Set of frozen tool names for O(1) membership checks. */
export const FROZEN_TOOL_NAMES: ReadonlySet<string> = new Set(
  FROZEN_TOOLS.map((t) => t.name)
);

/** Lookup the frozen contract for a tool name. */
export function frozenTool(name: string): FrozenTool | undefined {
  return FROZEN_TOOLS.find((t) => t.name === name);
}
