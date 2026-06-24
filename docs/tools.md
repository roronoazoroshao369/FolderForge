# Tools

Tools are registered by group in `src/tools/index.ts` and executed through
`ToolRegistry.call`, which classifies risk, consults the `PolicyEngine`, and
records audit events. Each tool declares a default risk level in
`src/policy/risk.ts` (`TOOL_RISK`).

## Risk levels

| Level | Meaning | Behavior |
| --- | --- | --- |
| `LOW` | Read-only / safe | Always allowed (except readonly blocks mutations) |
| `MEDIUM` | Local mutation | Allowed in `safe`/`dev`/`danger`, audited |
| `HIGH` | Sensitive mutation | Requires approval |
| `CRITICAL` | Destructive | Denied unless `danger` mode + approval |

`shell_exec` is re-classified per command at call time by `CommandPolicy`.

## Groups

### Workspace
`workspace_status`, `workspace_activate`, `workspace_onboard`, `workspace_health`,
`workspace_route`, `project_detect_commands` - activate and inspect the active
project. `workspace_route` switches the visible tool set to a task preset
(`explore`, `run_ui`, `fix_tests`) or resets to all.

### Files
`file_read`, `file_read_many`, `file_write`, `file_patch`, `file_edit_block`,
`file_delete` - all paths pass through `PathPolicy.resolveSafe` (workspace
boundary, denied globs, symlink-escape checks). Mutations return a diff preview.

### Search
`search_files`, `search_text`, `search_ast` - glob, content, and structural
declaration search honoring denied globs and ignore files. `search_ast` finds
functions/classes/methods/interfaces/types/consts by name via lightweight,
regex-backed structural matching (no language server required).

### Terminal & processes
`shell_exec` (one-shot, risk-classified), and the process manager tools
`process_start`, `process_read`, `process_write`, `process_stop`,
`process_kill`, `process_list` for long-running dev servers.

### Git
`git_status`, `git_diff`, `git_log`, `git_show`, `git_blame`, `git_branch`,
`git_add`, `git_checkout`, `git_commit`, `git_push`, `git_reset`. Commit/push
default to approval; `git_reset --hard` is CRITICAL.

### Build & quality
`run_build`, `run_test`, `run_lint`, `run_typecheck`, `code_diagnostics` -
output is run through `src/tools/error-parser.ts` for structured diagnostics.

### Code intelligence
`code_symbols_overview`, `code_find_symbol`, `code_find_references`,
`code_find_definition`, `code_find_implementations`, and symbol-level edits
(`code_replace_symbol_body`, `code_insert_before_symbol`, etc.).

### Memory
`memory_list`, `memory_read`, `memory_write`, `memory_update` - per-project
persistent notes stored under `.folderforge/`.

### Security
`secret_scan` - scans content/diffs for credential patterns
(`src/policy/secret-policy.ts`).

### Policy & audit
`policy_get`, `policy_set_mode` - read or change the active policy mode
(`readonly`/`safe`/`dev`/`danger`). `audit_recent`, `audit_export` - inspect or
export the append-only audit trail.

### Approvals
`approval_status`, `approval_request` - inspect pending approval requests created
by the engine, or raise one explicitly.

### Browser & DB
`browser_*` (via the Playwright child-MCP adapter) and `db_*` (`db_connect`,
`db_list_connections`, `db_list_tables`, `db_describe_table`, `db_query_readonly`,
`db_explain`). Read-only queries are LOW; writes/migrations are HIGH.

## Task presets

`src/tools/index.ts` exports `TASK_PRESETS` (`explore`, `run_ui`, `fix_tests`).
The `workspace_route` tool exposes this at runtime: calling it with a preset name
runs `registry.setActive(TASK_PRESETS[name])` so `tools/list` returns only that
focused subset; `workspace_route` with `reset: true` (or `preset: "all"`) restores
the full catalog.
