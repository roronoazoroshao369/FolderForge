import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  executeShareCli,
  type ShareDeps,
  type ShareOpenAiSupervisorInput,
} from '../../src/share/cli.js';

interface FakeHarness {
  deps: ShareDeps;
  written: string[];
  stopped: string[];
  spawned: ShareOpenAiSupervisorInput[];
  servers: Array<{ token: string; auth: string }>;
  tunnelsStarted: number[];
  release: () => void;
}

function makeDeps(overrides: Partial<ShareDeps> = {}): FakeHarness {
  const written: string[] = [];
  const stopped: string[] = [];
  const spawned: ShareOpenAiSupervisorInput[] = [];
  const servers: Array<{ token: string; auth: string }> = [];
  const tunnelsStarted: number[] = [];
  const stopWaiters: Array<() => void> = [];
  const deps: ShareDeps = {
    mainJs: '/fake/dist/main.js',
    version: '0.0.0-test',
    now: () => 1_000_000,
    getEnv: () => undefined,
    loadTunnelConfig: () => null,
    hasCloudflared: () => true,
    hasOAuthConfig: () => false,
    startServer: async (input) => {
      servers.push({ token: input.token, auth: input.auth });
      return {
        port: 7_777,
        close: async () => {
          stopped.push('server');
        },
      };
    },
    startCloudflareTunnel: async ({ targetPort }) => {
      tunnelsStarted.push(targetPort);
      return {
        publicUrl: 'https://brave-fox-123.trycloudflare.com',
        stop: async () => {
          stopped.push(`tunnel:${targetPort}`);
        },
      };
    },
    spawnOpenAiSupervisor: (input) => {
      spawned.push(input);
      return {
        pid: 5_555,
        stop: () => {
          stopped.push('supervisor');
        },
      };
    },
    waitForStop: () =>
      new Promise<void>((resolveStop) => {
        stopWaiters.push(resolveStop);
      }),
    write: (text) => {
      written.push(text);
    },
    ...overrides,
  };
  return {
    deps,
    written,
    stopped,
    spawned,
    servers,
    tunnelsStarted,
    release: () => {
      for (const release of stopWaiters.splice(0)) release();
    },
  };
}

const roots: string[] = [];
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'ff-share-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runUntilStop(harness: FakeHarness, argv: string[]) {
  const promise = executeShareCli(argv, harness.deps);
  // Let the async startup chain reach waitForStop before releasing it.
  await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  harness.release();
  return promise;
}

describe('folderforge share', () => {
  it('start → prints URL + temporary credential → teardown closes tunnel then server', async () => {
    const root = project();
    const harness = makeDeps();
    const result = await runUntilStop(harness, ['--project', root]);

    expect(result.exitCode).toBe(0);
    const out = harness.written.join('');
    // Cloudflare auto-selected (binary present), URL pointed at /mcp.
    expect(out).toContain('MCP URL: https://brave-fox-123.trycloudflare.com/mcp');
    expect(out).toContain('Tunnel: cloudflare');
    expect(out).toContain('auto-selected');
    // Temporary bearer printed once for the operator, marked in-memory only.
    expect(harness.servers).toHaveLength(1);
    expect(harness.servers[0]!.auth).toBe('token');
    const token = harness.servers[0]!.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    expect(out).toContain(`Bearer ${token}`);
    expect(out).toContain('in-memory only');
    expect(out).toContain('Share session ended');
    expect(out).toContain('credential invalidated');
    // Teardown order: tunnel first, then the server (no leftover processes).
    expect(harness.stopped).toEqual(['tunnel:7777', 'server']);
    expect(harness.tunnelsStarted).toEqual([7_777]);
  });

  it('--tunnel none prints the loopback URL and starts no tunnel', async () => {
    const root = project();
    const harness = makeDeps();
    const result = await runUntilStop(harness, ['--tunnel', 'none', '--project', root]);
    expect(result.exitCode).toBe(0);
    const out = harness.written.join('');
    expect(out).toContain('MCP URL: http://127.0.0.1:7777/mcp');
    expect(out).toContain('Tunnel: none');
    expect(harness.tunnelsStarted).toEqual([]);
    expect(harness.stopped).toEqual(['server']);
  });

  it('falls back to --tunnel none when cloudflared is not installed', async () => {
    const root = project();
    const harness = makeDeps({ hasCloudflared: () => false });
    const result = await runUntilStop(harness, ['--project', root]);
    expect(result.exitCode).toBe(0);
    expect(harness.written.join('')).toContain('Tunnel: none');
    expect(harness.tunnelsStarted).toEqual([]);
  });

  it('--tunnel cloudflare without the binary fails with guidance and stops the server', async () => {
    const root = project();
    const harness = makeDeps({ hasCloudflared: () => false });
    const result = await executeShareCli(['--tunnel', 'cloudflare', '--project', root], harness.deps);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('cloudflared');
    expect(result.output).toContain('--tunnel none');
    expect(harness.stopped).toEqual(['server']);
  });

  it('--tunnel openai without a tunnel id or key prints guidance and starts nothing', async () => {
    const root = project();
    const harness = makeDeps();
    const result = await executeShareCli(['--tunnel', 'openai', '--project', root], harness.deps);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('needs a tunnel id');
    expect(result.output).toContain('Nothing was started');
    expect(harness.spawned).toEqual([]);
    expect(harness.servers).toEqual([]);
  });

  it('--tunnel openai without any key source guides instead of crashing', async () => {
    const root = project();
    const harness = makeDeps({
      loadTunnelConfig: () => ({
        tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
        apiKeyEnv: 'CONTROL_PLANE_API_KEY',
        linkedAt: '',
      }),
    });
    const result = await executeShareCli(['--tunnel', 'openai', '--project', root], harness.deps);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('CONTROL_PLANE_API_KEY');
    expect(result.output).toContain('Nothing was started');
    expect(harness.spawned).toEqual([]);
  });

  it('--tunnel openai with a stored (0600) key spawns the supervisor with env injection and tears down cleanly', async () => {
    const root = project();
    const harness = makeDeps({
      loadTunnelConfig: () => ({
        tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
        apiKeyEnv: 'CONTROL_PLANE_API_KEY',
        linkedAt: '',
        apiKey: 'sk-stored-secret',
      }),
    });
    const result = await runUntilStop(harness, ['--tunnel', 'openai', '--project', root]);
    expect(result.exitCode).toBe(0);
    expect(harness.spawned).toHaveLength(1);
    expect(harness.spawned[0]).toMatchObject({
      tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
      apiKeyEnv: 'CONTROL_PLANE_API_KEY',
      apiKey: 'sk-stored-secret',
    });
    const out = harness.written.join('');
    expect(out).toContain('Tunnel: OpenAI Secure MCP Tunnel tunnel_0123456789abcdef0123456789abcdef');
    // The stored key is injected into the child env, never printed to output.
    expect(out).not.toContain('sk-stored-secret');
    expect(harness.stopped).toEqual(['supervisor']);
    expect(harness.servers).toEqual([]); // the supervisor owns its own server
  });

  it('--tunnel openai prefers the exported env var over the stored key', async () => {
    const root = project();
    const harness = makeDeps({
      getEnv: (name) => (name === 'CONTROL_PLANE_API_KEY' ? 'sk-from-env' : undefined),
      loadTunnelConfig: () => ({
        tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
        apiKeyEnv: 'CONTROL_PLANE_API_KEY',
        linkedAt: '',
        apiKey: 'sk-stored-secret',
      }),
    });
    const result = await runUntilStop(harness, ['--tunnel', 'openai', '--project', root]);
    expect(result.exitCode).toBe(0);
    // Env wins: no stored-key env overlay is passed down.
    expect(harness.spawned[0]!.apiKey).toBeUndefined();
  });

  it('--tunnel-id works without a saved config (not persisted anywhere)', async () => {
    const root = project();
    const harness = makeDeps({
      getEnv: (name) => (name === 'CONTROL_PLANE_API_KEY' ? 'sk-from-env' : undefined),
    });
    const result = await runUntilStop(harness, [
      '--tunnel',
      'openai',
      '--tunnel-id',
      'tunnel_aabbccddeeff00112233445566778899',
      '--project',
      root,
    ]);
    expect(result.exitCode).toBe(0);
    expect(harness.spawned[0]!.tunnelId).toBe('tunnel_aabbccddeeff00112233445566778899');
  });

  it('--auth oauth without project OAuth config fails with an actionable message', async () => {
    const root = project();
    const harness = makeDeps();
    const result = await executeShareCli(['--auth', 'oauth', '--project', root], harness.deps);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('oauth');
    expect(result.output).toContain('--auth token');
    expect(result.output).toContain('Nothing was started');
    expect(harness.servers).toEqual([]);
  });

  it('--auth oauth with existing config boots the server in oauth mode', async () => {
    const root = project();
    const harness = makeDeps({ hasOAuthConfig: () => true });
    const result = await runUntilStop(harness, ['--auth', 'oauth', '--tunnel', 'none', '--project', root]);
    expect(result.exitCode).toBe(0);
    expect(harness.servers[0]!.auth).toBe('oauth');
    expect(harness.written.join('')).toContain('Auth: oauth');
  });

  it('rejects bad flags and --tunnel-id without --tunnel openai', async () => {
    const root = project();
    const harness = makeDeps();
    const bad = await executeShareCli(['--tunnel', 'bogus', '--project', root], harness.deps);
    expect(bad.exitCode).toBe(2);
    const stray = await executeShareCli(
      ['--tunnel-id', 'tunnel_0123456789abcdef0123456789abcdef', '--project', root],
      harness.deps,
    );
    expect(stray.exitCode).toBe(2);
    expect(stray.output).toContain('--tunnel-id requires --tunnel openai');
    expect(harness.servers).toEqual([]);
  });

  it('fails cleanly for a missing project folder', async () => {
    const harness = makeDeps();
    const result = await executeShareCli(
      ['--project', join(tmpdir(), 'ff-share-definitely-missing')],
      harness.deps,
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Not a project folder');
    expect(harness.servers).toEqual([]);
  });

  it('--json emits machine-readable share.ready/share.ended events instead of prose', async () => {
    const root = project();
    const harness = makeDeps();
    const result = await runUntilStop(harness, ['--tunnel', 'none', '--json', '--project', root]);
    expect(result.exitCode).toBe(0);
    const events = harness.written
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events[0]).toMatchObject({
      type: 'share.ready',
      mcpUrl: 'http://127.0.0.1:7777/mcp',
      auth: 'token',
      tunnel: 'none',
      toolsPreset: 'vibe',
    });
    expect(String(events[0]!.authorization)).toMatch(/^Bearer [A-Za-z0-9_-]{30,}$/);
    expect(events[events.length - 1]).toEqual({ type: 'share.ended', reason: 'signal' });
    // No human prose leaked into json mode.
    expect(harness.written.join('')).not.toContain('Press Ctrl+C');
  });

  it('--tools-preset is passed through to the share server', async () => {
    const root = project();
    const presets: Array<string | undefined> = [];
    const harness = makeDeps({
      startServer: async (input) => {
        presets.push(input.toolsPreset);
        return { port: 7_778, close: async () => undefined };
      },
    });
    const result = await runUntilStop(harness, [
      '--tunnel',
      'none',
      '--tools-preset',
      'adaptive',
      '--project',
      root,
    ]);
    expect(result.exitCode).toBe(0);
    expect(presets).toEqual(['adaptive']);
  });

  it('--json keeps errors machine-readable', async () => {
    const harness = makeDeps();
    const result = await executeShareCli(
      ['--auth', 'oauth', '--json', '--project', project()],
      harness.deps,
    );
    expect(result.exitCode).toBe(1);
    const event = JSON.parse(result.output.trim()) as Record<string, unknown>;
    expect(event.type).toBe('share.error');
    expect(String(event.message)).toContain('oauth');
  });

  it('share_session audit events record start and stop with reason and duration', async () => {
    const root = project();
    const auditEvents: Array<{ type: string; summary: string }> = [];
    const harness = makeDeps({
      startServer: async () => ({
        port: 7_779,
        close: async () => undefined,
        auditRecord: (event) => {
          auditEvents.push(event);
        },
      }),
    });
    const result = await runUntilStop(harness, ['--tunnel', 'none', '--project', root]);
    expect(result.exitCode).toBe(0);
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents[0]!.type).toBe('share_session');
    expect(auditEvents[0]!.summary).toContain('start tunnel=none auth=token preset=vibe port=7779');
    expect(auditEvents[0]!.summary).toContain('ttlMinutes=120');
    expect(auditEvents[1]!.summary).toContain('stop reason=signal durationMs=');
  });

  it('--ttl expires the session on its own and reports the reason (no signal needed)', async () => {
    const root = project();
    const auditEvents: Array<{ type: string; summary: string }> = [];
    const harness = makeDeps({
      startServer: async () => ({
        port: 7_780,
        close: async () => undefined,
        auditRecord: (event) => {
          auditEvents.push(event);
        },
      }),
    });
    // 0.001 minutes = 60ms: the TTL fires without anyone releasing the stop signal.
    const result = await executeShareCli(
      ['--tunnel', 'none', '--ttl', '0.001', '--project', root],
      harness.deps,
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('TTL expired');
    expect(auditEvents[1]?.summary).toContain('reason=ttl-expired');
  });

  it('--json share.ended carries the stop reason and ready carries ttlMinutes', async () => {
    const root = project();
    const harness = makeDeps();
    const result = await executeShareCli(
      ['--tunnel', 'none', '--ttl', '0.001', '--json', '--project', root],
      harness.deps,
    );
    expect(result.exitCode).toBe(0);
    const events = result.output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events[0]).toMatchObject({ type: 'share.ready', ttlMinutes: 0.001 });
    expect(events[events.length - 1]).toEqual({ type: 'share.ended', reason: 'ttl-expired' });
  });

  it('--ttl validates its value', async () => {
    const harness = makeDeps();
    const bad = await executeShareCli(['--ttl', 'abc', '--project', project()], harness.deps);
    expect(bad.exitCode).toBe(2);
    expect(bad.output).toContain('--ttl requires a non-negative number');
  });

  it('--tunnel cloudflare --named runs a stable named tunnel on the hostname', async () => {
    const root = project();
    const namedInputs: Array<{ targetPort: number; named?: string }> = [];
    const harness = makeDeps({
      startCloudflareTunnel: async (input) => {
        namedInputs.push(input);
        return { publicUrl: 'https://trial-mcp.example.com', stop: async () => undefined };
      },
    });
    const result = await runUntilStop(harness, [
      '--tunnel',
      'cloudflare',
      '--named',
      'trial-mcp.example.com',
      '--project',
      root,
    ]);
    expect(result.exitCode).toBe(0);
    expect(namedInputs[0]).toMatchObject({ named: 'trial-mcp.example.com' });
    expect(harness.written.join('')).toContain('MCP URL: https://trial-mcp.example.com/mcp');
  });

  it('--named conflicts with non-cloudflare tunnel modes at parse time', async () => {
    const harness = makeDeps();
    const bad = await executeShareCli(
      ['--tunnel', 'none', '--named', 'trial-mcp.example.com', '--project', project()],
      harness.deps,
    );
    expect(bad.exitCode).toBe(2);
    expect(bad.output).toContain('--named only applies to --tunnel cloudflare');
  });
});
