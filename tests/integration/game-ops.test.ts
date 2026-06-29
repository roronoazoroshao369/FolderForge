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
