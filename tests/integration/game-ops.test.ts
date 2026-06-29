import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
