# FolderForge Bridge (Godot addon)

This addon is the **RUN-channel** piece of the FolderForge Godot integration. It
runs a tiny line-delimited JSON server **inside your live game** so the
FolderForge MCP server can inspect and drive the running process - the part that
makes the `game_*` runtime tools (scene-tree inspection, `game_eval`,
property/signal/input control, screenshots, performance metrics) actually work
against a real engine.

The headless/edit-time tools (create project, edit scenes, scripts, resources,
export) work **without** this addon - they operate on project files directly.
You only need the bridge when you want an agent to control a *running* game.

## Requirements

- Godot **4.2+** (developed against 4.x; uses `TCPServer`, `Expression`,
  `Window`, typed arrays).

## Install

1. Copy the `addons/folderforge_bridge/` folder into your Godot project so the
   path is `res://addons/folderforge_bridge/`.
2. In the editor: **Project > Project Settings > Plugins** and enable
   **FolderForge Bridge**.
   - This registers an autoload singleton named `FolderForgeBridge`, so every
     launched instance of the game starts the server automatically.
3. (Optional) If you don't use the editor plugin, add the autoload manually:
   **Project Settings > Autoload** -> add
   `res://addons/folderforge_bridge/runtime_bridge.gd` with node name
   `FolderForgeBridge`.

## Configuration

The server listens on `127.0.0.1:9090` by default - matching FolderForge's
`adapters.godot.runtimePort`. Override it with either:

- Environment variable: `FOLDERFORGE_RUNTIME_PORT=9100`
- Project setting: `folderforge/runtime_port` (int)

If you change the port, set the same value in FolderForge's config
(`adapters.godot.runtimePort`).

## Wire protocol

Newline-delimited JSON over TCP, one object per line:

```
request : {"id": 1, "op": "get_scene_tree", "params": {"maxDepth": 3}}
response: {"id": 1, "ok": true,  "data": { ... }}
       or {"id": 1, "ok": false, "error": "<message>"}
```

`op: "ping"` is the liveness probe FolderForge uses to answer "is the game
running?". The bridge wraps every op: a bad node path or failed call returns
`{ok:false, error:...}` instead of crashing the game.

## Supported ops

- **Liveness / read:** `ping`, `get_scene_tree`, `get_node_info`, `get_ui`,
  `performance`, `get_nodes_in_group`, `find_nodes_by_class`, `get_errors`,
  `get_logs`, `get_property`, `get_camera`, `get_audio`, `os_info`,
  `input_state`, `list_signals`, `serialize_state`.
- **Control / mutation:** `pause`, `wait`, `time_scale`, `eval`, `set_property`,
  `call_method`, `spawn_node`, `remove_node`, `reparent_node`,
  `instantiate_scene`, `change_scene`, `screenshot`, `process_mode`, `window`,
  `world_settings` / `render_settings` / `environment`, `locale`.
- **Signals:** `connect_signal`, `disconnect_signal`, `emit_signal`,
  `await_signal`, `manage_group`.
- **Input injection:** `key_press` / `key_release` / `key_hold`, `input_action`,
  `click`, `mouse_move`, `mouse_drag`, `scroll`, `touch`.
- **Animation / audio:** `play_animation`, `animation_control`, `audio_play`,
  `audio_bus` / `audio_bus_layout`.
- **Generic node-property ops:** `set_camera`, `set_particles`,
  `set_shader_param`, `viewport`, `camera_attributes`, `canvas`, `parallax`,
  `audio_spatial`, `animation_tree`, `light_2d`, `light_3d`, and any unrecognised
  op that carries `path` + `property` falls back to a node property set.

## Security

- The server binds to **loopback only** (`127.0.0.1`). It is not reachable from
  other machines.
- `eval` runs arbitrary GDScript expressions inside your game. FolderForge
  classifies the corresponding `game_eval` tool as **CRITICAL** and routes it
  through its approval queue. Only run the bridge in development.
