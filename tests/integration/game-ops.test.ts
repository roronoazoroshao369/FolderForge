import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { loadConfig } from '../../src/core/config.js';
import { Container } from '../../src/core/container.js';
import { buildRegistry } from '../../src/tools/index.js';
import type { ToolResult, PolicyMode } from '../../src/core/types.js';

/**
 * Godot integration - Step 1 (adapter + headless read tier).
 *
 * Exercises the six read-only `game_*` tools end-to-end through
 * `registry.call()` against a throwaway Godot project on disk. All of these
 * parse project files directly, so they run without a Godot binary installed
 * (the engine probe degrades gracefully to `available: false`).
 */

function setup(projectRoot: string, mode: PolicyMode = 'dev') {
  const config = loadConfig({ projectRoot });
  config.policy.defaultMode = mode;
  // Enable the Godot adapter so the tools route through the CLI channel.
  config.adapters = {
    ...config.adapters,
    godot: { enabled: true, godotPath: 'godot', editorPort: 6550, runtimePort: 9090 },
  };
  const container = new Container(config);
  container.policy.setMode(mode);
  const registry = buildRegistry(container);
  return { container, registry };
}

function data<T = Record<string, unknown>>(res: ToolResult): T {
  expect(res.ok).toBe(true);
  return res.data as T;
}

const PROJECT_GODOT = `; Engine configuration file.
config_version=5

[application]

config/name="Test Game"
run/main_scene="res://main.tscn"

[rendering]

renderer/rendering_method="gl_compatibility"
`;

const MAIN_TSCN = `[gd_scene load_steps=2 format=3 uid="uid://abc123"]

[ext_resource type="Script" path="res://player.gd" id="1_abc"]

[node name="Main" type="Node2D"]

[node name="Player" type="CharacterBody2D" parent="."]
script = ExtResource("1_abc")

[node name="Sprite" type="Sprite2D" parent="Player"]
`;

describe('game tools integration (Godot Step 1 - read tier)', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'ff-godot-'));
    writeFileSync(join(ws, 'project.godot'), PROJECT_GODOT);
    writeFileSync(join(ws, 'main.tscn'), MAIN_TSCN);
    writeFileSync(join(ws, 'player.gd'), 'extends CharacterBody2D\n\nfunc _ready():\n\tpass\n');
    mkdirSync(join(ws, 'assets'), { recursive: true });
    writeFileSync(join(ws, 'assets', 'icon.svg'), '<svg></svg>');
    // Caches that listing must skip.
    mkdirSync(join(ws, '.godot'), { recursive: true });
    writeFileSync(join(ws, '.godot', 'cache.bin'), 'junk');
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('probes the Godot version, degrading gracefully when absent', async () => {
    const { registry } = setup(ws);
    const res = data<{ available: boolean; path: string }>(
      await registry.call('game_get_godot_version', {})
    );
    // No engine in CI -> available:false, but the call still succeeds.
    expect(typeof res.available).toBe('boolean');
    expect(res.path).toBeTruthy();
  });

  it('reads project metadata from project.godot', async () => {
    const { registry } = setup(ws);
    const res = data<{
      name: string;
      mainScene: string;
      configVersion: number;
      hasProjectFile: boolean;
    }>(await registry.call('game_get_project_info', { projectPath: ws }));
    expect(res.name).toBe('Test Game');
    expect(res.mainScene).toBe('res://main.tscn');
    expect(res.configVersion).toBe(5);
    expect(res.hasProjectFile).toBe(true);
  });

  it('parses a .tscn scene into nodes and resources', async () => {
    const { registry } = setup(ws);
    const res = data<{
      nodeCount: number;
      nodes: Array<{ name: string; type: string | null; parent: string | null }>;
      resources: Array<{ type: string | null; path: string | null }>;
    }>(await registry.call('game_read_scene', { projectPath: ws, scenePath: 'res://main.tscn' }));
    expect(res.nodeCount).toBe(3);
    expect(res.nodes.map((n) => n.name)).toEqual(['Main', 'Player', 'Sprite']);
    expect(res.nodes.find((n) => n.name === 'Player')?.type).toBe('CharacterBody2D');
    expect(res.resources[0]?.path).toBe('res://player.gd');
  });

  it('errors clearly on a missing scene path', async () => {
    const { registry } = setup(ws);
    const res = await registry.call('game_read_scene', { projectPath: ws });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/scenePath is required/i);
  });

  it('reads raw project settings and section list', async () => {
    const { registry } = setup(ws);
    const res = data<{ raw: string; sections: string[] }>(
      await registry.call('game_read_project_settings', { projectPath: ws })
    );
    expect(res.raw).toContain('config/name');
    expect(res.sections).toContain('application');
    expect(res.sections).toContain('rendering');
  });

  it('lists project files with res:// paths and kinds, skipping caches', async () => {
    const { registry } = setup(ws);
    const res = data<{
      count: number;
      files: Array<{ resPath: string; kind: string }>;
    }>(await registry.call('game_list_project_files', { projectPath: ws }));
    const byPath = new Map(res.files.map((f) => [f.resPath, f.kind]));
    expect(byPath.get('res://main.tscn')).toBe('scene');
    expect(byPath.get('res://player.gd')).toBe('script');
    expect(byPath.get('res://assets/icon.svg')).toBe('asset');
    // .godot cache dir is skipped (project.godot itself is fine to include).
    expect([...byPath.keys()].some((p) => p.includes('/.godot/'))).toBe(false);
  });

  it('reads a UTF-8 file from inside the project', async () => {
    const { registry } = setup(ws);
    const res = data<{ resPath: string; content: string; truncated: boolean }>(
      await registry.call('game_read_file', { projectPath: ws, filePath: 'res://player.gd' })
    );
    expect(res.resPath).toBe('res://player.gd');
    expect(res.content).toContain('extends CharacterBody2D');
    expect(res.truncated).toBe(false);
  });

  it('refuses to read a path that escapes the project root', async () => {
    const { registry } = setup(ws);
    const res = await registry.call('game_read_file', {
      projectPath: ws,
      filePath: '../../etc/passwd',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/escape/i);
  });
});

/**
 * Godot integration - Step 2 (headless edit tier).
 *
 * Exercises the mutating `game_*` tools end-to-end. These do text-based edits
 * to project files on disk, so they need no Godot binary. Tests run in `danger`
 * mode so HIGH/CRITICAL tools execute without an approval round-trip; the risk
 * classification and gating itself is covered by the policy unit tests.
 */
describe('game tools integration (Godot Step 2 - edit tier)', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'ff-godot-edit-'));
    writeFileSync(join(ws, 'project.godot'), PROJECT_GODOT);
    writeFileSync(join(ws, 'main.tscn'), MAIN_TSCN);
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('writes a new file and refuses to clobber without overwrite', async () => {
    const { registry } = setup(ws, 'danger');
    const w = data<{ resPath: string; created: boolean }>(
      await registry.call('game_write_file', {
        projectPath: ws,
        filePath: 'res://data/notes.txt',
        content: 'hello',
      })
    );
    expect(w.resPath).toBe('res://data/notes.txt');
    expect(w.created).toBe(true);

    const clobber = await registry.call('game_write_file', {
      projectPath: ws,
      filePath: 'res://data/notes.txt',
      content: 'again',
      overwrite: false,
    });
    expect(clobber.ok).toBe(false);
    expect(clobber.error).toMatch(/exists/i);

    const read = data<{ content: string }>(
      await registry.call('game_read_file', { projectPath: ws, filePath: 'res://data/notes.txt' })
    );
    expect(read.content).toBe('hello');
  });

  it('creates a directory, renames a file, and deletes it', async () => {
    const { container, registry } = setup(ws, 'danger');
    // game_delete_file is CRITICAL: pre-grant a session approval so it runs.
    container.policy.approvals.approve(
      container.policy.approvals.create('game_delete_file', {}, 'CRITICAL', 'test').id,
      'session'
    );
    data(await registry.call('game_create_directory', { projectPath: ws, dirPath: 'res://scenes' }));
    data(
      await registry.call('game_write_file', {
        projectPath: ws,
        filePath: 'res://scenes/a.txt',
        content: 'x',
      })
    );
    const renamed = data<{ from: string; to: string }>(
      await registry.call('game_rename_file', {
        projectPath: ws,
        from: 'res://scenes/a.txt',
        to: 'res://scenes/b.txt',
      })
    );
    expect(renamed.to).toBe('res://scenes/b.txt');

    const del = data<{ resPath: string }>(
      await registry.call('game_delete_file', { projectPath: ws, filePath: 'res://scenes/b.txt' })
    );
    expect(del.resPath).toBe('res://scenes/b.txt');

    const gone = await registry.call('game_read_file', {
      projectPath: ws,
      filePath: 'res://scenes/b.txt',
    });
    expect(gone.ok).toBe(false);
  });

  it('creates a scene, adds, modifies, and removes nodes', async () => {
    const { registry } = setup(ws, 'danger');
    data(
      await registry.call('game_create_scene', {
        projectPath: ws,
        scenePath: 'res://level.tscn',
        rootName: 'Level',
        rootType: 'Node2D',
      })
    );
    data(
      await registry.call('game_add_node', {
        projectPath: ws,
        scenePath: 'res://level.tscn',
        name: 'Hero',
        type: 'CharacterBody2D',
      })
    );
    data(
      await registry.call('game_modify_node', {
        projectPath: ws,
        scenePath: 'res://level.tscn',
        name: 'Hero',
        property: 'position',
        value: 'Vector2(10, 20)',
      })
    );
    const scene = data<{
      nodes: Array<{ name: string; type: string | null }>;
    }>(await registry.call('game_read_scene', { projectPath: ws, scenePath: 'res://level.tscn' }));
    expect(scene.nodes.map((n) => n.name)).toContain('Hero');

    const raw = data<{ content: string }>(
      await registry.call('game_read_file', { projectPath: ws, filePath: 'res://level.tscn' })
    );
    expect(raw.content).toContain('position = Vector2(10, 20)');

    data(
      await registry.call('game_remove_node', {
        projectPath: ws,
        scenePath: 'res://level.tscn',
        name: 'Hero',
      })
    );
    const after = data<{ nodes: Array<{ name: string }> }>(
      await registry.call('game_read_scene', { projectPath: ws, scenePath: 'res://level.tscn' })
    );
    expect(after.nodes.map((n) => n.name)).not.toContain('Hero');
  });

  it('creates a script and attaches it to a node', async () => {
    const { container, registry } = setup(ws, 'danger');
    // game_create_script is CRITICAL: pre-grant a session approval so it runs.
    container.policy.approvals.approve(
      container.policy.approvals.create('game_create_script', {}, 'CRITICAL', 'test').id,
      'session'
    );
    data(
      await registry.call('game_create_script', {
        projectPath: ws,
        scriptPath: 'res://hero.gd',
        extends: 'CharacterBody2D',
      })
    );
    data(
      await registry.call('game_create_scene', {
        projectPath: ws,
        scenePath: 'res://hero.tscn',
        rootName: 'Hero',
        rootType: 'CharacterBody2D',
      })
    );
    const attached = data<{ scriptId: string }>(
      await registry.call('game_attach_script', {
        projectPath: ws,
        scenePath: 'res://hero.tscn',
        name: 'Hero',
        scriptPath: 'res://hero.gd',
      })
    );
    expect(attached.scriptId).toBeTruthy();

    const raw = data<{ content: string }>(
      await registry.call('game_read_file', { projectPath: ws, filePath: 'res://hero.tscn' })
    );
    expect(raw.content).toContain('ext_resource');
    expect(raw.content).toContain('res://hero.gd');
    expect(raw.content).toMatch(/script = ExtResource/);
    expect(raw.content).toMatch(/load_steps=\d+/);
  });

  it('creates a .tres resource with properties', async () => {
    const { registry } = setup(ws, 'danger');
    data(
      await registry.call('game_create_resource', {
        projectPath: ws,
        resPath: 'res://theme.tres',
        type: 'Theme',
        properties: { default_font_size: 16, name: 'Main' },
      })
    );
    const raw = data<{ content: string }>(
      await registry.call('game_read_file', { projectPath: ws, filePath: 'res://theme.tres' })
    );
    expect(raw.content).toContain('[gd_resource type="Theme"');
    expect(raw.content).toContain('default_font_size = 16');
    expect(raw.content).toContain('name = "Main"');
  });

  it('modifies project settings and sets the main scene', async () => {
    const { registry } = setup(ws, 'danger');
    data(
      await registry.call('game_modify_project_settings', {
        projectPath: ws,
        section: 'application',
        key: 'config/name',
        value: 'Renamed Game',
      })
    );
    data(
      await registry.call('game_modify_project_settings', {
        projectPath: ws,
        section: 'display',
        key: 'window/size/viewport_width',
        value: '1280',
      })
    );
    data(
      await registry.call('game_set_main_scene', {
        projectPath: ws,
        scenePath: 'res://level.tscn',
      })
    );
    const info = data<{ name: string; mainScene: string }>(
      await registry.call('game_get_project_info', { projectPath: ws })
    );
    expect(info.name).toBe('Renamed Game');
    expect(info.mainScene).toBe('res://level.tscn');

    const settings = data<{ raw: string; sections: string[] }>(
      await registry.call('game_read_project_settings', { projectPath: ws })
    );
    expect(settings.sections).toContain('display');
    expect(settings.raw).toContain('window/size/viewport_width=1280');
  });

  it('refuses an edit that escapes the project root', async () => {
    const { registry } = setup(ws, 'danger');
    const res = await registry.call('game_write_file', {
      projectPath: ws,
      filePath: '../../tmp/evil.txt',
      content: 'x',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/escape/i);
  });
});

/**
 * Godot integration - Step 3 (runtime read tier, RUN channel).
 *
 * Exercises the runtime `game_*` tools end-to-end against a *fake* TCP runtime
 * bridge: a tiny line-delimited-JSON echo server that stands in for the GDScript
 * autoload running inside a live game. This lets us validate the transport,
 * request framing, response routing, and graceful "no game running" handling
 * without launching Godot.
 */
describe('game tools integration (Godot Step 3 - runtime read tier)', () => {
  let server: Server | null = null;
  let port = 0;
  const sockets = new Set<Socket>();

  /** Spin up a fake runtime bridge that answers ops from `handlers`. */
  async function startBridge(
    handlers: Record<string, (params: Record<string, unknown>) => unknown>
  ): Promise<number> {
    server = createServer((socket) => {
      sockets.add(socket);
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const req = JSON.parse(line) as { id: number; op: string; params: Record<string, unknown> };
          const handler = handlers[req.op];
          if (!handler) {
            socket.write(`${JSON.stringify({ id: req.id, ok: false, error: `unknown op: ${req.op}` })}\n`);
            continue;
          }
          const result = handler(req.params ?? {});
          socket.write(`${JSON.stringify({ id: req.id, ok: true, data: result })}\n`);
        }
      });
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
    });
    await new Promise<void>((res) => server!.listen(0, '127.0.0.1', res));
    const addr = server!.address();
    return typeof addr === 'object' && addr ? addr.port : 0;
  }

  /** Build a registry whose Godot runtimePort points at the fake bridge. */
  function runtimeSetup(runtimePort: number, mode: PolicyMode = 'dev') {
    const config = loadConfig({ projectRoot: tmpdir() });
    config.policy.defaultMode = mode;
    config.adapters = {
      ...config.adapters,
      godot: { enabled: true, godotPath: 'godot', editorPort: 6550, runtimePort },
    };
    const container = new Container(config);
    container.policy.setMode(mode);
    const registry = buildRegistry(container);
    return { container, registry };
  }

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    sockets.clear();
    if (server) {
      await new Promise<void>((res) => server!.close(() => res()));
      server = null;
    }
    port = 0;
  });

  it('reports running:false when no game is reachable', async () => {
    const { registry } = runtimeSetup(59999);
    const res = data<{ running: boolean; port: number }>(
      await registry.call('game_runtime_status', {})
    );
    expect(res.running).toBe(false);
    expect(res.port).toBe(59999);
  });

  it('returns a structured "no game running" error for a runtime read', async () => {
    const { registry } = runtimeSetup(59999);
    const res = await registry.call('game_get_scene_tree', {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no running godot game|connection closed/i);
  });

  it('reports running:true and reads the live scene tree over the bridge', async () => {
    port = await startBridge({
      ping: () => ({ pong: true }),
      get_scene_tree: (params) => ({ root: 'Main', maxDepth: params.maxDepth ?? null, children: ['Player'] }),
    });
    const { registry } = runtimeSetup(port);

    const status = data<{ running: boolean }>(await registry.call('game_runtime_status', {}));
    expect(status.running).toBe(true);

    const tree = data<{ root: string; children: string[]; maxDepth: number | null }>(
      await registry.call('game_get_scene_tree', { maxDepth: 3 })
    );
    expect(tree.root).toBe('Main');
    expect(tree.children).toContain('Player');
    expect(tree.maxDepth).toBe(3);
  });

  it('inspects a node, performance, groups, and class lookups', async () => {
    port = await startBridge({
      get_node_info: (p) => ({ path: p.path, class: 'CharacterBody2D' }),
      performance: () => ({ fps: 60, memory: 1234 }),
      get_nodes_in_group: (p) => ({ group: p.group, nodes: ['/root/Main/Enemy'] }),
      find_nodes_by_class: (p) => ({ className: p.className, nodes: ['/root/Main/Sprite'] }),
      get_ui: () => ({ controls: ['Button'] }),
      get_errors: () => ({ errors: [] }),
      get_logs: (p) => ({ lines: p.lines ?? null, log: 'ready' }),
    });
    const { registry } = runtimeSetup(port);

    const node = data<{ path: string; class: string }>(
      await registry.call('game_get_node_info', { path: '/root/Main/Player' })
    );
    expect(node.path).toBe('/root/Main/Player');
    expect(node.class).toBe('CharacterBody2D');

    const perf = data<{ fps: number }>(await registry.call('game_get_performance', {}));
    expect(perf.fps).toBe(60);

    const group = data<{ nodes: string[] }>(
      await registry.call('game_get_nodes_in_group', { group: 'enemies' })
    );
    expect(group.nodes).toContain('/root/Main/Enemy');

    const byClass = data<{ nodes: string[] }>(
      await registry.call('game_find_nodes_by_class', { className: 'Sprite2D' })
    );
    expect(byClass.nodes).toContain('/root/Main/Sprite');

    const ui = data<{ controls: string[] }>(await registry.call('game_get_ui', {}));
    expect(ui.controls).toContain('Button');

    const logs = data<{ log: string }>(await registry.call('game_get_logs', { lines: 10 }));
    expect(logs.log).toBe('ready');
  });

  it('pauses the game and runs eval only with a CRITICAL approval', async () => {
    port = await startBridge({
      pause: (p) => ({ paused: p.paused }),
      wait: (p) => ({ waited: p.seconds }),
      eval: (p) => ({ result: `evaluated:${String(p.code)}` }),
    });
    const { container, registry } = runtimeSetup(port, 'danger');

    const paused = data<{ paused: boolean }>(
      await registry.call('game_pause', { paused: true })
    );
    expect(paused.paused).toBe(true);

    const waited = data<{ waited: number }>(await registry.call('game_wait', { seconds: 1 }));
    expect(waited.waited).toBe(1);

    // game_eval is CRITICAL: pre-grant a session approval so it runs.
    container.policy.approvals.approve(
      container.policy.approvals.create('game_eval', {}, 'CRITICAL', 'test').id,
      'session'
    );
    const evaled = data<{ result: string }>(
      await registry.call('game_eval', { code: '1 + 1' })
    );
    expect(evaled.result).toBe('evaluated:1 + 1');
  });

  it('validates required arguments before touching the bridge', async () => {
    const { registry } = runtimeSetup(59999);
    const noPath = await registry.call('game_get_node_info', {});
    expect(noPath.ok).toBe(false);
    expect(noPath.error).toMatch(/path is required/i);

    const noGroup = await registry.call('game_get_nodes_in_group', {});
    expect(noGroup.ok).toBe(false);
    expect(noGroup.error).toMatch(/group is required/i);
  });
});

/**
 * Godot integration - Step 4 (runtime mutation + input tier, RUN channel).
 *
 * These suites drive the mutating/input runtime tools against a fake TCP bridge
 * (same echo-server pattern as Step 3). They validate request framing, the
 * runtimeTool() arg-forwarding + required-arg validation, and approval gating on
 * CRITICAL tools - without launching Godot.
 */
describe('game tools integration (Godot Step 4 - node manipulation + signals)', () => {
  let server: Server | null = null;
  let port = 0;
  const sockets = new Set<Socket>();

  async function startBridge(
    handlers: Record<string, (params: Record<string, unknown>) => unknown>
  ): Promise<number> {
    server = createServer((socket) => {
      sockets.add(socket);
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const req = JSON.parse(line) as { id: number; op: string; params: Record<string, unknown> };
          const handler = handlers[req.op];
          if (!handler) {
            socket.write(`${JSON.stringify({ id: req.id, ok: false, error: `unknown op: ${req.op}` })}\n`);
            continue;
          }
          const result = handler(req.params ?? {});
          socket.write(`${JSON.stringify({ id: req.id, ok: true, data: result })}\n`);
        }
      });
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
    });
    await new Promise<void>((res) => server!.listen(0, '127.0.0.1', res));
    const addr = server!.address();
    return typeof addr === 'object' && addr ? addr.port : 0;
  }

  function runtimeSetup(runtimePort: number, mode: PolicyMode = 'danger') {
    const config = loadConfig({ projectRoot: tmpdir() });
    config.policy.defaultMode = mode;
    config.adapters = {
      ...config.adapters,
      godot: { enabled: true, godotPath: 'godot', editorPort: 6550, runtimePort },
    };
    const container = new Container(config);
    container.policy.setMode(mode);
    const registry = buildRegistry(container);
    return { container, registry };
  }

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    sockets.clear();
    if (server) {
      await new Promise<void>((res) => server!.close(() => res()));
      server = null;
    }
    port = 0;
  });

  it('reads, sets, and forwards node-manipulation ops over the bridge', async () => {
    port = await startBridge({
      get_property: (p) => ({ path: p.path, property: p.property, value: 42 }),
      set_property: (p) => ({ path: p.path, property: p.property, value: p.value }),
      instantiate_scene: (p) => ({ scenePath: p.scenePath, parent: p.parent ?? null }),
      remove_node: (p) => ({ removed: p.path }),
      change_scene: (p) => ({ scene: p.scenePath }),
      reparent_node: (p) => ({ path: p.path, newParent: p.newParent }),
    });
    const { registry } = runtimeSetup(port);

    const get = data<{ value: number }>(
      await registry.call('game_get_property', { path: '/root/Main/Player', property: 'health' })
    );
    expect(get.value).toBe(42);

    const set = data<{ value: unknown }>(
      await registry.call('game_set_property', {
        path: '/root/Main/Player',
        property: 'health',
        value: 99,
      })
    );
    expect(set.value).toBe(99);

    const inst = data<{ scenePath: string; parent: string | null }>(
      await registry.call('game_instantiate_scene', { scenePath: 'res://enemy.tscn' })
    );
    expect(inst.scenePath).toBe('res://enemy.tscn');
    expect(inst.parent).toBeNull();

    const removed = data<{ removed: string }>(
      await registry.call('game_runtime_remove_node', { path: '/root/Main/Old' })
    );
    expect(removed.removed).toBe('/root/Main/Old');

    const changed = data<{ scene: string }>(
      await registry.call('game_change_scene', { scenePath: 'res://level2.tscn' })
    );
    expect(changed.scene).toBe('res://level2.tscn');

    const re = data<{ newParent: string }>(
      await registry.call('game_reparent_node', {
        path: '/root/Main/Player',
        newParent: '/root/Main/Holder',
      })
    );
    expect(re.newParent).toBe('/root/Main/Holder');
  });

  it('gates game_call_method behind a CRITICAL approval', async () => {
    port = await startBridge({
      call_method: (p) => ({ method: p.method, args: p.args ?? [] }),
    });
    const { container, registry } = runtimeSetup(port);

    container.policy.approvals.approve(
      container.policy.approvals.create('game_call_method', {}, 'CRITICAL', 'test').id,
      'session'
    );
    const called = data<{ method: string; args: unknown[] }>(
      await registry.call('game_call_method', {
        path: '/root/Main/Player',
        method: 'take_damage',
        args: [10],
      })
    );
    expect(called.method).toBe('take_damage');
    expect(called.args).toEqual([10]);
  });

  it('connects, emits, and lists signals over the bridge', async () => {
    port = await startBridge({
      connect_signal: (p) => ({ connected: `${String(p.signal)}->${String(p.method)}` }),
      disconnect_signal: (p) => ({ disconnected: p.signal }),
      emit_signal: (p) => ({ emitted: p.signal, args: p.args ?? [] }),
      list_signals: (p) => ({ path: p.path, signals: ['pressed', 'tree_entered'] }),
      await_signal: (p) => ({ signal: p.signal, payload: ['ok'] }),
    });
    const { registry } = runtimeSetup(port);

    const conn = data<{ connected: string }>(
      await registry.call('game_connect_signal', {
        path: '/root/Main/Button',
        signal: 'pressed',
        target: '/root/Main',
        method: '_on_pressed',
      })
    );
    expect(conn.connected).toBe('pressed->_on_pressed');

    const list = data<{ signals: string[] }>(
      await registry.call('game_list_signals', { path: '/root/Main/Button' })
    );
    expect(list.signals).toContain('pressed');

    const emit = data<{ emitted: string }>(
      await registry.call('game_emit_signal', { path: '/root/Main', signal: 'game_over' })
    );
    expect(emit.emitted).toBe('game_over');

    const awaited = data<{ payload: string[] }>(
      await registry.call('game_await_signal', { path: '/root/Main', signal: 'ready' })
    );
    expect(awaited.payload).toContain('ok');
  });

  it('validates required args before touching the bridge', async () => {
    const { registry } = runtimeSetup(59999);
    const noProp = await registry.call('game_set_property', { path: '/root/Main' });
    expect(noProp.ok).toBe(false);
    expect(noProp.error).toMatch(/property is required/i);

    const noSignal = await registry.call('game_emit_signal', { path: '/root/Main' });
    expect(noSignal.ok).toBe(false);
    expect(noSignal.error).toMatch(/signal is required/i);
  });
});

/**
 * Godot integration - Step 4 group 2 (runtime input + animation + audio).
 *
 * Same fake-bridge pattern as the other Step 4 suite. Validates request framing,
 * runtimeTool() arg-forwarding + required-arg validation, and read vs mutate
 * classification for the input/animation/audio families - without launching Godot.
 */
describe('game tools integration (Godot Step 4 - input + animation + audio)', () => {
  let server: Server | null = null;
  let port = 0;
  const sockets = new Set<Socket>();

  async function startBridge(
    handlers: Record<string, (params: Record<string, unknown>) => unknown>
  ): Promise<number> {
    server = createServer((socket) => {
      sockets.add(socket);
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const req = JSON.parse(line) as { id: number; op: string; params: Record<string, unknown> };
          const handler = handlers[req.op];
          if (!handler) {
            socket.write(`${JSON.stringify({ id: req.id, ok: false, error: `unknown op: ${req.op}` })}\n`);
            continue;
          }
          const result = handler(req.params ?? {});
          socket.write(`${JSON.stringify({ id: req.id, ok: true, data: result })}\n`);
        }
      });
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
    });
    await new Promise<void>((res) => server!.listen(0, '127.0.0.1', res));
    const addr = server!.address();
    return typeof addr === 'object' && addr ? addr.port : 0;
  }

  function runtimeSetup(runtimePort: number, mode: PolicyMode = 'danger') {
    const config = loadConfig({ projectRoot: tmpdir() });
    config.policy.defaultMode = mode;
    config.adapters = {
      ...config.adapters,
      godot: { enabled: true, godotPath: 'godot', editorPort: 6550, runtimePort },
    };
    const container = new Container(config);
    container.policy.setMode(mode);
    const registry = buildRegistry(container);
    return { container, registry };
  }

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    sockets.clear();
    if (server) {
      await new Promise<void>((res) => server!.close(() => res()));
      server = null;
    }
    port = 0;
  });

  it('injects input events and reads input state over the bridge', async () => {
    port = await startBridge({
      screenshot: (p) => ({ path: p.path ?? 'res://screen.png' }),
      click: (p) => ({ x: p.x, y: p.y, button: p.button ?? 'left' }),
      key_press: (p) => ({ key: p.key }),
      mouse_move: (p) => ({ x: p.x, y: p.y }),
      mouse_drag: (p) => ({ from: [p.fromX, p.fromY], to: [p.toX, p.toY] }),
      scroll: (p) => ({ amount: p.amount }),
      touch: (p) => ({ x: p.x, y: p.y, pressed: p.pressed ?? true }),
      input_action: (p) => ({ action: p.action, pressed: p.pressed ?? true }),
      input_state: () => ({ mouse: [10, 20], pressed: ['ui_accept'] }),
    });
    const { registry } = runtimeSetup(port);

    const shot = data<{ path: string }>(
      await registry.call('game_screenshot', {})
    );
    expect(shot.path).toBe('res://screen.png');

    const click = data<{ x: number; y: number; button: string }>(
      await registry.call('game_click', { x: 100, y: 200 })
    );
    expect(click.x).toBe(100);
    expect(click.button).toBe('left');

    const key = data<{ key: string }>(
      await registry.call('game_key_press', { key: 'space' })
    );
    expect(key.key).toBe('space');

    const drag = data<{ from: number[]; to: number[] }>(
      await registry.call('game_mouse_drag', { fromX: 0, fromY: 0, toX: 50, toY: 60 })
    );
    expect(drag.to).toEqual([50, 60]);

    const action = data<{ action: string }>(
      await registry.call('game_input_action', { action: 'jump' })
    );
    expect(action.action).toBe('jump');

    const state = data<{ pressed: string[] }>(
      await registry.call('game_input_state', {})
    );
    expect(state.pressed).toContain('ui_accept');
  });

  it('drives animation and audio ops over the bridge', async () => {
    port = await startBridge({
      play_animation: (p) => ({ path: p.path, animation: p.animation }),
      tween_property: (p) => ({ property: p.property, to: p.to }),
      animation_control: (p) => ({ action: p.action }),
      audio_effect: (p) => ({ bus: p.bus, effect: p.effect }),
      audio_bus_layout: (p) => ({ bus: p.bus, volumeDb: p.volumeDb ?? 0 }),
      audio_spatial: (p) => ({ path: p.path, property: p.property }),
    });
    const { registry } = runtimeSetup(port);

    const anim = data<{ animation: string }>(
      await registry.call('game_play_animation', { path: '/root/Anim', animation: 'walk' })
    );
    expect(anim.animation).toBe('walk');

    const tween = data<{ to: unknown }>(
      await registry.call('game_tween_property', {
        path: '/root/Main',
        property: 'position',
        to: [10, 10],
      })
    );
    expect(tween.to).toEqual([10, 10]);

    const ctrl = data<{ action: string }>(
      await registry.call('game_animation_control', { path: '/root/Anim', action: 'pause' })
    );
    expect(ctrl.action).toBe('pause');

    const fx = data<{ bus: string; effect: string }>(
      await registry.call('game_audio_effect', { bus: 'Master', effect: 'Reverb' })
    );
    expect(fx.effect).toBe('Reverb');

    const bus = data<{ bus: string }>(
      await registry.call('game_audio_bus_layout', { bus: 'Music' })
    );
    expect(bus.bus).toBe('Music');
  });

  it('validates required args before touching the bridge', async () => {
    const { registry } = runtimeSetup(59999);

    const noXY = await registry.call('game_click', { x: 1 });
    expect(noXY.ok).toBe(false);
    expect(noXY.error).toMatch(/y is required/i);

    const noAnim = await registry.call('game_play_animation', { path: '/root/Anim' });
    expect(noAnim.ok).toBe(false);
    expect(noAnim.error).toMatch(/animation is required/i);

    const noEffect = await registry.call('game_audio_effect', { bus: 'Master' });
    expect(noEffect.ok).toBe(false);
    expect(noEffect.error).toMatch(/effect is required/i);
  });
});

/**
 * Godot integration - Step 4 group 3 (runtime system/window + UI controls).
 *
 * Same fake-bridge pattern. Validates request framing, runtimeTool()
 * arg-forwarding + required-arg validation, read vs mutate classification, and
 * that the CRITICAL game_script is approval-gated even in danger mode.
 */
describe('game tools integration (Godot Step 4 - system/window + UI controls)', () => {
  let server: Server | null = null;
  let port = 0;
  const sockets = new Set<Socket>();

  async function startBridge(
    handlers: Record<string, (params: Record<string, unknown>) => unknown>
  ): Promise<number> {
    server = createServer((socket) => {
      sockets.add(socket);
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const req = JSON.parse(line) as { id: number; op: string; params: Record<string, unknown> };
          const handler = handlers[req.op];
          if (!handler) {
            socket.write(`${JSON.stringify({ id: req.id, ok: false, error: `unknown op: ${req.op}` })}\n`);
            continue;
          }
          const result = handler(req.params ?? {});
          socket.write(`${JSON.stringify({ id: req.id, ok: true, data: result })}\n`);
        }
      });
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
    });
    await new Promise<void>((res) => server!.listen(0, '127.0.0.1', res));
    const addr = server!.address();
    return typeof addr === 'object' && addr ? addr.port : 0;
  }

  function runtimeSetup(runtimePort: number, mode: PolicyMode = 'danger') {
    const config = loadConfig({ projectRoot: tmpdir() });
    config.policy.defaultMode = mode;
    config.adapters = {
      ...config.adapters,
      godot: { enabled: true, godotPath: 'godot', editorPort: 6550, runtimePort },
    };
    const container = new Container(config);
    container.policy.setMode(mode);
    const registry = buildRegistry(container);
    return { container, registry };
  }

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    sockets.clear();
    if (server) {
      await new Promise<void>((res) => server!.close(() => res()));
      server = null;
    }
    port = 0;
  });

  it('drives system/window and UI ops over the bridge', async () => {
    port = await startBridge({
      os_info: () => ({ name: 'Linux', locale: 'en_US' }),
      time_scale: (p) => ({ scale: p.scale }),
      window: (p) => ({ property: p.property, value: p.value }),
      process_mode: (p) => ({ path: p.path, mode: p.mode }),
      world_settings: (p) => ({ property: p.property, value: p.value }),
      ui_control: (p) => ({ path: p.path, action: p.action }),
      ui_text: (p) => ({ path: p.path, text: p.text ?? null }),
      ui_range: (p) => ({ path: p.path, value: p.value }),
      ui_tabs: (p) => ({ path: p.path, action: p.action }),
    });
    const { registry } = runtimeSetup(port);

    const os = data<{ name: string }>(await registry.call('game_os_info', {}));
    expect(os.name).toBe('Linux');

    const ts = data<{ scale: number }>(
      await registry.call('game_time_scale', { scale: 0.5 })
    );
    expect(ts.scale).toBe(0.5);

    const win = data<{ property: string }>(
      await registry.call('game_window', { property: 'title', value: 'My Game' })
    );
    expect(win.property).toBe('title');

    const pm = data<{ mode: string }>(
      await registry.call('game_process_mode', { path: '/root/Main', mode: 'always' })
    );
    expect(pm.mode).toBe('always');

    const ctrl = data<{ action: string }>(
      await registry.call('game_ui_control', { path: '/root/Button', action: 'press' })
    );
    expect(ctrl.action).toBe('press');

    const range = data<{ value: number }>(
      await registry.call('game_ui_range', { path: '/root/Slider', value: 42 })
    );
    expect(range.value).toBe(42);
  });

  it('validates required args before touching the bridge', async () => {
    const { registry } = runtimeSetup(59999);

    const noScale = await registry.call('game_time_scale', {});
    expect(noScale.ok).toBe(false);
    expect(noScale.error).toMatch(/scale is required/i);

    const noMode = await registry.call('game_process_mode', { path: '/root/Main' });
    expect(noMode.ok).toBe(false);
    expect(noMode.error).toMatch(/mode is required/i);

    const noAction = await registry.call('game_ui_control', { path: '/root/Button' });
    expect(noAction.ok).toBe(false);
    expect(noAction.error).toMatch(/action is required/i);
  });

  it('gates the CRITICAL game_script behind approval even in danger mode', async () => {
    const { registry } = runtimeSetup(59999);
    const res = await registry.call('game_script', {
      path: '/root/Main',
      source: 'func _ready(): pass',
    });
    // CRITICAL tools are never auto-run; they require approval, so the call does
    // not succeed outright (it is queued / denied rather than executed).
    expect(res.ok).toBe(false);
  });
});

/**
 * Godot integration - Step 5c (project management PROC channel + headless
 * project/editor CLI tier).
 *
 * Covers the final-parity tier that closes the gap toward 149 tools: project
 * discovery/creation, project-config management (autoloads, input map, layers,
 * plugins, translations, export presets), scene save + UID reads, and the
 * PROC-channel launch/run/stop/export tools. All CLI tools are pure file edits
 * (no Godot binary required); the PROC tools start a managed process through the
 * shared ProcessManager - here we point godotPath at a harmless shim so launch
 * is observable without a real engine.
 */
describe('game tools integration (Godot Step 5c - project mgmt + CLI tier)', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'ff-godot-5c-'));
    writeFileSync(join(ws, 'project.godot'), PROJECT_GODOT);
    writeFileSync(join(ws, 'main.tscn'), MAIN_TSCN);
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('discovers projects under a directory', async () => {
    const { registry } = setup(ws, 'danger');
    const res = data<{ count: number; projects: Array<{ name: string }> }>(
      await registry.call('game_list_projects', { searchDir: ws })
    );
    expect(res.count).toBeGreaterThanOrEqual(1);
    expect(res.projects.some((p) => p.name === 'Test Game')).toBe(true);
  });

  it('creates a new project (CRITICAL, approval-gated)', async () => {
    const { container, registry } = setup(ws, 'danger');
    container.policy.approvals.approve(
      container.policy.approvals.create('game_create_project', {}, 'CRITICAL', 'test').id,
      'session'
    );
    const target = join(ws, 'new_game');
    const res = data<{ created: boolean; projectFile: string }>(
      await registry.call('game_create_project', {
        targetDir: target,
        name: 'Fresh',
        mainScene: 'res://main.tscn',
      })
    );
    expect(res.created).toBe(true);
    const info = data<{ name: string; mainScene: string }>(
      await registry.call('game_get_project_info', { projectPath: target })
    );
    expect(info.name).toBe('Fresh');
    expect(info.mainScene).toBe('res://main.tscn');
  });

  it('saves a scene and reads its uid', async () => {
    const { registry } = setup(ws, 'danger');
    const saved = data<{ resPath: string; nodeCount: number }>(
      await registry.call('game_save_scene', { projectPath: ws, scenePath: 'res://main.tscn' })
    );
    expect(saved.nodeCount).toBe(3);

    const uid = data<{ uid: string | null }>(
      await registry.call('game_get_uid', { projectPath: ws, filePath: 'res://main.tscn' })
    );
    expect(uid.uid).toBe('uid://abc123');
  });

  it('manages autoloads, input map, layers, plugins, and translations', async () => {
    const { registry } = setup(ws, 'danger');
    data(
      await registry.call('game_manage_autoloads', {
        projectPath: ws,
        op: 'add',
        name: 'GameState',
        scriptPath: 'res://game_state.gd',
      })
    );
    data(
      await registry.call('game_manage_input_map', {
        projectPath: ws,
        op: 'add',
        action: 'jump',
        keys: ['space'],
      })
    );
    data(
      await registry.call('game_manage_layers', {
        projectPath: ws,
        kind: '2d_physics',
        index: 1,
        name: 'world',
      })
    );
    data(
      await registry.call('game_manage_translations', {
        projectPath: ws,
        files: ['res://i18n/en.po'],
      })
    );

    const settings = data<{ raw: string; sections: string[] }>(
      await registry.call('game_read_project_settings', { projectPath: ws })
    );
    expect(settings.sections).toContain('autoload');
    expect(settings.raw).toContain('GameState');
    expect(settings.raw).toContain('jump');
    expect(settings.raw).toContain('2d_physics/layer_1');
    expect(settings.raw).toContain('locale/translations');

    const removed = data<{ op: string }>(
      await registry.call('game_manage_autoloads', { projectPath: ws, op: 'remove', name: 'GameState' })
    );
    expect(removed.op).toBe('remove');
  });

  it('writes an export preset to export_presets.cfg', async () => {
    const { registry } = setup(ws, 'danger');
    data(
      await registry.call('game_manage_export_presets', {
        projectPath: ws,
        preset: 'preset.0',
        key: 'name',
        value: 'Linux/X11',
      })
    );
    const cfg = data<{ content: string }>(
      await registry.call('game_read_file', { projectPath: ws, filePath: 'export_presets.cfg' })
    );
    expect(cfg.content).toContain('[preset.0]');
    expect(cfg.content).toContain('name="Linux/X11"');
  });

  it('launches and stops a managed Godot process (PROC channel)', async () => {
    const { container, registry } = setup(ws, 'danger');
    // Point the "godot" binary at a harmless long-runner so launch is observable.
    container.config.adapters!.godot!.godotPath = 'sleep 30; echo';
    const launched = data<{ sessionId: string; mode: string }>(
      await registry.call('game_run_project', { projectPath: ws })
    );
    expect(launched.sessionId).toBeTruthy();
    expect(launched.mode).toBe('run');
    expect(container.processes.isManaged(launched.sessionId)).toBe(true);

    const dbg = data<{ status: string }>(
      await registry.call('game_get_debug_output', { sessionId: launched.sessionId })
    );
    expect(dbg.status).toBeTruthy();

    const stopped = data<{ sessionId: string }>(
      await registry.call('game_stop_project', { sessionId: launched.sessionId })
    );
    expect(stopped.sessionId).toBe(launched.sessionId);
  });

  it('validates required args for the new tools', async () => {
    const { registry } = setup(ws, 'danger');
    // game_create_project is CRITICAL: gated before the handler runs.
    const gated = await registry.call('game_create_project', { name: 'X' });
    expect(gated.ok).toBe(false);

    const noFiles = await registry.call('game_manage_translations', { projectPath: ws, files: [] });
    expect(noFiles.ok).toBe(false);
    expect(noFiles.error).toMatch(/non-empty/i);

    const noStop = await registry.call('game_stop_project', { sessionId: 'nope_123' });
    expect(noStop.ok).toBe(false);

    const badOp = await registry.call('game_manage_autoloads', { projectPath: ws, op: 'frobnicate', name: 'X' });
    expect(badOp.ok).toBe(false);
  });
});
