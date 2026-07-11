# Changelog

All notable changes to FolderForge are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/), and the project follows
semantic versioning.

## [2.0.0-rc.1] - candidate prepared 2026-07-11 (not published)

This candidate is committed and pushed on `main`. It has not been tagged,
published to npm, or released as a hosted artifact.

### Added

- **MCP facade for large child servers.** Added opt-in two-tool `list_tools` / `call_tool` surfacing so 100+ child tools remain reachable without exceeding common client tool caps.
- **Per-sub-tool governance for facade calls.** Each dispatched child operation re-enters policy, approval, rate-limit, and audit handling under its own synthetic identity.
- **BM25 relevance ranking for facade discovery.** `list_tools` now accepts `query`, ranks tool names and descriptions, and returns `ranked: true` with per-tool scores.
- **Vision-ready child MCP results.** Standard child `image`, text `resource`, and `resource_link` blocks are promoted into the parent MCP response; screenshot base64 is not duplicated in compatibility text.
- **Correct child error semantics.** Child `isError:true` now returns parent MCP `isError:true` and records `tool_error` instead of a false-success audit event.
- **Responsive browser testing.** Added `browser_set_viewport` and expanded `browser_screenshot` inputs for format, full-page, and element capture.
- **Concurrent browser isolation.** Generated/default Playwright adapter configuration now includes `--isolated` to avoid shared-profile lock collisions and cross-session state leakage.
- **Stable 50-tool UI surface.** `vibe-lite` keeps all 10 browser wrappers, pins workflow, agent, and browser groups under cap pressure, and removes superseded/lower-value primitives while preserving process lifecycle in exactly 50 tools.
- **Reliable Git installs.** Added an npm `prepare` build so installs from a Git repository regenerate the complete ignored `dist/` tree instead of depending on an incomplete set of legacy tracked artifacts.
- **AI coding runtime.** Added typed `project_analyze`, `code_context`, `patch_transaction`, `project_verify`, and `change_summary` tools for governed analyze→edit→verify loops.
- **Transactional edits.** Multi-file patch previews now enforce exact-state apply/rollback checks and return MCP diff resources.
- **Structured failure evidence.** Error responses preserve data/structuredContent, including verification exit codes, stdout/stderr, and parsed diagnostics.
- **Local MCP plugin lifecycle.** Added validated local manifests plus list/inspect/install/update/enable/disable/uninstall/health tools with hot facade registration and restart persistence.
- **Plugin environment isolation.** Installed child MCP servers receive only a minimal executable path and explicitly allowlisted environment variables instead of inheriting the complete parent environment.
- **Dynamic adapter registry.** Child adapters can be added, refreshed, and removed at runtime with manifest risk maps while continuing through the same policy, approval, rate-limit, rich-content, and audit pipeline.
- **Governed agent workflows.** Added persistent role-scoped workflows with dependencies, step references, expectations, checkpointed execution, cancellation, reports, and restart-safe non-replay.
- **Complete one-shot approvals.** Approved `once` requests now match exact canonical tool arguments, are consumed once, and allow paused workflows to resume without repeated approval prompts.
- **Bounded workflow evidence.** Checkpoints redact and cap tool evidence, persist image metadata instead of base64, reject detected secrets in definitions, and store atomically outside Git.
- **Self-hosting diagnostics.** Non-zero shell calls now expose a useful primary error plus typed stdout/stderr/exit data; exact patch failures return nearest-context and whitespace/line-ending diagnostics without fuzzy mutation.
- **Isolated test approvals.** Vitest uses temporary approval storage instead of accumulating state in repository fixtures.
- **Conservative temp cleanup.** A standalone cleanup of explicitly prefixed FolderForge temp roots is MEDIUM, while chained, wildcard, root/home/system, and non-prefixed targets remain blocked or approval-gated.
- **Plugin update availability.** Failed validation/copy before replacement restores the previous enabled plugin facade.
- **Executable release gates.** Added dependency audits, package/tarball install and CLI smoke checks, plus authenticated HTTP MCP initialize/list/call smoke checks to the release workflow.
- **Apache-2.0 license artifact.** Added the license file required by package metadata and enforced its presence in the packed tarball.
- **Read-only doctor command.** Added stable human/JSON installation, configuration, dependency, port, plugin, and state diagnostics with exit codes 0/1/2.
- **Explicit browser setup.** Added `folderforge setup browser`, including `--with-deps`, machine-readable output, and a no-download `--dry-run` mode that resolves the installed package-local Playwright CLI.
- **Cross-platform release matrix.** Added Ubuntu, macOS, and Windows CI coverage on Node 22 and Node 24, including tarball, stdio MCP, and authenticated HTTP smoke tests.
- **Path and degradation compatibility.** Added spaces/Unicode package and stdio paths, Windows junction escape coverage, process-stop wakeups, runtime permission diagnostics, and explicit missing-Chromium warn/fail contracts.
- **Approval confidentiality and exact retry matching.** Approval state now persists redacted arguments plus a canonical SHA-256 fingerprint, keeps mode `0600`, redacts audit/elicitation summaries, and preserves exact once/restart semantics.
- **Plugin package integrity.** New installs/updates record and verify a deterministic SHA-256 package-tree digest; doctor and adapter startup reject tampering.
- **Transactional plugin activation rollback.** Updates keep the old package/registry until the new facade loads, then restore the old enabled facade if activation fails.

### Fixed

- **Package-manager failure diagnostics.** Non-zero package/audit commands now keep exit code, stdout, and stderr while returning an actionable primary error.
- **Release dependency findings.** Upgraded the Vitest/Vite test toolchain to remove the full-audit high/critical advisories.
- **Install-time browser side effect.** Removed the automatic `postinstall` network download and mutable `npx --yes playwright` execution; browser setup is now explicit and package-local.
- **Windows shell and package scripts.** Replaced POSIX-only `chmod`/`rm -rf` lifecycle commands and stopped passing `-lc` to `cmd.exe`; shell, managed-process, verification, and Godot launch paths now use platform-specific invocation and quoting.
- **Release documentation drift.** Corrected approval persistence semantics, tool preset counts, and the explicit non-sandbox boundary of local plugins.

- **Godot bridge addon shipped (`addons/folderforge_bridge/`, wiring point #8).**
  The RUN-channel GDScript addon - the last unbuilt architectural piece of the
  1.5 Godot integration - is now in the tree: an `EditorPlugin` (`plugin.gd`)
  that registers a `FolderForgeBridge` autoload, and a runtime autoload
  (`runtime_bridge.gd`) that runs a loopback-only (`127.0.0.1:9090`)
  line-delimited JSON/TCP server inside the live game. It implements the full
  RUN-channel op set the TS adapter (`src/adapters/godot/runtime.ts`) speaks -
  liveness/`ping`, scene-tree/UI/node inspection, performance, logs/errors,
  `eval`, property/method/signal/group control, node spawn/remove/reparent,
  scene instantiate/change, screenshots, input injection, animation/audio,
  window/world settings, and `locale`. Port is overridable via the
  `FOLDERFORGE_RUNTIME_PORT` env var or the `folderforge/runtime_port` project
  setting. Every op is wrapped so a bad path or failed call returns
  `{ok:false,error}` instead of crashing the game; `eval` maps to the
  CRITICAL/approval-gated `game_eval` tool. Includes an install/protocol/security
  `README.md`. Requires Godot 4.2+. Verified end-to-end against a real Godot
  4.4.1 engine (headless): a 14-check smoke client exercised ping/liveness,
  scene-tree/UI/group/class inspection, performance, property round-trip,
  call_method, eval, get_node_info, os_info, spawn_node, and structured-error
  paths (unknown op, bad node path) - 14/14 passed. The smoke run surfaced and
  fixed a coroutine bug: `_handle_line` now `await`s `_dispatch` (which can
  suspend via `wait`/`await_signal`), so the autoload loads cleanly.

- **Godot integration Step 5d - remaining editor/scene helpers (`game_*`
  tools).** 7 new tools bring the surface to **149/149 - full parity with the
  149-tool reference (`tugcantopaloglu/godot-mcp`) reached.** All risk-classified,
  frozen in the schema lock, and covered by `tests/integration/game-ops.test.ts`
  (full suite green; typecheck, lint, test, build all pass):
  - **Family 2 - scene helpers.** `game_load_sprite` (HIGH; ensures a
    `Texture2D` ext_resource and sets the sprite property), `game_modify_scene_node`
    / `game_remove_scene_node` (HIGH; headless `.tscn` node edits),
    `game_manage_scene_signals` (HIGH; connect/disconnect/list in-scene signals).
  - **Family 26 / resources.** `game_export_mesh_library` (HIGH; writes a text
    MeshLibrary resource referencing the source scene - a deliberate offline
    approximation of editor baking), `game_manage_shader` (**CRITICAL**,
    approval-gated; writes `.gdshader` GPU code), `game_manage_theme_resource`
    and `game_manage_resource` (HIGH; `.tres` `[resource]`-block upserts via the
    shared `upsertResourceProperty` helper).
  - **Family 13 - localization.** `game_locale` (RUN channel; only Step 5d tool
    needing a live game, tested against the structured "no game running" path).

  All CLI tools are pure file edits (no Godot binary required). This completes
  the 1.5 Godot integration plan; see `docs/godot-mcp.md` Session Handoff for the
  release/next-step proposals (tag 1.5.0, ship the `folderforge_bridge` addon,
  real-engine smoke test).

- **Godot integration Step 5c - project management (PROC) + headless
  project/editor CLI tier (`game_*` tools).** 16 new tools bring the surface to
  **142/149**, all risk-classified, frozen in the schema lock, and covered by
  `tests/integration/game-ops.test.ts` (full suite 269 green; typecheck, lint,
  test, build all pass):
  - **Family 1 - project management (PROC channel).** `game_list_projects`
    (LOW), `game_run_project` / `game_launch_editor` / `game_stop_project`
    (MEDIUM), `game_get_debug_output` (LOW). Launch tools start the Godot binary
    through the shared `ProcessManager`, so output streams and they are governed
    like any other long-running process; stop/read reuse the process session id.
  - **Family 17 - build & export (PROC).** `game_export_project` (MEDIUM) runs a
    headless preset export as a managed process.
  - **Family 2 (writes) - scene save + UID.** `game_save_scene` (HIGH,
    validate-and-rewrite round-trip), `game_get_uid` (LOW, reads `uid://` from a
    text header), `game_update_project_uids` (HIGH, headless `--import`).
  - **Family 15 - project creation + config.** `game_create_project`
    (**CRITICAL**, approval-gated; bootstraps a valid `project.godot`),
    `game_manage_autoloads` / `game_manage_input_map` /
    `game_manage_export_presets` (HIGH).
  - **Family 24 - editor & project tools.** `game_manage_layers` /
    `game_manage_plugins` / `game_manage_translations` (HIGH), all
    `project.godot`-backed text edits.

  All CLI tools are pure file edits (no Godot binary required); PROC tools degrade
  to a normal process error when the binary is absent. Remaining to 149: a handful
  of editor/scene helpers (shader/scene-signals/theme management, `game_locale`,
  `game_load_sprite`, `game_export_mesh_library`, `game_modify_scene_node` /
  `game_remove_scene_node`).

### Added (earlier in Unreleased)

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
