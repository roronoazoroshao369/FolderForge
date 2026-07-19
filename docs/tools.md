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

## Schema lock

The public native tool surface is frozen in `src/tools/schema-lock.ts`
(`FROZEN_TOOLS`), which is the **source of truth** for tool names and their
`mutates` / `risk` contract at 1.0. Renaming a tool, removing one, or changing
its mutation/risk classification is a **breaking change**: it requires a
major-version bump and a deliberate edit to that file. Adding a brand-new tool is
backwards-compatible - register it, then add an entry to the lock.

The guard test `tests/unit/schema-lock.test.ts` fails in CI if the live registry
and the lock ever diverge, so accidental renames or removals are caught before
release. A couple of entries are frozen at their *actual* runtime risk rather
than a tidier value (e.g. `audit_export` and `approval_request` fall back to the
`defineTool` default of `MEDIUM` because they are absent from `TOOL_RISK`);
reclassifying them is a separate, intentional change. Adapter (child-MCP) tools
are namespaced and discovered dynamically, so they are **not** part of the frozen
surface.

### `parse_errors` (internal but registered)

`parse_errors` is an **internal helper** used by the build/quality tooling, not a
tool intended for direct day-to-day use. It nonetheless lives in the native
registry, so it shows up in `tools/list` and is frozen in the schema lock
(`mutates: false`, `risk: MEDIUM`). This is intentional: the schema-lock guard is
deliberately strict and freezes the *entire* live catalog so CI catches any
accidental drift. Don't be surprised to see `parse_errors` in the tool list -
it's expected, and removing or hiding it would be a lock change like any other.

## Groups

### Workspace
`workspace_status`, `workspace_activate`, `workspace_onboard`, `workspace_health`,
`workspace_route`, `project_detect_commands` - activate and inspect the active
project. `workspace_route` switches the visible tool set to a task preset
(`explore`, `run_ui`, `fix_tests`) or resets to all.

### Files
`file_read`, `file_read_many`, `file_write`, `file_patch`, `file_edit_block`,
`file_move`, `file_copy`, `list_directory`, `file_delete` - all paths pass
through `PathPolicy.resolveSafe` (workspace boundary, denied globs, symlink-escape
checks). Mutations return a diff preview where applicable. `file_move` renames or
relocates a file/directory and `file_copy` copies one (recursively for
directories); both are boundary-checked on *both* endpoints and refuse to clobber
an existing destination unless `overwrite=true`. `list_directory` enumerates a
directory (optionally recursive, with an entry cap) and skips anything the path
policy denies, so secrets, `node_modules`, and `.git` internals never leak.

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
`git_add`, `git_checkout`, `git_commit`, `git_push`, `git_reset`, `git_fetch`,
`git_pull`, `git_stash`. Commit/push default to approval; `git_reset --hard` is
CRITICAL. `git_fetch` (MEDIUM) updates remote-tracking refs only and never
touches the working tree. `git_pull` (HIGH) integrates remote changes into the
current branch (merge or `--rebase`) and confirms interactively via elicitation
before running, warning when the working tree is dirty. `git_stash` (MEDIUM)
shelves and restores work via `op`: `push` (default) | `pop` | `apply` | `list` |
`drop`; it deliberately omits `clear` to avoid irreversible data loss.

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
`policy_get` reads the active policy mode. `policy_set_mode` remains frozen in the
internal schema for compatibility but is admin-only and is never advertised to
agent MCP clients; runtime changes use dashboard `POST /policy/mode`.
`policy_explain` dry-runs a tool call and returns the decision
(`allow`/`deny`/`approval`) without executing it or creating a request.
`audit_recent` and `audit_export` inspect or export the append-only audit trail.

### Approvals
`approval_status` and `approval_request` remain agent-visible for inspection and
request creation. `approval_approve` and `approval_deny` remain in the internal
frozen registry for compatibility, but are admin-only and excluded from agent
`tools/list` / `tools/call`.

A gated agent call returns an `approvalId`. A distinct dashboard admin principal
may resolve it with `once` or `session` scope. Requests expire after
`policy.approvalTtlMs`; self-approval is rejected; once approvals bind requester,
tool, and canonical arguments; session approvals bind requester and tool for the
current process.

#### Embedded resource blocks (1.3.3+)

Tool results now carry typed MCP content blocks in addition to plain text:

| Block type | Use |
| --- | --- |
| `text` | Plain text (always first — backwards-compatible) |
| `image` | Base64 image content with a MIME type (e.g. browser screenshots for vision-capable clients) |
| `resource` | Embedded content (e.g. `git_diff` attaches the diff as `text/x-diff` for in-client diff viewers) |
| `resource_link` | URI reference to a local file or dashboard URL for out-of-band viewing |

### AI coding runtime

The `agent` group provides `project_analyze`, `code_context`, `patch_transaction`, `project_verify`, and `change_summary`. All five advertise output schemas. `patch_transaction` additionally returns diff resources; failed verification preserves structured execution evidence. See [`ai-coding-runtime.md`](./ai-coding-runtime.md).

### Governed workflows

The `workflow` group provides create/run/resume/status/list/cancel/report operations. Definitions are role-scoped, acyclic, bounded, and non-recursive; every child step still uses the original tool's governance. See [`workflows.md`](./workflows.md).

### Local MCP plugins

The `plugin` group provides `plugin_list`, `plugin_inspect`, `plugin_install`, `plugin_update`, `plugin_enable`, `plugin_disable`, `plugin_uninstall`, and `plugin_health`. Installed plugins default to a two-tool facade and declare per-sub-tool risk in their manifest. Trusted packages may use process mode; digest-pinned Docker/Podman mode maps declared network/filesystem/env permissions to an enforceable bounded runtime. See [`plugin-system.md`](./plugin-system.md) and [`sandbox.md`](./sandbox.md).

### Artifacts and UI evidence

The `artifact` group provides `artifact_put`, `artifact_list`, `artifact_get`,
`artifact_compare`, and `artifact_delete`. Objects use full SHA-256 identities,
atomic bounded storage, integrity verification on read, and PNG pixel-diff
metadata. Successful browser screenshots are also persisted automatically while
the original MCP image remains available to vision-capable clients. See
[`artifacts.md`](./artifacts.md).

Facade dispatch uses dynamic per-call classification before OAuth and policy. A
selected sub-tool contributes its own identity, risk, mutation flag, approval
arguments, quota key, and audit identity to one governance pipeline; the generic
`call_tool` envelope is not evaluated as a second operation. Core/common tools and
stable wrappers remain direct tools, while facade mode is reserved for large,
dynamic, plugin-owned, or long-tail catalogs. See
[`mcp-plugin-architecture.md`](./mcp-plugin-architecture.md).

### Browser & DB
The stable native browser wrappers are `browser_open`, `browser_snapshot`,
`browser_click`, `browser_type`, `browser_console`, `browser_network`,
`browser_screenshot`, `browser_set_viewport`, `browser_visual_compare`,
`browser_accessibility_audit`, `browser_close`, and `browser_eval`. They route to
the configured Playwright child MCP while keeping FolderForge schemas, policy,
audit, artifact persistence, and rich image delivery. Dynamic child tools
may also be exposed namespaced as `<adapter>__<tool>` (e.g.
`playwright__browser_navigate`, `serena__find_symbol`) - see `docs/adapters.md`.
`db_*` tools (`db_connect`, `db_list_connections`, `db_list_tables`,
`db_describe_table`, `db_query_readonly`, `db_explain`) are native. Read-only
queries are LOW; writes/migrations are HIGH.

## Group presets

`src/tools/index.ts` exports `GROUP_PRESETS`, applied once at startup via
`--tools-preset` so the very first `tools/list` is already trimmed:

| Preset | Groups | Notes |
| --- | --- | --- |
| `vibe` | workspace, workflow, agent, file, search, terminal, process, git, code, build | Full coding and governed-workflow surface (**71 tools** in the audited working tree). |
| `vibe-lite` | workflow, agent, file, search, code, terminal, build, git, process, browser | Folder-scoped and hard-capped to **50 tools**. The complete workflow, agent, and browser groups are pinned; lower-level/default-disabled primitives are trimmed before cap resolution. Explicit `--tools-enable` names are retained. This is the only preset that does not force-add the workspace group. |
| `readonly` | workspace, workflow, agent, file, search, code | Exploration-oriented surface (**42 tools**); mutating calls are still denied by readonly policy rather than by group membership alone. |
| `full` | all native groups, including plugin, artifact, and game | Explicit opt-in to the full native surface (**276 tools** in the audited working tree). Dynamic child/plugin tools may add to this count. |

## Task presets

`src/tools/index.ts` exports `TASK_PRESETS` (`explore`, `run_ui`, `fix_tests`).
The `workspace_route` tool exposes this at runtime: calling it with a preset name
runs `registry.setActive(TASK_PRESETS[name])` so `tools/list` returns only that
focused subset; `workspace_route` with `reset: true` (or `preset: "all"`) restores
the full catalog.
