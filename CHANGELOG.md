# Changelog

All notable changes to FolderForge are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/), and the project follows
semantic versioning.

## [Unreleased]

### Added

- **Godot integration Step 4 - runtime mutation + input tier (`game_*` tools).**
  46 new RUN-channel tools shipped in three green increments, all risk-classified,
  frozen in the schema lock, and covered by `tests/integration/game-ops.test.ts`
  (31 game tests; full suite 262 green):
  - **Step 4a - node manipulation + signals (12 tools).** Family 8:
    `game_get_property` (LOW), `game_set_property` (HIGH),
    `game_call_method` (CRITICAL), `game_instantiate_scene` /
    `game_remove_node` / `game_change_scene` / `game_reparent_node` (HIGH).
    Family 9: `game_connect_signal` / `game_disconnect_signal` /
    `game_emit_signal` (HIGH), `game_list_signals` / `game_await_signal` (LOW).
  - **Step 4b - input + animation + audio (20 tools).** Family 5 runtime input
    and Family 14 enhanced input (MEDIUM), Family 10 animation
    (`game_play_animation`, `game_tween_property`, MEDIUM), Family 22 advanced
    animation and Family 23 advanced audio (MEDIUM).
  - **Step 4c - system/window + UI controls (14 tools).** Family 19:
    `game_os_info` (LOW), `game_time_scale` (MEDIUM),
    `game_window` / `game_process_mode` / `game_world_settings` (HIGH),
    `game_script` (CRITICAL). Family 25 UI controls (`game_ui_control`,
    `game_ui_text`, `game_ui_popup`, `game_ui_tree`, `game_ui_item_list`,
    `game_ui_tabs`, `game_ui_menu`, `game_ui_range`, all MEDIUM).

  When no game is running, every tool returns a structured, actionable error.
- **Godot integration Step 3 - runtime bridge + runtime read tier (`game_*`
  tools).** A new RUN channel (`GodotRuntime`, `src/adapters/godot/runtime.ts`)
  talks to a GDScript runtime-bridge autoload inside the *live game* over a
  line-delimited JSON TCP protocol (default :9090). Twelve `game_*` tools:
  - `game_runtime_status` (LOW) - probe whether a live game is reachable;
    returns `running: true/false` and never fails when the game is stopped.
  - `game_get_scene_tree`, `game_get_node_info`, `game_get_ui`,
    `game_get_performance`, `game_get_nodes_in_group`,
    `game_find_nodes_by_class`, `game_get_errors`, `game_get_logs` (LOW) -
    read-only introspection of the running game.
  - `game_pause` / `game_wait` (MEDIUM) - transiently perturb the live game.
  - `game_eval` (CRITICAL) - run arbitrary GDScript in the live process;
    approval-gated even in danger mode (Step 0).

  When no game is running, every tool returns a structured, actionable error.
  The surface is risk-classified, added to the frozen schema lock, and covered by
  `tests/integration/game-ops.test.ts` (Step 3 suite drives a fake TCP bridge).
- **Godot integration Step 2 - headless edit tier (`game_*` tools).** Mutating
  `game_*` tools backed by `GodotCli`, working directly on project files with the
  editor closed and project-root-guarded paths:
  - `game_create_directory` (MEDIUM) - create a `res://` directory tree.
  - `game_write_file` / `game_rename_file` (HIGH) - write or move a project file.
  - `game_delete_file` (CRITICAL) - remove a project file.
  - `game_create_scene` / `game_add_node` / `game_remove_node` /
    `game_modify_node` / `game_attach_script` (HIGH) - create and mutate `.tscn`
    scenes and their node trees.
  - `game_create_script` (CRITICAL) - create a new GDScript file.
  - `game_create_resource` / `game_modify_project_settings` /
    `game_set_main_scene` (HIGH) - create resources and edit `project.godot`.

  CRITICAL tools require an explicit approval (Step 0), even in danger mode. The
  new surface is risk-classified, added to the frozen schema lock, and covered by
  `tests/integration/game-ops.test.ts`.
- **Godot integration Step 1 - headless read tier (`game_*` tools).** A new
  `game` tool group with six LOW-risk, read-only tools backed by `GodotCli`
  (`src/adapters/godot/cli.ts`), the headless-CLI + file-parsing channel:
  - `game_get_godot_version` - probe `godot --headless --version`; reports
    `available: false` (not an error) when no binary is found.
  - `game_get_project_info` - parse `project.godot` (name, config version, main
    scene).
  - `game_read_scene` - parse a `.tscn` into its node tree + external resource
    references.
  - `game_read_project_settings` - raw `project.godot` plus its section list.
  - `game_list_project_files` - recursive `res://` listing, skipping
    `.git`/`.godot`/`.import` caches, with a coarse kind classification.
  - `game_read_file` - capped, project-root-guarded UTF-8 file read.

  These parse project files directly, so they work with the editor closed and
  even without Godot installed. New `adapters.godot` config block (`enabled`,
  `godotPath`, `editorPort`, `runtimePort`); the surface is risk-classified,
  added to the frozen schema lock, and registered with `game` in the `full`
  preset plus a new `godot` group preset. Covered by
  `tests/integration/game-ops.test.ts` (8 tests).
- **`approval_approve` / `approval_deny` tools** to resolve a pending approval
  request directly over the MCP tool channel. `approval_approve` takes an `id`
  and an optional `scope` (`once` | `session`); `approval_deny` takes an `id`.
  This unblocks HIGH/CRITICAL tool calls when the dashboard is disabled
  (`--no-dashboard`) and the client cannot elicit - the prerequisite (Godot
  integration Step 0) before any CRITICAL `game_*` tool can ship. Both are LOW
  risk, recorded in the schema lock and audit log, and covered by
  `tests/integration/approval-ops.test.ts`.
- **`--policy <mode>` CLI flag** (alias `--policy-mode`) to set the policy mode at
  startup: `readonly` | `safe` | `dev` | `danger`. The CLI value wins over the
  config file's `policy.defaultMode`. Invalid values are ignored with a warning
  and the configured mode is kept. Documented in the README CLI table.

## [1.4.2] - 2026-06-28

### Changed

- Pin the Playwright child-MCP adapter to a specific version (`@playwright/mcp@0.0.41`)
  instead of a floating tag, for reproducible browser-automation installs.

## [1.4.1] - 2026-06-28

### Changed

- Config-file handling now writes the auto-generated `config.yaml` on first run
  (refinement of the 1.4.0 zero-config behavior).

## [1.4.0] - 2026-06-28

### Added

- **Zero-config first run.** When no config is found in any discovery location,
  FolderForge writes a complete, batteries-included `folderforge.yaml` next to
  the project and loads it immediately (`policy.defaultMode: dev`,
  `tools.preset: vibe-lite`, and `adapters.playwright.enabled: true` so the
  `browser_*` tools work out of the box). Existing config files are never
  overwritten; `--config <file>` skips auto-generation; a failed write is
  non-fatal and falls back to built-in defaults.

## [1.3.3] - 2026-06-27

### Added

- **Interactive approval via MCP elicitation** with dashboard fallback. High-risk
  tool calls (e.g. `git_commit`, `file_delete`) prompt for approval directly in
  the chat when the client advertises the `elicitation` capability, falling back
  to the dashboard flow otherwise.
- **`ToolContentBlock` content blocks** (`text | resource | resource_link`) on
  `ToolResult`, with `git_diff` attaching the raw diff as an embedded
  `text/x-diff` resource.

---

For the full pre-1.3.3 history (1.0 hardening, 1.2 MCP protocol features and agent
ergonomics, and the 0.1-0.3 foundations), see `docs/roadmap.md`.
