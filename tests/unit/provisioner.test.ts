import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FleetManager } from '../../src/provisioner/fleet-manager.js';

const HERE = fileURLToPath(import.meta.url);

function fixture(): { root: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), 'ff-fleet-'));
  const project = join(root, 'project-a');
  mkdirSync(project, { recursive: true });
  return { root, project };
}

function stubSpawner(calls: string[]) {
  let counter = 0;
  return (command: string, cwd: string) => {
    counter += 1;
    calls.push(`${command} @ ${cwd}`);
    return { sessionId: `proc_stub_${counter}`, pid: 4000 + counter };
  };
}

describe('FleetManager', () => {
  it('creates an instance, returns the token once, and persists only its hash', () => {
    const { root, project } = fixture();
    const fleet = new FleetManager(root);
    const { instance, token } = fleet.create({ projectPath: project, actor: 'test' });
    expect(instance.state).toBe('stopped');
    expect(instance.port).toBe(7410);
    expect(token.length).toBeGreaterThan(20);

    const raw = readFileSync(join(root, '.folderforge', 'fleet.json'), 'utf8');
    expect(raw).not.toContain(token);
    expect(raw).toContain(instance.tokenSha256);

    const cfg = readFileSync(join(root, '.folderforge', 'fleet', `${instance.id}.yaml`), 'utf8');
    expect(cfg).toContain(token);
    expect(cfg).toContain('requireAuth: true');

    const reloaded = new FleetManager(root);
    expect(reloaded.get(instance.id).projectPath).toBe(project);
  });

  it('rejects duplicate folders, port collisions, bad presets, and bad ports', () => {
    const { root, project } = fixture();
    const fleet = new FleetManager(root);
    fleet.create({ projectPath: project });
    expect(() => fleet.create({ projectPath: project })).toThrow(/already provisioned/);

    const other = join(root, 'project-b');
    mkdirSync(other);
    fleet.create({ projectPath: other, port: 7500 });

    const third = join(root, 'project-c');
    mkdirSync(third);
    expect(() => fleet.create({ projectPath: third, port: 7500 })).toThrow(/already assigned/);
    expect(() => fleet.create({ projectPath: third, port: 80 })).toThrow(/Invalid port/);
    expect(() => fleet.create({ projectPath: third, toolsPreset: 'nope' })).toThrow(/tools preset/);
    expect(() => fleet.create({ projectPath: join(root, 'missing') })).toThrow(/Not a project folder/);
  });

  it('enforces the operator-configured fleet cap', () => {
    const { root, project } = fixture();
    const fleet = new FleetManager(root, { maxFleet: 1 });
    fleet.create({ projectPath: project });
    const extra = join(root, 'project-b');
    mkdirSync(extra);
    expect(() => fleet.create({ projectPath: extra })).toThrow(/cap/);
  });

  it('starts and stops instances through the injected process spawner', () => {
    const { root, project } = fixture();
    const calls: string[] = [];
    const fleet = new FleetManager(root, {
      mainJs: HERE,
      spawn: stubSpawner(calls),
      stopSession: (sessionId) => {
        calls.push(`stop ${sessionId}`);
      },
      readSession: () => 'line1\nline2',
    });
    const { instance } = fleet.create({ projectPath: project });

    const started = fleet.start(instance.id);
    expect(started.state).toBe('running');
    expect(started.sessionId).toBe('proc_stub_1');
    expect(calls[0]).toContain('--tools-preset vibe');
    expect(calls[0]).toContain('--no-dashboard');
    expect(() => fleet.start(instance.id)).toThrow(/already/);
    expect(fleet.logs(instance.id)).toBe('line1\nline2');

    const stopped = fleet.stop(instance.id);
    expect(stopped.state).toBe('stopped');
    expect(calls).toContain('stop proc_stub_1');
  });

  it('marks the instance failed when spawning fails', () => {
    const { root, project } = fixture();
    const fleet = new FleetManager(root, {
      mainJs: HERE,
      spawn: () => {
        throw new Error('boom');
      },
    });
    const { instance } = fleet.create({ projectPath: project });
    expect(() => fleet.start(instance.id)).toThrow(/boom/);
    expect(fleet.get(instance.id).state).toBe('failed');
    expect(fleet.get(instance.id).lastError).toBe('boom');
  });

  it('rotates tokens without persisting raw values and flags restart when running', () => {
    const { root, project } = fixture();
    const fleet = new FleetManager(root, { mainJs: HERE, spawn: stubSpawner([]) });
    const { instance, token: first } = fleet.create({ projectPath: project });
    const rotated = fleet.rotateToken(instance.id);
    expect(rotated.token).not.toBe(first);
    expect(rotated.instance.tokenSha256).not.toBe(instance.tokenSha256);
    expect(rotated.restartRequired).toBe(false);

    const raw = readFileSync(join(root, '.folderforge', 'fleet.json'), 'utf8');
    expect(raw).not.toContain(first);
    expect(raw).not.toContain(rotated.token);

    fleet.start(instance.id);
    const rotatedWhileRunning = fleet.rotateToken(instance.id);
    expect(rotatedWhileRunning.restartRequired).toBe(true);
  });

  it('refuses to destroy a running instance; destroy removes record and config', () => {
    const { root, project } = fixture();
    const fleet = new FleetManager(root, {
      mainJs: HERE,
      spawn: stubSpawner([]),
      stopSession: () => undefined,
    });
    const { instance } = fleet.create({ projectPath: project });
    fleet.start(instance.id);
    expect(() => fleet.destroy(instance.id)).toThrow(/Stop instance/);
    fleet.stop(instance.id);
    expect(fleet.destroy(instance.id)).toEqual({ destroyed: instance.id });
    expect(() => fleet.get(instance.id)).toThrow(/Unknown fleet instance/);
    expect(existsSync(join(root, '.folderforge', 'fleet', `${instance.id}.yaml`))).toBe(false);
  });

  it('fails clearly when the runtime entrypoint is missing', () => {
    const { root, project } = fixture();
    const fleet = new FleetManager(root, {
      mainJs: join(root, 'no-such-main.js'),
      spawn: stubSpawner([]),
    });
    const { instance } = fleet.create({ projectPath: project });
    expect(() => fleet.start(instance.id)).toThrow(/entrypoint/);
  });
});
