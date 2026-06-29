extends Node

## FolderForge runtime bridge (autoload singleton, RUN channel).
##
## Runs inside the LIVE game and exposes a tiny line-delimited JSON protocol over
## TCP so the FolderForge MCP server (src/adapters/godot/runtime.ts) can drive and
## introspect the running process for the game_* RUN-channel tools.
##
## Wire protocol (one JSON object per line, UTF-8, '\n' delimited):
##   request : {"id": <int>, "op": "<name>", "params": { ... }}
##   response: {"id": <int>, "ok": true,  "data": <any>}
##          or {"id": <int>, "ok": false, "error": "<message>"}
##
## Design:
##  - One TCP listener; each accepted peer is serviced line-by-line. The adapter
##    opens a short-lived connection per call, so peers come and go freely.
##  - Every op is wrapped: a thrown/invalid path yields {ok:false,error:...},
##    never a crash. "Is the game running?" is answered simply by whether this
##    server accepts the connection at all.
##  - Errors and prints are captured into ring buffers for get_errors/get_logs.

const DEFAULT_PORT := 9090
const BIND_HOST := "127.0.0.1"
const MAX_LOG := 500
const MAX_ERRORS := 500
const RECV_CHUNK := 65536

var _server := TCPServer.new()
var _peers: Array[StreamPeerTCP] = []
var _peer_buffers: Dictionary = {}            # peer -> String (pending bytes)
var _logs: Array[String] = []
var _errors: Array[String] = []
var _port := DEFAULT_PORT


func _ready() -> void:
	# Allow override via env or project setting; fall back to the default port.
	var env_port := OS.get_environment("FOLDERFORGE_RUNTIME_PORT")
	if env_port != "" and env_port.is_valid_int():
		_port = int(env_port)
	elif ProjectSettings.has_setting("folderforge/runtime_port"):
		_port = int(ProjectSettings.get_setting("folderforge/runtime_port"))

	var err := _server.listen(_port, BIND_HOST)
	if err != OK:
		push_warning("FolderForge bridge: could not listen on %s:%d (err %d)" % [BIND_HOST, _port, err])
		return
	_log("FolderForge bridge listening on %s:%d" % [BIND_HOST, _port])
	# Process even while the SceneTree is paused so pause/resume stays controllable.
	process_mode = Node.PROCESS_MODE_ALWAYS


func _notification(what: int) -> void:
	if what == NOTIFICATION_PREDELETE:
		for p in _peers:
			p.disconnect_from_host()
		if _server.is_listening():
			_server.stop()


func _process(_delta: float) -> void:
	# Accept new peers.
	while _server.is_listening() and _server.is_connection_available():
		var peer := _server.take_connection()
		if peer != null:
			_peers.append(peer)
			_peer_buffers[peer] = ""

	# Service existing peers.
	var still: Array[StreamPeerTCP] = []
	for peer in _peers:
		peer.poll()
		var st := peer.get_status()
		if st == StreamPeerTCP.STATUS_CONNECTED:
			_pump_peer(peer)
			still.append(peer)
		elif st == StreamPeerTCP.STATUS_CONNECTING:
			still.append(peer)
		else:
			_peer_buffers.erase(peer)
	_peers = still


func _pump_peer(peer: StreamPeerTCP) -> void:
	var avail := peer.get_available_bytes()
	if avail > 0:
		var got := peer.get_partial_data(min(avail, RECV_CHUNK))
		if got[0] == OK:
			var bytes: PackedByteArray = got[1]
			_peer_buffers[peer] += bytes.get_string_from_utf8()
	var buf: String = _peer_buffers[peer]
	while true:
		var nl := buf.find("\n")
		if nl < 0:
			break
		var line := buf.substr(0, nl).strip_edges()
		buf = buf.substr(nl + 1)
		if line != "":
			_handle_line(peer, line)
	_peer_buffers[peer] = buf


func _handle_line(peer: StreamPeerTCP, line: String) -> void:
	var json := JSON.new()
	if json.parse(line) != OK or typeof(json.data) != TYPE_DICTIONARY:
		_send(peer, {"ok": false, "error": "Malformed request (expected one JSON object per line)."})
		return
	var req: Dictionary = json.data
	var id = req.get("id", null)
	var op := str(req.get("op", ""))
	var params: Dictionary = req.get("params", {}) if typeof(req.get("params")) == TYPE_DICTIONARY else {}
	var res := _dispatch(op, params)
	if typeof(res) == TYPE_DICTIONARY and res.has("ok"):
		res["id"] = id
		_send(peer, res)
	else:
		_send(peer, {"id": id, "ok": true, "data": res})


func _send(peer: StreamPeerTCP, obj: Dictionary) -> void:
	var text := JSON.stringify(obj) + "\n"
	peer.put_data(text.to_utf8_buffer())


# --------------------------------------------------------------------------
# Dispatch
# --------------------------------------------------------------------------

func _ok(data = null) -> Dictionary:
	return {"ok": true, "data": data}


func _err(msg: String) -> Dictionary:
	return {"ok": false, "error": msg}


## Resolve a NodePath string against the live tree. Accepts absolute paths and
## paths relative to the current scene root.
func _node(path_str: String) -> Node:
	if path_str == "" or path_str == "/" or path_str == "/root":
		return get_tree().root
	var n := get_node_or_null(NodePath(path_str))
	if n != null:
		return n
	var scene := get_tree().current_scene
	if scene != null:
		if scene.name == path_str:
			return scene
		n = scene.get_node_or_null(NodePath(path_str))
		if n != null:
			return n
	return get_tree().root.get_node_or_null(NodePath(path_str))


func _dispatch(op: String, p: Dictionary):
	match op:
		# -- liveness / read tier ------------------------------------------
		"ping":
			return _ok({"pong": true, "engine": Engine.get_version_info()})
		"get_scene_tree":
			return _op_scene_tree(p)
		"get_node_info":
			return _op_node_info(p)
		"get_ui":
			return _op_get_ui(p)
		"performance":
			return _op_performance()
		"get_nodes_in_group":
			return _op_nodes_in_group(p)
		"find_nodes_by_class":
			return _op_find_by_class(p)
		"get_errors":
			var out := _errors.duplicate()
			_errors.clear()
			return _ok(out)
		"get_logs":
			var n := int(p.get("lines", _logs.size()))
			var start := max(0, _logs.size() - n)
			return _ok(_logs.slice(start, _logs.size()))
		"get_property":
			return _op_get_property(p)
		"get_camera":
			return _op_get_camera(p)
		"get_audio":
			return _op_get_audio(p)
		"os_info":
			return _ok(_os_info())
		"input_state":
			return _ok(_input_state())
		"list_signals":
			return _op_list_signals(p)
		"serialize_state":
			return _op_serialize_state(p)

		# -- control / mutation --------------------------------------------
		"pause":
			get_tree().paused = bool(p.get("paused", true))
			return _ok({"paused": get_tree().paused})
		"wait":
			return await _op_wait(p)
		"time_scale":
			Engine.time_scale = float(p.get("scale", 1.0))
			return _ok({"timeScale": Engine.time_scale})
		"eval":
			return _op_eval(p)
		"set_property":
			return _op_set_property(p)
		"call_method":
			return _op_call_method(p)
		"spawn_node":
			return _op_spawn_node(p)
		"remove_node":
			return _op_remove_node(p)
		"reparent_node":
			return _op_reparent_node(p)
		"instantiate_scene":
			return _op_instantiate_scene(p)
		"change_scene":
			return _op_change_scene(p)
		"screenshot":
			return _op_screenshot(p)

		# -- signals --------------------------------------------------------
		"connect_signal":
			return _op_connect_signal(p)
		"disconnect_signal":
			return _op_disconnect_signal(p)
		"emit_signal":
			return _op_emit_signal(p)
		"await_signal":
			return await _op_await_signal(p)

		# -- groups ---------------------------------------------------------
		"manage_group":
			return _op_manage_group(p)

		# -- input injection ------------------------------------------------
		"key_press", "key_release", "key_hold":
			return _op_key(op, p)
		"input_action":
			return _op_input_action(p)
		"click":
			return _op_click(p)
		"mouse_move":
			return _op_mouse_move(p)
		"mouse_drag":
			return _op_mouse_drag(p)
		"scroll":
			return _op_scroll(p)
		"touch":
			return _op_touch(p)

		# -- animation / audio (generic property/method routing) -----------
		"play_animation":
			return _op_play_animation(p)
		"animation_control":
			return _op_animation_control(p)
		"audio_play":
			return _op_audio_play(p)
		"audio_bus", "audio_bus_layout":
			return _op_audio_bus(p)

		# -- window / world -------------------------------------------------
		"window":
			return _op_window(p)
		"world_settings", "render_settings", "environment":
			return _op_world_or_render(op, p)
		"process_mode":
			return _op_process_mode(p)

		# -- generic property setters on a node ----------------------------
		"set_camera", "set_particles", "set_shader_param", "viewport", \
		"camera_attributes", "canvas", "parallax", "audio_spatial", \
		"animation_tree", "light_2d", "light_3d":
			return _op_generic_node_property(p)

		"locale":
			TranslationServer.set_locale(str(p.get("locale", "en")))
			return _ok({"locale": TranslationServer.get_locale()})

		_:
			# Unknown / not-yet-specialised op. Try a best-effort generic route
			# if it carries (path, property, value); otherwise report clearly.
			if p.has("path") and p.has("property"):
				return _op_generic_node_property(p)
			return _err("Unsupported runtime op: '%s'. The bridge does not implement this command." % op)


# --------------------------------------------------------------------------
# Read-tier handlers
# --------------------------------------------------------------------------

func _op_scene_tree(p: Dictionary) -> Dictionary:
	var max_depth := int(p.get("maxDepth", 64))
	var root := get_tree().current_scene
	if root == null:
		root = get_tree().root
	return _ok(_describe_node(root, 0, max_depth))


func _describe_node(node: Node, depth: int, max_depth: int) -> Dictionary:
	var d := {
		"name": node.name,
		"class": node.get_class(),
		"path": str(node.get_path()),
	}
	if node is CanvasItem:
		d["visible"] = (node as CanvasItem).visible
	if depth < max_depth:
		var kids: Array = []
		for c in node.get_children():
			kids.append(_describe_node(c, depth + 1, max_depth))
		d["children"] = kids
	else:
		d["children_count"] = node.get_child_count()
	return d


func _op_node_info(p: Dictionary) -> Dictionary:
	var node := _node(str(p.get("path", "")))
	if node == null:
		return _err("Node not found: %s" % str(p.get("path", "")))
	var props: Dictionary = {}
	for pi in node.get_property_list():
		if pi.usage & PROPERTY_USAGE_EDITOR and pi.name != "":
			var v = node.get(pi.name)
			if _is_jsonable(v):
				props[pi.name] = _to_jsonable(v)
	var children: Array = []
	for c in node.get_children():
		children.append(str(c.name))
	return _ok({
		"name": node.name,
		"class": node.get_class(),
		"path": str(node.get_path()),
		"properties": props,
		"children": children,
		"groups": node.get_groups(),
	})


func _op_get_ui(_p: Dictionary) -> Dictionary:
	var root := get_tree().current_scene
	if root == null:
		root = get_tree().root
	return _ok(_describe_controls(root))


func _describe_controls(node: Node):
	var entry := {}
	if node is Control:
		var c := node as Control
		entry = {
			"name": node.name,
			"class": node.get_class(),
			"path": str(node.get_path()),
			"rect": [c.global_position.x, c.global_position.y, c.size.x, c.size.y],
			"visible": c.visible,
		}
		if c is Button:
			entry["text"] = (c as Button).text
		elif c is Label:
			entry["text"] = (c as Label).text
		elif c is LineEdit:
			entry["text"] = (c as LineEdit).text
	var kids: Array = []
	for child in node.get_children():
		var sub = _describe_controls(child)
		if sub != null:
			kids.append(sub)
	if entry.is_empty():
		# Pass through non-Control containers but keep their Control descendants.
		if kids.is_empty():
			return null
		return {"name": node.name, "class": node.get_class(), "children": kids}
	if not kids.is_empty():
		entry["children"] = kids
	return entry


func _op_performance() -> Dictionary:
	return _ok({
		"fps": Performance.get_monitor(Performance.TIME_FPS),
		"frameTimeMs": Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0,
		"physicsTimeMs": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0,
		"staticMemory": Performance.get_monitor(Performance.MEMORY_STATIC),
		"objectCount": Performance.get_monitor(Performance.OBJECT_COUNT),
		"nodeCount": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
		"drawCalls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
	})


func _op_nodes_in_group(p: Dictionary) -> Dictionary:
	var group := str(p.get("group", ""))
	var paths: Array = []
	for n in get_tree().get_nodes_in_group(group):
		paths.append(str(n.get_path()))
	return _ok(paths)


func _op_find_by_class(p: Dictionary) -> Dictionary:
	var cls := str(p.get("className", ""))
	var paths: Array = []
	_collect_by_class(get_tree().root, cls, paths)
	return _ok(paths)


func _collect_by_class(node: Node, cls: String, out: Array) -> void:
	if node.is_class(cls) or node.get_class() == cls:
		out.append(str(node.get_path()))
	for c in node.get_children():
		_collect_by_class(c, cls, out)


func _op_get_property(p: Dictionary) -> Dictionary:
	var node := _node(str(p.get("path", "")))
	if node == null:
		return _err("Node not found: %s" % str(p.get("path", "")))
	var prop := str(p.get("property", ""))
	var v = node.get_indexed(NodePath(prop))
	return _ok({"property": prop, "value": _to_jsonable(v)})


func _op_get_camera(p: Dictionary) -> Dictionary:
	var node := _node(str(p.get("path", ""))) if p.has("path") else null
	if node == null:
		var cam2d := get_viewport().get_camera_2d()
		var cam3d := get_viewport().get_camera_3d()
		node = cam3d if cam3d != null else cam2d
	if node == null:
		return _err("No active camera found.")
	return _op_node_info({"path": str(node.get_path())})


func _op_get_audio(p: Dictionary) -> Dictionary:
	var bus_name := str(p.get("bus", "Master"))
	var idx := AudioServer.get_bus_index(bus_name)
	if idx < 0:
		return _err("Audio bus not found: %s" % bus_name)
	return _ok({
		"bus": bus_name,
		"volumeDb": AudioServer.get_bus_volume_db(idx),
		"muted": AudioServer.is_bus_mute(idx),
		"solo": AudioServer.is_bus_solo(idx),
	})


func _op_list_signals(p: Dictionary) -> Dictionary:
	var node := _node(str(p.get("path", "")))
	if node == null:
		return _err("Node not found: %s" % str(p.get("path", "")))
	var sigs: Array = []
	for s in node.get_signal_list():
		sigs.append(s.name)
	return _ok(sigs)


func _op_serialize_state(p: Dictionary) -> Dictionary:
	var node := _node(str(p.get("path", "")))
	if node == null:
		return _err("Node not found: %s" % str(p.get("path", "")))
	return _op_node_info({"path": str(node.get_path())})


# --------------------------------------------------------------------------
# Control / mutation handlers
# --------------------------------------------------------------------------

func _op_wait(p: Dictionary) -> Dictionary:
	var seconds := float(p.get("seconds", 0.0))
	if seconds > 0.0:
		await get_tree().create_timer(seconds, true, false, true).timeout
	else:
		await get_tree().process_frame
	return _ok({"waited": seconds})


func _op_eval(p: Dictionary) -> Dictionary:
	var code := str(p.get("code", ""))
	if code == "":
		return _err("eval requires non-empty 'code'.")
	var expr := Expression.new()
	if expr.parse(code, ["tree", "root"]) != OK:
		return _err("Parse error: %s" % expr.get_error_text())
	var result = expr.execute([get_tree(), get_tree().root], self, true)
	if expr.has_execute_failed():
		return _err("Execution failed: %s" % expr.get_error_text())
	return _ok({"result": _to_jsonable(result)})


func _op_set_property(p: Dictionary) -> Dictionary:
	var node := _node(str(p.get("path", "")))
	if node == null:
		return _err("Node not found: %s" % str(p.get("path", "")))
	var prop := str(p.get("property", ""))
	node.set_indexed(NodePath(prop), _from_param(p.get("value")))
	return _ok({"property": prop, "value": _to_jsonable(node.get_indexed(NodePath(prop)))})


func _op_generic_node_property(p: Dictionary) -> Dictionary:
	# Used by light/camera/particles/shader/viewport/etc. ops that all reduce to
	# "set <property> on <path>". shader params route through set_shader_parameter.
	var node := _node(str(p.get("path", "")))
	if node == null:
		return _err("Node not found: %s" % str(p.get("path", "")))
	var value = _from_param(p.get("value"))
	if p.has("parameter"):
		var param := str(p.get("parameter"))
		var mat = node.get("material_override") if "material_override" in node else null
		if mat == null and "material" in node:
			mat = node.get("material")
		if mat is ShaderMaterial:
			(mat as ShaderMaterial).set_shader_parameter(param, value)
			return _ok({"parameter": param})
		return _err("Node has no ShaderMaterial for parameter '%s'." % param)
	var prop := str(p.get("property", ""))
	if prop == "":
		return _err("Missing 'property'.")
	node.set_indexed(NodePath(prop), value)
	return _ok({"property": prop})


func _op_call_method(p: Dictionary) -> Dictionary:
	var node := _node(str(p.get("path", "")))
	if node == null:
		return _err("Node not found: %s" % str(p.get("path", "")))
	var method := str(p.get("method", ""))
	if not node.has_method(method):
		return _err("Node has no method '%s'." % method)
	var args: Array = p.get("args", []) if typeof(p.get("args")) == TYPE_ARRAY else []
	var conv: Array = []
	for a in args:
		conv.append(_from_param(a))
	var r = node.callv(method, conv)
	return _ok({"result": _to_jsonable(r)})


func _op_spawn_node(p: Dictionary) -> Dictionary:
	var type_name := str(p.get("type", "Node"))
	if not ClassDB.can_instantiate(type_name):
		return _err("Cannot instantiate class '%s'." % type_name)
	var node: Node = ClassDB.instantiate(type_name)
	if node == null:
		return _err("Instantiation returned null for '%s'." % type_name)
	if p.has("name"):
		node.name = str(p.get("name"))
	var props = p.get("properties", {})
	if typeof(props) == TYPE_DICTIONARY:
		for k in props:
			node.set(k, _from_param(props[k]))
	var parent := _node(str(p.get("parent", ""))) if p.has("parent") else get_tree().current_scene
	if parent == null:
		parent = get_tree().current_scene if get_tree().current_scene != null else get_tree().root
	parent.add_child(node)
	return _ok({"path": str(node.get_path())})


func _op_remove_node(p: Dictionary) -> Dictionary:
	var node := _node(str(p.get("path", "")))
	if node == null:
		return _err("Node not found: %s" % str(p.get("path", "")))
	node.queue_free()
	return _ok({"removed": str(p.get("path", ""))})


func _op_reparent_node(p: Dictionary) -> Dictionary:
	var node := _node(str(p.get("path", "")))
	var new_parent := _node(str(p.get("newParent", "")))
	if node == null or new_parent == null:
		return _err("Node or newParent not found.")
	node.reparent(new_parent)
	return _ok({"path": str(node.get_path())})


func _op_instantiate_scene(p: Dictionary) -> Dictionary:
	var scene_path := str(p.get("scenePath", ""))
	if not ResourceLoader.exists(scene_path):
		return _err("Scene not found: %s" % scene_path)
	var packed = load(scene_path)
	if packed == null or not (packed is PackedScene):
		return _err("Not a PackedScene: %s" % scene_path)
	var inst := (packed as PackedScene).instantiate()
	var parent := _node(str(p.get("parent", ""))) if p.has("parent") else get_tree().current_scene
	if parent == null:
		parent = get_tree().root
	parent.add_child(inst)
	return _ok({"path": str(inst.get_path())})


func _op_change_scene(p: Dictionary) -> Dictionary:
	var scene_path := str(p.get("scenePath", ""))
	if not ResourceLoader.exists(scene_path):
		return _err("Scene not found: %s" % scene_path)
	var err := get_tree().change_scene_to_file(scene_path)
	if err != OK:
		return _err("change_scene failed (err %d)" % err)
	return _ok({"scene": scene_path})


func _op_screenshot(p: Dictionary) -> Dictionary:
	var img := get_viewport().get_texture().get_image()
	var out_path := str(p.get("path", "user://folderforge_screenshot.png"))
	var err := img.save_png(out_path)
	if err != OK:
		return _err("Could not save screenshot to %s (err %d)" % [out_path, err])
	return _ok({"path": out_path, "width": img.get_width(), "height": img.get_height()})


# --------------------------------------------------------------------------
# Signals
# --------------------------------------------------------------------------

func _op_connect_signal(p: Dictionary) -> Dictionary:
	var node := _node(str(p.get("path", "")))
	var target := _node(str(p.get("target", "")))
	if node == null or target == null:
		return _err("Source or target node not found.")
	var sig := str(p.get("signal", ""))
	var method := str(p.get("method", ""))
	if not target.has_method(method):
		return _err("Target has no method '%s'." % method)
	var err := node.connect(sig, Callable(target, method))
	if err != OK:
		return _err("connect failed (err %d)" % err)
	return _ok({"connected": "%s.%s -> %s.%s" % [node.name, sig, target.name, method]})


func _op_disconnect_signal(p: Dictionary) -> Dictionary:
	var node := _node(str(p.get("path", "")))
	var target := _node(str(p.get("target", "")))
	if node == null or target == null:
		return _err("Source or target node not found.")
	var sig := str(p.get("signal", ""))
	var method := str(p.get("method", ""))
	var cb := Callable(target, method)
	if node.is_connected(sig, cb):
		node.disconnect(sig, cb)
		return _ok({"disconnected": true})
	return _err("Signal '%s' was not connected to %s.%s." % [sig, target.name, method])


func _op_emit_signal(p: Dictionary) -> Dictionary:
	var node := _node(str(p.get("path", "")))
	if node == null:
		return _err("Node not found: %s" % str(p.get("path", "")))
	var sig := str(p.get("signal", ""))
	var args: Array = p.get("args", []) if typeof(p.get("args")) == TYPE_ARRAY else []
	var conv: Array = []
	for a in args:
		conv.append(_from_param(a))
	node.callv("emit_signal", [sig] + conv)
	return _ok({"emitted": sig})


func _op_await_signal(p: Dictionary) -> Dictionary:
	var node := _node(str(p.get("path", "")))
	if node == null:
		return _err("Node not found: %s" % str(p.get("path", "")))
	var sig := str(p.get("signal", ""))
	await Signal(node, sig)
	return _ok({"received": sig})


func _op_manage_group(p: Dictionary) -> Dictionary:
	var node := _node(str(p.get("path", "")))
	if node == null:
		return _err("Node not found: %s" % str(p.get("path", "")))
	var group := str(p.get("group", ""))
	var action := str(p.get("action", "add"))
	match action:
		"add":
			node.add_to_group(group)
		"remove":
			node.remove_from_group(group)
		_:
			return _err("Unknown group action: %s" % action)
	return _ok({"group": group, "action": action, "inGroup": node.is_in_group(group)})


# --------------------------------------------------------------------------
# Input injection
# --------------------------------------------------------------------------

func _op_key(op: String, p: Dictionary) -> Dictionary:
	var key_name := str(p.get("key", ""))
	var keycode := OS.find_keycode_from_string(key_name)
	if keycode == KEY_NONE:
		return _err("Unknown key: %s" % key_name)
	var pressed := op != "key_release"
	var ev := InputEventKey.new()
	ev.keycode = keycode
	ev.physical_keycode = keycode
	ev.pressed = pressed
	Input.parse_input_event(ev)
	if op == "key_hold":
		return _ok({"key": key_name, "held": true})
	return _ok({"key": key_name, "pressed": pressed})


func _op_input_action(p: Dictionary) -> Dictionary:
	var action := str(p.get("action", ""))
	if not InputMap.has_action(action):
		return _err("Input action not defined: %s" % action)
	var pressed := bool(p.get("pressed", true))
	if pressed:
		Input.action_press(action, float(p.get("strength", 1.0)))
	else:
		Input.action_release(action)
	return _ok({"action": action, "pressed": pressed})


func _op_click(p: Dictionary) -> Dictionary:
	var pos := Vector2(float(p.get("x", 0)), float(p.get("y", 0)))
	var button := _mouse_button(str(p.get("button", "left")))
	for state in [true, false]:
		var ev := InputEventMouseButton.new()
		ev.position = pos
		ev.global_position = pos
		ev.button_index = button
		ev.pressed = state
		Input.parse_input_event(ev)
	return _ok({"clicked": [pos.x, pos.y]})


func _op_mouse_move(p: Dictionary) -> Dictionary:
	var pos := Vector2(float(p.get("x", 0)), float(p.get("y", 0)))
	var ev := InputEventMouseMotion.new()
	ev.position = pos
	ev.global_position = pos
	Input.parse_input_event(ev)
	return _ok({"moved": [pos.x, pos.y]})


func _op_mouse_drag(p: Dictionary) -> Dictionary:
	var from := Vector2(float(p.get("fromX", 0)), float(p.get("fromY", 0)))
	var to := Vector2(float(p.get("toX", 0)), float(p.get("toY", 0)))
	var button := _mouse_button(str(p.get("button", "left")))
	var down := InputEventMouseButton.new()
	down.position = from; down.global_position = from
	down.button_index = button; down.pressed = true
	Input.parse_input_event(down)
	var motion := InputEventMouseMotion.new()
	motion.position = to; motion.global_position = to
	motion.relative = to - from
	Input.parse_input_event(motion)
	var up := InputEventMouseButton.new()
	up.position = to; up.global_position = to
	up.button_index = button; up.pressed = false
	Input.parse_input_event(up)
	return _ok({"dragged": [[from.x, from.y], [to.x, to.y]]})


func _op_scroll(p: Dictionary) -> Dictionary:
	var amount := float(p.get("amount", 1.0))
	var pos := Vector2(float(p.get("x", 0)), float(p.get("y", 0)))
	var button := MOUSE_BUTTON_WHEEL_UP if amount >= 0 else MOUSE_BUTTON_WHEEL_DOWN
	var ev := InputEventMouseButton.new()
	ev.position = pos; ev.global_position = pos
	ev.button_index = button; ev.pressed = true
	ev.factor = abs(amount)
	Input.parse_input_event(ev)
	return _ok({"scrolled": amount})


func _op_touch(p: Dictionary) -> Dictionary:
	var pos := Vector2(float(p.get("x", 0)), float(p.get("y", 0)))
	var ev := InputEventScreenTouch.new()
	ev.position = pos
	ev.pressed = bool(p.get("pressed", true))
	ev.index = int(p.get("index", 0))
	Input.parse_input_event(ev)
	return _ok({"touch": [pos.x, pos.y], "pressed": ev.pressed})


func _mouse_button(name: String) -> int:
	match name.to_lower():
		"right":
			return MOUSE_BUTTON_RIGHT
		"middle":
			return MOUSE_BUTTON_MIDDLE
		_:
			return MOUSE_BUTTON_LEFT


# --------------------------------------------------------------------------
# Animation / audio / window helpers
# --------------------------------------------------------------------------

func _op_play_animation(p: Dictionary) -> Dictionary:
	var node := _node(str(p.get("path", "")))
	if node == null or not node.has_method("play"):
		return _err("AnimationPlayer not found at: %s" % str(p.get("path", "")))
	var anim := str(p.get("animation", ""))
	if "speed_scale" in node and p.has("speed"):
		node.set("speed_scale", float(p.get("speed", 1.0)))
	node.call("play", anim)
	return _ok({"playing": anim})


func _op_animation_control(p: Dictionary) -> Dictionary:
	var node := _node(str(p.get("path", "")))
	if node == null:
		return _err("Node not found: %s" % str(p.get("path", "")))
	var action := str(p.get("action", "play"))
	match action:
		"play":
			if node.has_method("play"):
				node.call("play")
		"pause":
			if node.has_method("pause"):
				node.call("pause")
		"stop":
			if node.has_method("stop"):
				node.call("stop")
		"seek":
			if node.has_method("seek"):
				node.call("seek", float(p.get("time", 0.0)), true)
		_:
			return _err("Unknown animation action: %s" % action)
	return _ok({"action": action})


func _op_audio_play(p: Dictionary) -> Dictionary:
	var node := _node(str(p.get("path", "")))
	if node == null:
		return _err("Audio player node not found: %s" % str(p.get("path", "")))
	if p.has("stream"):
		var stream_path := str(p.get("stream"))
		if ResourceLoader.exists(stream_path):
			node.set("stream", load(stream_path))
	if p.has("bus") and "bus" in node:
		node.set("bus", str(p.get("bus")))
	if node.has_method("play"):
		node.call("play")
	return _ok({"playing": true})


func _op_audio_bus(p: Dictionary) -> Dictionary:
	var bus_name := str(p.get("bus", "Master"))
	var idx := AudioServer.get_bus_index(bus_name)
	if idx < 0:
		return _err("Audio bus not found: %s" % bus_name)
	if p.has("volumeDb"):
		AudioServer.set_bus_volume_db(idx, float(p.get("volumeDb")))
	if p.has("mute"):
		AudioServer.set_bus_mute(idx, bool(p.get("mute")))
	if p.has("solo"):
		AudioServer.set_bus_solo(idx, bool(p.get("solo")))
	return _op_get_audio({"bus": bus_name})


func _op_window(p: Dictionary) -> Dictionary:
	var win := get_window()
	var prop := str(p.get("property", ""))
	var value = _from_param(p.get("value"))
	match prop:
		"title":
			win.title = str(value)
		"size":
			win.size = _to_vector2i(value)
		"position":
			win.position = _to_vector2i(value)
		"mode":
			win.mode = int(value)
		"fullscreen":
			win.mode = Window.MODE_FULLSCREEN if bool(value) else Window.MODE_WINDOWED
		_:
			if prop != "":
				win.set(prop, value)
	return _ok({"property": prop})


func _op_world_or_render(op: String, p: Dictionary) -> Dictionary:
	# Apply to the active 3D environment when available; otherwise record intent.
	var prop := str(p.get("property", ""))
	var value = _from_param(p.get("value"))
	var cam := get_viewport().get_camera_3d()
	var env: Environment = null
	if cam != null and cam.environment != null:
		env = cam.environment
	if env == null:
		var world := get_viewport().world_3d if get_viewport().world_3d else null
		if world != null:
			env = world.environment
	if env != null and prop != "":
		env.set(prop, value)
		return _ok({"property": prop, "applied": true})
	return _ok({"op": op, "property": prop, "applied": false, "note": "No active Environment to apply to."})


func _op_process_mode(p: Dictionary) -> Dictionary:
	var node := _node(str(p.get("path", "")))
	if node == null:
		return _err("Node not found: %s" % str(p.get("path", "")))
	node.process_mode = int(p.get("mode", Node.PROCESS_MODE_INHERIT))
	return _ok({"processMode": node.process_mode})


# --------------------------------------------------------------------------
# Conversion + logging helpers
# --------------------------------------------------------------------------

func _os_info() -> Dictionary:
	return {
		"name": OS.get_name(),
		"model": OS.get_model_name(),
		"locale": OS.get_locale(),
		"processorCount": OS.get_processor_count(),
		"videoAdapter": RenderingServer.get_video_adapter_name(),
		"engineVersion": Engine.get_version_info(),
	}


func _input_state() -> Dictionary:
	return {
		"mousePosition": [get_viewport().get_mouse_position().x, get_viewport().get_mouse_position().y],
		"mouseButtonMask": Input.get_mouse_button_mask(),
		"pressedActions": _pressed_actions(),
	}


func _pressed_actions() -> Array:
	var out: Array = []
	for a in InputMap.get_actions():
		if Input.is_action_pressed(a):
			out.append(str(a))
	return out


func _to_vector2i(v) -> Vector2i:
	if typeof(v) == TYPE_ARRAY and v.size() >= 2:
		return Vector2i(int(v[0]), int(v[1]))
	if v is Vector2:
		return Vector2i(v)
	return Vector2i.ZERO


## Convert a JSON-supplied param into a Godot value. Arrays of 2/3/4 numbers are
## left as arrays (callers that need vectors convert explicitly); everything else
## passes through. Strings beginning with "res://" or "user://" stay as paths.
func _from_param(v):
	return v


## Make an arbitrary Godot value JSON-serialisable for the response.
func _to_jsonable(v):
	match typeof(v):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING, TYPE_STRING_NAME:
			return v if typeof(v) != TYPE_STRING_NAME else str(v)
		TYPE_VECTOR2, TYPE_VECTOR2I:
			return [v.x, v.y]
		TYPE_VECTOR3, TYPE_VECTOR3I:
			return [v.x, v.y, v.z]
		TYPE_VECTOR4, TYPE_VECTOR4I:
			return [v.x, v.y, v.z, v.w]
		TYPE_COLOR:
			return [v.r, v.g, v.b, v.a]
		TYPE_RECT2, TYPE_RECT2I:
			return [v.position.x, v.position.y, v.size.x, v.size.y]
		TYPE_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY, \
		TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY, TYPE_PACKED_STRING_ARRAY:
			var out: Array = []
			for e in v:
				out.append(_to_jsonable(e))
			return out
		TYPE_DICTIONARY:
			var d := {}
			for k in v:
				d[str(k)] = _to_jsonable(v[k])
			return d
		TYPE_OBJECT:
			if v == null:
				return null
			if v is Node:
				return {"__node": str((v as Node).get_path()), "class": v.get_class()}
			if v is Resource:
				return {"__resource": (v as Resource).resource_path, "class": v.get_class()}
			return {"__object": v.get_class()}
		_:
			return str(v)


func _is_jsonable(v) -> bool:
	var t := typeof(v)
	return t != TYPE_CALLABLE and t != TYPE_SIGNAL and t != TYPE_RID


func _log(msg: String) -> void:
	_logs.append("[%s] %s" % [Time.get_time_string_from_system(), msg])
	if _logs.size() > MAX_LOG:
		_logs = _logs.slice(_logs.size() - MAX_LOG, _logs.size())


func _record_error(msg: String) -> void:
	_errors.append("[%s] %s" % [Time.get_time_string_from_system(), msg])
	if _errors.size() > MAX_ERRORS:
		_errors = _errors.slice(_errors.size() - MAX_ERRORS, _errors.size())
