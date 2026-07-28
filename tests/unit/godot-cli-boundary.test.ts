import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GodotCli } from '../../packages/adapter-godot/src/cli.js';

function cli(): GodotCli {
  return new GodotCli({
    enabled: true,
    godotPath: 'godot',
    editorPort: 6005,
    runtimePort: 6006,
  });
}

describe('GodotCli filesystem boundary', () => {
  let projectRoot: string;
  let outside: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'ff-godot-project-'));
    outside = mkdtempSync(join(tmpdir(), 'ff-godot-outside-'));
    mkdirSync(join(projectRoot, 'scripts'), { recursive: true });
    writeFileSync(join(projectRoot, 'project.godot'), 'config_version=5\n', 'utf8');
    writeFileSync(join(projectRoot, 'scripts', 'local.gd'), 'extends Node\n', 'utf8');
    writeFileSync(join(outside, 'outside.gd'), 'OUTSIDE_GODOT_MARKER\n', 'utf8');
    symlinkSync(
      outside,
      join(projectRoot, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('does not list, read, or write through a nested directory symlink', () => {
    const adapter = cli();

    const listed = adapter.listProjectFiles(projectRoot);
    expect(listed.ok).toBe(true);
    expect(listed.data?.map((entry) => entry.resPath)).toContain('res://scripts/local.gd');
    expect(listed.data?.map((entry) => entry.resPath)).not.toContain('res://escape/outside.gd');

    const read = adapter.readFile(projectRoot, 'escape/outside.gd');
    expect(read.ok).toBe(false);
    expect(read.error).toMatch(/outside the project root|symbolic link/i);

    const write = adapter.writeFile(projectRoot, 'escape/created-outside.gd', 'blocked\n');
    expect(write.ok).toBe(false);
    expect(write.error).toMatch(/outside the project root|symbolic link/i);
    expect(existsSync(join(outside, 'created-outside.gd'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses symlinked project configuration files for reads and writes',
    () => {
      const externalProjectFile = join(outside, 'external-project.godot');
      writeFileSync(
        externalProjectFile,
        'config_version=5\n[application]\nconfig/name="Outside"\n',
        'utf8'
      );
      rmSync(join(projectRoot, 'project.godot'));
      symlinkSync(externalProjectFile, join(projectRoot, 'project.godot'), 'file');
      const before = readFileSync(externalProjectFile, 'utf8');
      const adapter = cli();

      expect(adapter.readProjectSettings(projectRoot)).toMatchObject({ ok: false });
      expect(adapter.modifyProjectSettings(projectRoot, 'application', 'config/name', 'Injected')).toMatchObject({
        ok: false,
      });
      expect(adapter.managePlugins(projectRoot, 'enable', 'outside-plugin')).toMatchObject({ ok: false });
      expect(adapter.manageAutoloads(projectRoot, 'remove', 'Outside')).toMatchObject({ ok: false });
      expect(readFileSync(externalProjectFile, 'utf8')).toBe(before);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked export preset file',
    () => {
      const externalPreset = join(outside, 'external-export-presets.cfg');
      writeFileSync(externalPreset, '[preset.0]\nname="Outside"\n', 'utf8');
      symlinkSync(externalPreset, join(projectRoot, 'export_presets.cfg'), 'file');
      const before = readFileSync(externalPreset, 'utf8');

      const result = cli().setExportPreset(projectRoot, 'preset.0', 'name', 'Injected');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/outside the project root|symbolic link/i);
      expect(readFileSync(externalPreset, 'utf8')).toBe(before);
    }
  );
});
