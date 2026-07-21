# Godot MCP Integration

Integrate the Godot 4.x game engine into FolderForge as a `game` tool group,
covering both **edit-time** and **runtime** control, routed through the existing
policy / approval / audit pipeline.

The coverage target is **full parity with the most complete open-source Godot
MCP today** - [`tugcantopaloglu/godot-mcp`](https://github.com/tugcantopaloglu/godot-mcp),
which ships **149 tools**. FolderForge aims to cover **all 149 equivalents** and
then exceed them with governance (policy, approval, audit) that no other Godot
MCP offers.

## Goal

Let an AI agent (via FolderForge) drive Godot end-to-end - create projects,
read/edit scenes, run the game, and introspect/manipulate the runtime - so an
agent can **vibe-code a whole game**, all **within FolderForge's governance
model** (4-level policy, approval queue, audit log).

**Competitive edge over the 149-tool baseline:**

- Policy-gated engine ops: destructive/runtime-mutating tools (`game_eval`,
  `game_set_property`, `game_delete_file`, `game_http_request`, ...) are risk-
  classified and routed through the approval queue.
- Every engine operation is recorded in the audit log.
- Edit-time and runtime unified under one risk pipeline.
- Engine-agnostic core (adapter pattern) - paves the way for Unity / Unreal.

## Coverage target: 149/149

The reference repo groups its 149 tools into 26 families. FolderForge mirrors
every family. We adopt a consistent `game_*` namespace for all tools (the
reference mixes prefixed `game_*` runtime tools with unprefixed headless/editor
tools; FolderForge normalizes the surface). Each reference tool maps 1:1.

| # | Family | Tools | FolderForge risk band |
| --- | --- | --- | --- |
| 1 | Project Management | 7 | LOW (read) / MEDIUM (run, stop) |
| 2 | Scene Management | 7 | HIGH (mutating) / LOW (uid reads) |
| 3 | Headless Scene Ops | 5 | HIGH / LOW (read_scene) |
| 4 | Project Settings | 3 | HIGH (modify) / LOW (read, list) |
| 5 | Runtime Input | 4 | MEDIUM |
| 6 | Runtime Inspection | 3 | LOW |
| 7 | Runtime Code Execution | 1 | **CRITICAL** |
| 8 | Runtime Node Manipulation | 7 | HIGH / **CRITICAL** (call_method) |
| 9 | Runtime Signals | 5 | HIGH / LOW (list) |
| 10 | Runtime Animation | 2 | MEDIUM |
| 11 | Runtime Utilities | 5 | LOW / MEDIUM (pause) |
| 12 | File I/O | 4 | HIGH (write, mkdir) / **CRITICAL** (delete) / LOW (read) |
| 13 | Error & Log Capture | 2 | LOW |
| 14 | Enhanced Input | 8 | MEDIUM |
| 15 | Project Creation | 4 | **CRITICAL** (create_project) / HIGH |
| 16 | Advanced Runtime | 23 | HIGH / LOW (reads) |
| 17 | Build & Export | 1 | MEDIUM |
| 18 | Networking | 4 | **CRITICAL** |
| 19 | System & Window | 6 | HIGH / LOW (os_info) / **CRITICAL** (script) |
| 20 | 3D Rendering & Geometry | 13 | HIGH |
| 21 | 2D Systems | 7 | HIGH |
| 22 | Advanced Animation | 3 | MEDIUM |
| 23 | Advanced Audio | 3 | MEDIUM |
| 24 | Editor & Project Tools | 12 | HIGH / **CRITICAL** (create_script, shader) |
| 25 | UI Controls | 8 | MEDIUM |
| 26 | Rendering & Resources | 2 | HIGH / LOW (read) |
| | **Total** | **149** | |

### Risk policy (how the band is decided)

- **LOW** - pure reads / introspection (no state change).
- **MEDIUM** - transient, reversible runtime effects (input injection, run/stop,
  pause, tweens, UI interaction).
- **HIGH** - persistent edits to project files or live node state (scene writes,
  node/property mutation, resource creation). Approval-gated outside `dev`/`danger`.
- **CRITICAL** - arbitrary code execution or irreversible/host-reaching ops
  (`game_eval`, `game_call_method`, file delete, `create_project`, networking,
  runtime script attach). Always approval-gated, even in `danger`.

## Full tool map (149)

All names are FolderForge `game_*` equivalents of the reference tool. "Channel":
**CLI** = `godot --headless`, **EDIT** = editor WebSocket addon, **RUN** = runtime
TCP autoload bridge, **PROC** = FolderForge process manager.

### 1. Project Management (7)
`game_launch_editor` (MEDIUM/PROC), `game_run_project` (MEDIUM/PROC),
`game_stop_project` (MEDIUM/PROC), `game_get_debug_output` (LOW/PROC),
`game_get_godot_version` (LOW/CLI), `game_list_projects` (LOW/CLI),
`game_get_project_info` (LOW/CLI).

### 2. Scene Management (7)
`game_create_scene` (HIGH/CLI), `game_add_node` (HIGH/CLI),
`game_load_sprite` (HIGH/CLI), `game_export_mesh_library` (HIGH/CLI),
`game_save_scene` (HIGH/CLI), `game_get_uid` (LOW/CLI),
`game_update_project_uids` (HIGH/CLI).

### 3. Headless Scene Operations (5)
`game_read_scene` (LOW/CLI), `game_modify_scene_node` (HIGH/CLI),
`game_remove_scene_node` (HIGH/CLI), `game_attach_script` (HIGH/CLI),
`game_create_resource` (HIGH/CLI).

### 4. Project Settings (3)
`game_read_project_settings` (LOW/CLI), `game_modify_project_settings` (HIGH/CLI),
`game_list_project_files` (LOW/CLI).

### 5. Runtime Input (4)
`game_screenshot` (LOW/RUN), `game_click` (MEDIUM/RUN),
`game_key_press` (MEDIUM/RUN), `game_mouse_move` (MEDIUM/RUN).

### 6. Runtime Inspection (3)
`game_get_ui` (LOW/RUN), `game_get_scene_tree` (LOW/RUN),
`game_get_node_info` (LOW/RUN).

### 7. Runtime Code Execution (1)
`game_eval` (**CRITICAL**/RUN).

### 8. Runtime Node Manipulation (7)
`game_get_property` (LOW/RUN), `game_set_property` (HIGH/RUN),
`game_call_method` (**CRITICAL**/RUN), `game_instantiate_scene` (HIGH/RUN),
`game_remove_node` (HIGH/RUN), `game_change_scene` (HIGH/RUN),
`game_reparent_node` (HIGH/RUN).

### 9. Runtime Signals (5)
`game_connect_signal` (HIGH/RUN), `game_disconnect_signal` (HIGH/RUN),
`game_emit_signal` (HIGH/RUN), `game_list_signals` (LOW/RUN),
`game_await_signal` (LOW/RUN).

### 10. Runtime Animation (2)
`game_play_animation` (MEDIUM/RUN), `game_tween_property` (MEDIUM/RUN).

### 11. Runtime Utilities (5)
`game_pause` (MEDIUM/RUN), `game_performance` (LOW/RUN), `game_wait` (LOW/RUN),
`game_get_nodes_in_group` (LOW/RUN), `game_find_nodes_by_class` (LOW/RUN).

### 12. File I/O (4)
`game_read_file` (LOW/CLI), `game_write_file` (HIGH/CLI),
`game_delete_file` (**CRITICAL**/CLI), `game_create_directory` (HIGH/CLI).

### 13. Error & Log Capture (2)
`game_get_errors` (LOW/RUN), `game_get_logs` (LOW/RUN).

### 14. Enhanced Input (8)
`game_key_hold` (MEDIUM/RUN), `game_key_release` (MEDIUM/RUN),
`game_scroll` (MEDIUM/RUN), `game_mouse_drag` (MEDIUM/RUN),
`game_gamepad` (MEDIUM/RUN), `game_touch` (MEDIUM/RUN),
`game_input_state` (LOW/RUN), `game_input_action` (MEDIUM/RUN).

### 15. Project Creation (4)
`game_create_project` (**CRITICAL**/CLI), `game_manage_autoloads` (HIGH/CLI),
`game_manage_input_map` (HIGH/CLI), `game_manage_export_presets` (HIGH/CLI).

### 16. Advanced Runtime (23)
`game_get_camera` (LOW), `game_set_camera` (HIGH), `game_raycast` (LOW),
`game_get_audio` (LOW), `game_spawn_node` (HIGH), `game_set_shader_param` (HIGH),
`game_audio_play` (MEDIUM), `game_audio_bus` (MEDIUM), `game_navigate_path` (LOW),
`game_tilemap` (HIGH), `game_add_collision` (HIGH), `game_environment` (HIGH),
`game_manage_group` (HIGH), `game_create_timer` (HIGH), `game_set_particles` (HIGH),
`game_create_animation` (HIGH), `game_serialize_state` (HIGH),
`game_physics_body` (HIGH), `game_create_joint` (HIGH), `game_bone_pose` (HIGH),
`game_ui_theme` (HIGH), `game_viewport` (HIGH), `game_debug_draw` (MEDIUM).
All channel RUN.

### 17. Build & Export (1)
`game_export_project` (MEDIUM/PROC).

### 18. Networking (4)
`game_http_request` (**CRITICAL**/RUN), `game_websocket` (**CRITICAL**/RUN),
`game_multiplayer` (**CRITICAL**/RUN), `game_rpc` (**CRITICAL**/RUN).

### 19. System & Window (6)
`game_script` (**CRITICAL**/RUN), `game_window` (HIGH/RUN),
`game_os_info` (LOW/RUN), `game_time_scale` (MEDIUM/RUN),
`game_process_mode` (HIGH/RUN), `game_world_settings` (HIGH/RUN).

### 20. 3D Rendering & Geometry (13)
`game_csg`, `game_multimesh`, `game_procedural_mesh`, `game_light_3d`,
`game_mesh_instance`, `game_gridmap`, `game_3d_effects`, `game_gi`,
`game_path_3d`, `game_sky`, `game_camera_attributes`, `game_navigation_3d`,
`game_physics_3d`. All HIGH/RUN (`game_physics_3d` queries are LOW).

### 21. 2D Systems (7)
`game_canvas`, `game_canvas_draw`, `game_light_2d`, `game_parallax`,
`game_shape_2d`, `game_path_2d`, `game_physics_2d`. All HIGH/RUN
(`game_physics_2d` queries are LOW).

### 22. Advanced Animation (3)
`game_animation_tree` (MEDIUM/RUN), `game_animation_control` (MEDIUM/RUN),
`game_skeleton_ik` (MEDIUM/RUN).

### 23. Advanced Audio (3)
`game_audio_effect` (MEDIUM/RUN), `game_audio_bus_layout` (MEDIUM/RUN),
`game_audio_spatial` (MEDIUM/RUN).

### 24. Editor & Project Tools (12)
`game_rename_file` (HIGH/CLI), `game_manage_resource` (HIGH/CLI),
`game_create_script` (**CRITICAL**/CLI), `game_manage_scene_signals` (HIGH/CLI),
`game_manage_layers` (HIGH/CLI), `game_manage_plugins` (HIGH/CLI),
`game_manage_shader` (**CRITICAL**/CLI), `game_manage_theme_resource` (HIGH/CLI),
`game_set_main_scene` (HIGH/CLI), `game_manage_scene_structure` (HIGH/CLI),
`game_manage_translations` (HIGH/CLI), `game_locale` (MEDIUM/RUN).

### 25. UI Controls (8)
`game_ui_control`, `game_ui_text`, `game_ui_popup`, `game_ui_tree`,
`game_ui_item_list`, `game_ui_tabs`, `game_ui_menu`, `game_ui_range`.
All MEDIUM/RUN.

### 26. Rendering & Resources (2)
`game_render_settings` (HIGH/RUN), `game_resource` (HIGH/RUN; `load`/`preload`
sub-ops are LOW).

> **Parity statement:** every one of the reference repo's 149 tools has a 1:1
> FolderForge equivalent above. FolderForge adds the governance layer (risk
> band + approval + audit) on top, which the reference does not have.

## Architecture

```
AI Client --stdio/HTTP MCP--> FolderForge (TS) --+-- headless CLI --> godot --headless   (edit-time, no editor)
                                                 +-- WebSocket :6550 -> Godot Editor Plugin (GDScript, live editor)
                                                 +-- TCP :9090 -------> Runtime autoload bridge (running game)
```

- **CLI (no editor):** `godot --headless` runs a bundled operations script -
  read/modify `.tscn`, project settings, file I/O, resource creation.
- **EDIT (live editor):** WebSocket -> `EditorPlugin` calling `EditorInterface`.
- **RUN (running game):** TCP autoload bridge inside the running game -> eval,
  scene tree, set property, screenshot, FPS / metrics, input injection.

Reuses ~80% of existing FolderForge infrastructure: the adapter pattern
(`src/adapters/child-mcp/`), the routing style of `browser-tools.ts`,
`defineTool`, the group system, `TOOL_RISK`, the approval pipeline,
`process_start/tail`, and the `adapters.ensure()` lifecycle.

## Wiring points

| # | File | Change |
| --- | --- | --- |
| 1 | `src/adapters/godot/client.ts` | **New** - WS + TCP JSON client, health check, reconnect, queue, reentrancy guard |
| 2 | `packages/adapter-godot/src/cli.ts` | **Extracted** - headless `godot --headless` operations runner |
| 3 | `src/tools/game-tools.ts` | **New** - the full `game` group (149 tools) in the `bTool()` style |
| 4 | `src/tools/index.ts` | Import `gameTools()`; add `'game'` to `GROUP_PRESETS.full`; new `godot` preset |
| 5 | `src/policy/risk.ts` | Risk band for all 149 `game_*` tools |
| 6 | `src/tools/schema-lock.ts` | Declare all 149 tools (surface is frozen + test-guarded) |
| 7 | `src/runtime/config.ts` (+types) | `adapters.godot.enabled`, `editorPort`, `runtimePort`, `godotPath` |
| 8 | `addons/folderforge_bridge/` | **Done** - GDScript addon (editor plugin + runtime autoload TCP :9090) users copy in |

## Roadmap to 149

### Step 0 - Unblock approval `[do first]`
- Add `approval_approve` (`id`, `scope: once|session`) and `approval_deny` (`id`).
- Update `schema-lock.ts` and `risk.ts`.
- **Why:** the current MCP client does not support elicitation; running
  `--no-dashboard` otherwise leaves no way to resolve CRITICAL approvals, so
  runtime/eval tools would hang. Required before any CRITICAL `game_*` tool ships.

### Step 1 - Adapter + headless read tier (~25 tools)
- `packages/adapter-godot/src/cli.ts` + bundled `godot_operations.gd`.
- Families 1, 3 (reads), 4 (reads), 12 (read), 13: project info/version/list,
  `game_read_scene`, `game_read_project_settings`, `game_list_project_files`,
  `game_read_file`, run/stop/debug-output.

### Step 2 - Headless edit tier (~35 tools)
- Families 2, 3 (writes), 4 (modify), 12 (write/delete/mkdir), 15, 24.
- Scene create/modify, resource/script creation, project creation, editor &
  project management. Bundle stays CLI-based; no running game needed.

### Step 3 - Runtime bridge + runtime read tier (~20 tools)
- `runtime_bridge.gd` autoload on TCP :9090 + "is the game running?" guard.
- Families 6, 7 (read parts), 11, 13: inspection, performance, logs, eval.

### Step 4 - Runtime mutation + input tier (~35 tools)
- Families 5, 8, 9, 10, 14, 19, 22, 23, 25: node manipulation, signals,
  animation, input, system/window, UI controls.

### Step 5 - Advanced runtime + rendering tier (~34 tools)
- Families 16, 17, 18, 20, 21, 26: advanced runtime, build/export, networking,
  3D geometry, 2D systems, rendering & resources.

## Status

**Updated:** 2026-06-29 - **Phase:** Step 5d shipped - **the surface is now
149/149 game tools and the Godot integration plan is COMPLETE.** Step 5d adds
the final editor/scene-helper tier: `game_load_sprite`,
`game_export_mesh_library`, `game_manage_scene_signals`, `game_manage_shader`
(CRITICAL), `game_manage_theme_resource`, `game_manage_resource`, and the runtime
`game_locale`. All `game_*` tools are risk-classified, frozen in the schema lock,
and covered by `tests/integration/game-ops.test.ts`. Full verification green:
typecheck, lint, `npm test` (29 files, 279 tests), and build all pass. The
schema-lock guard test confirms the live registry contains exactly 149 `game_*`
tools matching the frozen surface.

| Item | Status |
| --- | --- |
| Research Godot MCP ecosystem (~9 repos) | Done |
| Inventory reference repo (149 tools, 26 families) | Done |
| Map all 149 tools -> FolderForge `game_*` + risk + channel | Done |
| Confirm multi-channel (CLI / EDIT / RUN) architecture | Done |
| Decision: integrate into FolderForge (no separate repo) | Done |
| Step 0 - approval_approve / approval_deny | Done |
| Step 1 - adapter + headless read tier | Done |
| Step 2 - headless edit tier | Done |
| Step 3 - runtime bridge + runtime reads | Done |
| Step 4 - runtime mutation + input | Done (4a node/signals, 4b input/anim/audio, 4c system/window + UI) |
| Step 5a - advanced runtime (Family 16) | Done (23 tools) |
| Step 5b - networking + 3D/2D + rendering/resources | Done (Families 18, 20, 21, 26) |
| Step 5c - project mgmt PROC + project/editor CLI tier | Done (16 tools; surface 142/149) |
| Step 5d - remaining editor/scene helpers | Done (7 tools; surface **149/149** - plan complete) |

### Step 1 - delivered surface (6 tools)

`GodotCli` (`packages/adapter-godot/src/cli.ts`) is the CLI/file-read channel; all six
tools route through it (`src/tools/game-tools.ts`, group `game`). They parse
Godot project files directly, so the file-based reads work even with no Godot
binary installed; the engine probe degrades to `available: false` rather than
failing.

| Tool | Risk | Channel | Notes |
| --- | --- | --- | --- |
| `game_get_godot_version` | LOW | CLI | Probes `godot --headless --version`; graceful when absent |
| `game_get_project_info` | LOW | CLI | Parses `project.godot` (name, config version, main scene) |
| `game_read_scene` | LOW | CLI | Parses a `.tscn` into nodes + ext_resource refs |
| `game_read_project_settings` | LOW | CLI | Raw `project.godot` + section list |
| `game_list_project_files` | LOW | CLI | Recursive `res://` listing, skips `.git`/`.godot`/`.import` |
| `game_read_file` | LOW | CLI | Capped UTF-8 read, project-root-guarded |

### Step 3 - delivered surface (12 tools)

`GodotRuntime` (`packages/adapter-godot/src/runtime.ts`) is the RUN channel: a stateless,
one-connection-per-call client speaking line-delimited JSON to the runtime-bridge
GDScript autoload inside the live game (TCP :9090). "Is the game running?" is a
normal, recoverable state - a refused/closed connection returns a structured,
actionable error instead of throwing, and `game_runtime_status` never fails.

| Tool | Risk | Channel | Notes |
| --- | --- | --- | --- |
| `game_runtime_status` | LOW | RUN | `running: true/false` + port; never throws |
| `game_get_scene_tree` | LOW | RUN | Live scene-tree snapshot, optional `maxDepth` |
| `game_get_node_info` | LOW | RUN | Inspect a node by NodePath |
| `game_get_ui` | LOW | RUN | Live Control/UI tree snapshot |
| `game_get_performance` | LOW | RUN | fps, frame time, memory, object/node counts |
| `game_get_nodes_in_group` | LOW | RUN | Node paths currently in a SceneTree group |
| `game_find_nodes_by_class` | LOW | RUN | Node paths matching a class name |
| `game_get_errors` | LOW | RUN | Drain the captured engine error buffer |
| `game_get_logs` | LOW | RUN | Tail the engine log, optional last `lines` |
| `game_pause` | MEDIUM | RUN | Pause/resume (transient, reversible) |
| `game_wait` | MEDIUM | RUN | Advance/idle for N seconds |
| `game_eval` | CRITICAL | RUN | Arbitrary GDScript in the live process; approval-gated |

Wiring done: risk bands in `src/policy/risk.ts`, frozen surface in
`src/tools/schema-lock.ts`, tools registered in `src/tools/game-tools.ts` (group
`game`). Covered by `tests/integration/game-ops.test.ts` (Step 3 suite drives the
tools against a fake TCP bridge: transport, framing, "no game running", and the
approval gate on `game_eval`). Verification: `npm run typecheck`, `npm run lint`,
`npm test` (29 files, 252 tests), and `npm run build` all green.

Wiring done: `adapters.godot` config (`enabled`, `godotPath`, `editorPort`,
`runtimePort`) in `src/runtime/config.ts` + `GodotConfig` in `src/core/types.ts`;
risk bands in `src/policy/risk.ts`; frozen surface in `src/tools/schema-lock.ts`;
registered in `src/tools/index.ts` with `game` added to the `full` preset and a
new `godot` preset. Covered by `tests/integration/game-ops.test.ts` (8 tests).
Verification: `npm run typecheck`, `npm run lint`, `npm test` (29 files, 239
tests), and `npm run build` all green.

**Related, already done (context):**
- CLI flag `--policy <mode>` (readonly | safe | dev | danger) - implemented;

### Step 5d - delivered surface (7 tools; reaches 149/149)

Final editor/scene-helper tier. Six are headless CLI text edits (no Godot binary
required); `game_locale` is a RUN-channel runtime tool.

| Tool | Risk | Channel | Notes |
| --- | --- | --- | --- |
| `game_load_sprite` | HIGH | CLI | Ensures a `Texture2D` ext_resource + sets a node property (default `texture`) to `ExtResource("id")` |
| `game_export_mesh_library` | HIGH | CLI | Writes a text MeshLibrary (`.meshlib`/`.tres`/`.res`) referencing the source scene; refuses to clobber unless `overwrite=true` |
| `game_manage_scene_signals` | HIGH | CLI | `connect` / `disconnect` / `list` `[connection]` entries in a `.tscn` |
| `game_manage_shader` | CRITICAL | CLI | Create/overwrite a `.gdshader` (executable GPU code; approval-gated). Canvas_item stub unless content supplied |
| `game_manage_theme_resource` | HIGH | CLI | Bootstrap or upsert properties in a Theme `.tres` |
| `game_manage_resource` | HIGH | CLI | Generic `.tres`: `create` / `set` / `read` |
| `game_locale` | MEDIUM | RUN | Get/set the running game's TranslationServer locale |

Covered by `tests/integration/game-ops.test.ts` (Step 5d suite: sprite attach +
missing-node, mesh-library export + clobber guard, signal connect/list/disconnect
+ arg validation, shader create under approval, theme create+update, generic
resource create/set/read + arg validation, and `game_locale` no-game error).
Verification: typecheck, lint, `npm test` (29 files, 279 tests), and build all
green; the schema-lock guard confirms exactly 149 `game_*` tools.

**Other context:**
- CLI flag `--policy <mode>` (readonly | safe | dev | danger) - implemented;
  build + typecheck pass.
- Finding: there is no approve/deny tool over the MCP channel and the client
  does not support elicitation -> CRITICAL approvals are blocked under
  `--no-dashboard` (motivates Step 0).

## Risks & notes

| Risk | Note / mitigation |
| --- | --- |
| 149 tools is a large surface | Phased (Step 1-5); schema-lock + a per-tool test guards each tier. |
| Must ship a GDScript addon | Required by every Godot MCP; FolderForge ships editor plugin + runtime autoload. |
| Runtime tools need a running game | "is game running?" guard mirroring `isEnabled('playwright')`. |
| CRITICAL blocked under `--no-dashboard` | Do Step 0 first to provide an approve channel over MCP. |
| Networking tools reach the host | All CRITICAL + approval-gated; blocked outside `danger`/explicit approval. |
| Editor APIs differ across Godot minor versions | Recommend Godot 4.4+ (UID features need 4.4+). |
| Tool surface is frozen | Every new tool must update `schema-lock.ts`. |

## Open decisions

- [ ] Start Step 0 + Step 1 now (recommended).
- [ ] Editor WS port (6550) and runtime TCP port (9090) - keep community convention?
- [ ] Addon name `folderforge_bridge` - OK?
- [ ] `game_call_method` / `game_eval` stay CRITICAL even in `danger`, or drop to
  HIGH under `danger`?
- [ ] Normalize all names to `game_*` (recommended) vs. mirror reference names
  exactly (`read_scene`, ...) for drop-in familiarity?

## Session Handoff

**Updated:** 2026-06-29 - Step 5d session (149/149 complete).

### Context snapshot

Things this session discovered/decided that are NOT obvious from the code:

- **Plan status: DONE.** The 1.5 Godot plan (full parity = 149 `game_*` tools)
  is now fully delivered. The `schema-lock.test.ts` guard test is the source of
  truth for "is the surface complete": it fails CI if the live registry diverges
  from `FROZEN_TOOLS`. `grep -c "name: 'game_" src/tools/schema-lock.ts` == 149.
- **Step 5d was implemented entirely as headless CLI text edits**, not engine
  calls. Six tools (`game_load_sprite`, `game_export_mesh_library`,
  `game_manage_scene_signals`, `game_manage_shader`, `game_manage_theme_resource`,
  `game_manage_resource`) edit `.tscn`/`.tres`/`.gdshader` files directly so they
  work offline with **no Godot binary installed** - this is the project-wide
  convention for the CLI channel and why the whole test suite runs without Godot.
- **`game_export_mesh_library` is a deliberate approximation.** A true
  MeshLibrary normally requires the editor/engine to bake meshes. The headless
  path writes a valid text MeshLibrary resource that *references* the source
  scene, so it produces a real verifiable artifact offline. If a real Godot
  binary becomes available, this is the first tool to revisit for engine-backed
  baking.
- **`game_locale` is the only Step 5d tool on the RUN channel** (needs a live
  game). Its test only asserts the structured "no game running" error, mirroring
  every other runtime tool - the RUN channel is never unit-tested against a real
  engine, only against the fake TCP bridge or the not-running path.
- **`game_manage_shader` is CRITICAL** (it writes executable GPU code) and stays
  approval-gated even in `danger` mode - tests must pre-approve it via
  `approvals.create(...).id` + `approvals.approve(id, 'session')`, same pattern
  as `game_eval` / `game_create_project`.
- **Adding any `game_*` tool requires four synchronized edits**, in this order:
  `packages/adapter-godot/src/cli.ts` (or `runtime.ts`) -> `src/tools/game-tools.ts`
  (register) -> `src/policy/risk.ts` (risk band) -> `src/tools/schema-lock.ts`
  (frozen entry). Forgetting the schema-lock entry fails the guard test; that is
  by design.
- The shared `.tres` `[resource]`-block upsert helper (`upsertResourceProperty`
  in `cli.ts`) is reused by both theme and generic-resource management - changing
  it affects both.

### Next actions

The plan is complete, so these are proposals based on the codebase state
(priority order):

1. **Tag the release.** Bump `package.json` (currently 1.4.3) to **1.5.0** and
   move the `[Unreleased]` CHANGELOG block under a `## [1.5.0]` heading - the
   149/149 milestone is a clean release point. (Low risk; docs/build already
   green.)
2. **Resolve the open decisions** still listed above before users adopt the
   addon: confirm ports (6550/9090), the `folderforge_bridge` addon name, and
   whether `game_eval`/`game_call_method` stay CRITICAL in `danger`. These are
   user-facing API/contract choices, best locked before 1.5.0 ships.
3. **Ship the GDScript addon** (`addons/folderforge_bridge/`, wiring point #8) -
   **Done.** The editor plugin (`plugin.gd`, registers the `FolderForgeBridge`
   autoload), the runtime autoload (`runtime_bridge.gd`, loopback JSON/TCP server
   on :9090 implementing the full RUN-channel op set), `plugin.cfg`, and an
   install/protocol/security `README.md` are all in the tree, and the addon has
   now been validated against a real engine (see #4).
4. **End-to-end smoke test with a real Godot binary** - **Done (2026-06-29).**
   Ran on the MCP host against Godot **4.4.1-stable** (headless): a test project
   with the addon copied in, imported, then launched with a 14-check smoke client
   covering ping/liveness, scene-tree/UI/group/class inspection, performance,
   set/get property round-trip, call_method, eval, get_node_info, os_info,
   spawn_node, and structured-error paths (unknown op, bad node path) - **14/14
   passed.** The run surfaced one bug: `_dispatch` can suspend (via
   `wait`/`await_signal`), so it is a coroutine; `_handle_line` now `await`s it
   (`var res = await _dispatch(...)`), which fixed the autoload parse/load
   failure. The live RUN channel is now proven end-to-end, not just against the
   fake bridge.
5. Revisit `game_export_mesh_library` for engine-backed baking (see context).
