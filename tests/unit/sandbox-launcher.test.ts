import { describe, expect, it } from 'vitest';
import {
  applySandboxLaunch,
  buildSandboxedShellLaunch,
  sandboxSummary,
} from '../../src/sandbox/launcher.js';
import type { AdapterDef } from '../../src/core/types.js';
import { resolve } from 'node:path';

const digest = 'sha256:' + 'a'.repeat(64);

function definition(overrides: Partial<AdapterDef> = {}): AdapterDef {
  return {
    enabled: true,
    command: 'node',
    args: ['server.mjs'],
    env: { ALLOWED_TOKEN: 'secret-value' },
    sandbox: {
      mode: 'docker',
      image: `example/plugin@${digest}`,
      command: 'node',
      args: ['/plugin/server.mjs'],
      workdir: '/plugin',
      mounts: [
        { source: process.cwd(), target: '/plugin', mode: 'ro' },
        { source: process.cwd(), target: '/workspace', mode: 'rw' },
      ],
    },
    ...overrides,
  };
}

describe('container child sandbox launcher', () => {
  it('builds a fail-closed Docker launch with bounded resources and explicit env forwarding', () => {
    const launch = applySandboxLaunch(definition(), {
      command: 'node',
      args: ['server.mjs'],
      source: 'custom',
    });

    expect(launch.command).toBe('docker');
    expect(launch.args).toEqual(expect.arrayContaining([
      'run', '--rm', '-i', '--pull=never', '--network=none', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=512m',
      '--cpus=1', '--read-only', '--env', 'ALLOWED_TOKEN',
      `example/plugin@${digest}`, 'node', '/plugin/server.mjs',
    ]));
    expect(launch.args.join(' ')).not.toContain('secret-value');
    expect(launch.args.some((value) => value.includes('dst=/plugin,readonly'))).toBe(true);
    expect(launch.args.some((value) => value.includes('dst=/workspace') && !value.includes('readonly'))).toBe(true);
    expect(sandboxSummary(definition().sandbox)).toMatchObject({
      mode: 'docker', enforced: true, network: 'none', readOnlyRoot: true,
    });
  });

  it('refuses mutable image tags unless an explicit development override is present', () => {
    const def = definition();
    def.sandbox = { ...def.sandbox!, image: 'example/plugin:latest' };
    expect(() => applySandboxLaunch(def, { command: 'node', args: [], source: 'custom' }))
      .toThrow(/pinned.*sha256/i);

    def.sandbox.requireImageDigest = false;
    expect(applySandboxLaunch(def, { command: 'node', args: [], source: 'custom' }).command)
      .toBe('docker');
  });

  it('rejects duplicate or unsafe mounts and invalid resource bounds', () => {
    const duplicate = definition();
    duplicate.sandbox = {
      ...duplicate.sandbox!,
      mounts: [
        { source: process.cwd(), target: '/same', mode: 'ro' },
        { source: process.cwd(), target: '/same', mode: 'rw' },
      ],
    };
    expect(() => applySandboxLaunch(duplicate, { command: 'node', args: [], source: 'custom' }))
      .toThrow(/duplicate sandbox mount target/i);

    const resources = definition();
    resources.sandbox = { ...resources.sandbox!, memoryMb: 1 };
    expect(() => applySandboxLaunch(resources, { command: 'node', args: [], source: 'custom' }))
      .toThrow(/memoryMb/);
  });

  it('builds a pinned, workspace-scoped terminal container launch', () => {
    const root = process.cwd();
    const launch = buildSandboxedShellLaunch(
      {
        mode: 'podman',
        image: `example/terminal@${digest}`,
        requireInDanger: true,
      },
      '/bin/bash',
      root,
      root,
      'npm test',
    );
    expect(launch).toMatchObject({
      command: 'podman',
      cwd: root,
      sandboxMode: 'podman',
      sandboxImage: `example/terminal@${digest}`,
    });
    expect(launch.args).toEqual(expect.arrayContaining([
      '--pull=never', '--network=none', '--cap-drop=ALL', '--read-only',
      '--workdir', '/workspace', `example/terminal@${digest}`, '/bin/sh', '-lc', 'npm test',
    ]));
    expect(launch.args.some((value) => value.includes(`src=${root},dst=/workspace`))).toBe(true);
  });

  it('rejects terminal cwd escapes and mutable terminal images', () => {
    expect(() => buildSandboxedShellLaunch(
      { mode: 'docker', image: 'example/terminal:latest', requireInDanger: true },
      '/bin/sh',
      process.cwd(),
      process.cwd(),
      'true',
    )).toThrow(/pinned.*sha256/i);
    expect(() => buildSandboxedShellLaunch(
      { mode: 'docker', image: `example/terminal@${digest}`, requireInDanger: true },
      '/bin/sh',
      process.cwd(),
      resolve(process.cwd(), '..'),
      'true',
    )).toThrow(/inside the workspace root/i);
  });

  it('preserves process-mode launches for trusted adapters', () => {
    const def = definition({ sandbox: { mode: 'process' } });
    const original = { command: 'node', args: ['server.mjs'], source: 'custom' as const };
    expect(applySandboxLaunch(def, original)).toEqual(original);
    expect(sandboxSummary(def.sandbox)).toEqual({ mode: 'process', enforced: false });
  });
});
