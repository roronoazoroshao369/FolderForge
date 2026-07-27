/**
 * Tools that must remain visible after every routing decision so an agent can
 * inspect health and recover the full catalog without reconnecting.
 */
export const ROUTING_RECOVERY_TOOLS = [
  'workspace_route',
  'workspace_status',
  'workspace_health',
  'workspace_list',
] as const;

export const TASK_PRESETS: Readonly<Record<string, readonly string[]>> = {
  explore: [
    ...ROUTING_RECOVERY_TOOLS,
    'search_text',
    'search_files',
    'code_find_symbol',
    'code_symbols_overview',
    'file_read',
  ],
  run_ui: [
    ...ROUTING_RECOVERY_TOOLS,
    'process_start',
    'process_read',
    'process_stop',
    'browser_open',
    'browser_set_viewport',
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_console',
    'browser_network',
    'browser_screenshot',
    'browser_visual_compare',
    'browser_accessibility_audit',
    'browser_flow_run',
    'browser_emulate',
    'browser_emulation_status',
    'browser_eval',
    'browser_close',
  ],
  implement: [
    ...ROUTING_RECOVERY_TOOLS,
    'project_analyze',
    'code_context',
    'patch_transaction',
    'project_verify',
    'change_summary',
    'file_read',
    'search_text',
    'code_find_symbol',
    'code_find_references',
    'git_diff',
  ],
  fix_tests: [
    ...ROUTING_RECOVERY_TOOLS,
    'project_analyze',
    'code_context',
    'patch_transaction',
    'project_verify',
    'change_summary',
    'run_test',
    'code_diagnostics',
    'file_edit_block',
    'shell_exec',
    'git_diff',
  ],
};
