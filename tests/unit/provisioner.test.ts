import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FleetManager, publicFleetInstance } from '../../src/provisioner/fleet-manager.js';

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

  it('changes the tool preset, persists it, and validates the allowed list', () => {
    const { root, project } = fixture();
    const fleet = new FleetManager(root);
    const { instance } = fleet.create({ projectPath: project });
    expect(instance.toolsPreset).toBe('vibe');

    const updated = fleet.setToolsPreset(instance.id, 'full');
    expect(updated.toolsPreset).toBe('full');
    expect(new FleetManager(root).get(instance.id).toolsPreset).toBe('full');

    expect(() => fleet.setToolsPreset(instance.id, 'nope')).toThrow(/Invalid tools preset/);
    expect(() => fleet.setToolsPreset('flt_missing', 'full')).toThrow(/Unknown fleet instance/);
  });

  it('changes the policy mode, persists it, and validates the allowed list', () => {
    const { root, project } = fixture();
    const fleet = new FleetManager(root);
    const { instance } = fleet.create({ projectPath: project });

    const updated = fleet.setPolicyMode(instance.id, 'safe');
    expect(updated.policyMode).toBe('safe');
    expect(new FleetManager(root).get(instance.id).policyMode).toBe('safe');

    expect(() => fleet.setPolicyMode(instance.id, 'nope')).toThrow(/Invalid policy mode/);
    expect(() => fleet.setPolicyMode('flt_missing', 'safe')).toThrow(/Unknown fleet instance/);
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

  it('restarts an instance (stop + start cycle)', () => {
    const { root, project } = fixture();
    const calls: string[] = [];
    const fleet = new FleetManager(root, {
      mainJs: HERE,
      spawn: stubSpawner(calls),
      stopSession: (sessionId) => {
        calls.push(`stop ${sessionId}`);
      },
    });
    const { instance } = fleet.create({ projectPath: project });
    fleet.start(instance.id);
    const restarted = fleet.restart(instance.id);
    expect(restarted.state).toBe('running');
    expect(restarted.sessionId).toBe('proc_stub_2');
    expect(calls).toContain('stop proc_stub_1');
  });

  it('reports health from state, pid liveness, and endpoint probe', async () => {
    const { root, project } = fixture();
    const fleet = new FleetManager(root, {
      mainJs: HERE,
      spawn: stubSpawner([]),
      probe: async () => true,
      isAlive: () => true,
    });
    const { instance } = fleet.create({ projectPath: project });
    const down = await fleet.health(instance.id);
    expect(down.healthy).toBe(false);
    expect(down.endpointOk).toBe(false);
    fleet.start(instance.id);
    const up = await fleet.health(instance.id);
    expect(up).toMatchObject({
      id: instance.id,
      state: 'running',
      pidAlive: true,
      endpointOk: true,
      healthy: true,
    });
  });

  it('marks a crashed instance failed and auto-restarts only when enabled', () => {
    const { root, project } = fixture();
    const calls: string[] = [];
    const exitListeners = new Map<string, () => void>();
    const fleet = new FleetManager(root, {
      mainJs: HERE,
      spawn: stubSpawner(calls),
      stopSession: () => undefined,
      onExit: (sessionId, listener) => {
        exitListeners.set(sessionId, listener);
        return () => {
          exitListeners.delete(sessionId);
        };
      },
      autoRestartCooldownMs: 0,
    });
    const { instance } = fleet.create({ projectPath: project });
    fleet.start(instance.id);

    // Crash without autoRestart -> failed, stays down.
    exitListeners.get('proc_stub_1')?.();
    expect(fleet.get(instance.id).state).toBe('failed');
    expect(calls.filter((call) => call.includes('--tools-preset'))).toHaveLength(1);

    // Enable auto-restart -> the next crash restarts exactly once.
    fleet.setAutoRestart(instance.id, true);
    fleet.start(instance.id);
    exitListeners.get('proc_stub_2')?.();
    const after = fleet.get(instance.id);
    expect(after.state).toBe('running');
    expect(after.sessionId).toBe('proc_stub_3');
  });

  it('rate-limits auto-restart within the cooldown window', () => {
    const { root, project } = fixture();
    const exitListeners = new Map<string, () => void>();
    const fleet = new FleetManager(root, {
      mainJs: HERE,
      spawn: stubSpawner([]),
      stopSession: () => undefined,
      onExit: (sessionId, listener) => {
        exitListeners.set(sessionId, listener);
        return () => {
          exitListeners.delete(sessionId);
        };
      },
    });
    const { instance } = fleet.create({ projectPath: project });
    fleet.setAutoRestart(instance.id, true);
    fleet.start(instance.id); // proc_stub_1
    exitListeners.get('proc_stub_1')?.(); // crash -> auto-restart -> proc_stub_2
    expect(fleet.get(instance.id).state).toBe('running');
    exitListeners.get('proc_stub_2')?.(); // second crash inside cooldown -> stays failed
    expect(fleet.get(instance.id).state).toBe('failed');
  });

  it('supports loopback no-auth instances without persisting a credential', () => {
    const { root, project } = fixture();
    const fleet = new FleetManager(root);
    const created = fleet.create({ projectPath: project, authMode: 'none' });
    expect(created.token).toBe('');
    expect(created.apiKey).toBeUndefined();
    expect(created.instance.authMode).toBe('none');
    expect(created.instance.tokenSha256).toBeUndefined();

    const state = readFileSync(join(root, '.folderforge', 'fleet.json'), 'utf8');
    expect(state).toContain('"authMode": "none"');
    const config = readFileSync(join(root, '.folderforge', 'fleet', `${created.instance.id}.yaml`), 'utf8');
    expect(config).toContain('mode: "none"');
    expect(config).not.toContain('requireAuth: true');
    expect(config).not.toContain('token:');
  });

  it('supports API-key auth with generated or operator-supplied credentials and hash-only Fleet state', () => {
    const { root, project } = fixture();
    const fleet = new FleetManager(root);
    const created = fleet.create({ projectPath: project, authMode: 'api-key', apiKey: 'operator-key-123' });
    expect(created.apiKey).toBe('operator-key-123');
    expect(created.instance.authMode).toBe('api-key');
    expect(created.instance.tokenSha256).toMatch(/^[0-9a-f]{64}$/);

    const state = readFileSync(join(root, '.folderforge', 'fleet.json'), 'utf8');
    expect(state).not.toContain('operator-key-123');
    const config = readFileSync(join(root, '.folderforge', 'fleet', `${created.instance.id}.yaml`), 'utf8');
    expect(config).toContain('apiKeys:');
    expect(config).toContain('operator-key-123');
    expect(config).toContain('mode: "token"');

    const rotated = fleet.rotateCredential(created.instance.id);
    expect(rotated.kind).toBe('api-key');
    expect(rotated.credential).toMatch(/^ffk_/);
    expect(rotated.credential).not.toBe('operator-key-123');
  });

  it('supports OAuth auth metadata and validates required resource-server fields', () => {
    const { root, project } = fixture();
    const fleet = new FleetManager(root);
    expect(() => fleet.create({ projectPath: project, authMode: 'oauth' })).toThrow(/oauth configuration/i);

    const created = fleet.create({
      projectPath: project,
      authMode: 'oauth',
      oauth: {
        resource: 'https://mcp.example.com/',
        issuer: 'https://tenant.example.com/',
        scopes: ['folderforge:read', 'folderforge:write'],
        readScope: 'folderforge:read',
        writeScope: 'folderforge:write',
        clientRegistration: 'dcr',
      },
    });
    expect(created.instance.authMode).toBe('oauth');
    expect(created.instance.oauth?.resource).toBe('https://mcp.example.com');
    expect(created.instance.tokenSha256).toBeUndefined();
    const config = readFileSync(join(root, '.folderforge', 'fleet', `${created.instance.id}.yaml`), 'utf8');
    expect(config).toContain('mode: "oauth"');
    expect(config).toContain('resource: "https://mcp.example.com"');
    expect(config).toContain('issuer: "https://tenant.example.com"');
    expect(config).toContain('clientRegistration: "dcr"');
  });

  it('changes auth mode and returns static credentials exactly on the issuing call', () => {
    const { root, project } = fixture();
    const fleet = new FleetManager(root, { mainJs: HERE, spawn: stubSpawner([]) });
    const created = fleet.create({ projectPath: project, authMode: 'none' });
    const tokenResult = fleet.setAuth(created.instance.id, { mode: 'token' });
    expect(tokenResult.token).toBeTruthy();
    expect(tokenResult.instance.authMode).toBe('token');
    expect(tokenResult.restartRequired).toBe(false);

    fleet.start(created.instance.id);
    const apiResult = fleet.setAuth(created.instance.id, { mode: 'api-key' });
    expect(apiResult.apiKey).toMatch(/^ffk_/);
    expect(apiResult.restartRequired).toBe(true);
    expect(fleet.get(created.instance.id).authMode).toBe('api-key');
  });

  it('starts OpenAI Secure MCP Tunnel with an environment reference and never puts the API-key value in state or argv', () => {
    const { root, project } = fixture();
    const calls: string[] = [];
    const previous = process.env.FOLDERFORGE_TEST_CONTROL_KEY;
    process.env.FOLDERFORGE_TEST_CONTROL_KEY = 'super-secret-control-plane-value';
    try {
      const fleet = new FleetManager(root, {
        mainJs: HERE,
        spawn: stubSpawner(calls),
        stopSession: (sessionId) => calls.push(`stop ${sessionId}`),
      });
      const { instance } = fleet.create({ projectPath: project });
      const started = fleet.startOpenAiTunnel(instance.id, {
        tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
        apiKeyEnv: 'FOLDERFORGE_TEST_CONTROL_KEY',
        oauth: false,
      });
      expect(started.openAiTunnel?.state).toBe('running');
      expect(started.openAiTunnel?.apiKeyEnv).toBe('FOLDERFORGE_TEST_CONTROL_KEY');
      expect(calls[0]).toContain('connect chatgpt --openai-tunnel');
      expect(calls[0]).toContain('--api-key-env');
      expect(calls[0]).toContain('FOLDERFORGE_TEST_CONTROL_KEY');
      expect(calls[0]).not.toContain('super-secret-control-plane-value');

      const state = readFileSync(join(root, '.folderforge', 'fleet.json'), 'utf8');
      expect(state).not.toContain('super-secret-control-plane-value');
      expect(state).toContain('FOLDERFORGE_TEST_CONTROL_KEY');
      const stopped = fleet.stopOpenAiTunnel(instance.id);
      expect(stopped.openAiTunnel?.state).toBe('stopped');
      expect(calls).toContain('stop proc_stub_1');
    } finally {
      if (previous === undefined) delete process.env.FOLDERFORGE_TEST_CONTROL_KEY;
      else process.env.FOLDERFORGE_TEST_CONTROL_KEY = previous;
    }
  });

  it('fails closed when an OpenAI tunnel API-key environment reference is missing', () => {
    const { root, project } = fixture();
    const fleet = new FleetManager(root, { mainJs: HERE, spawn: stubSpawner([]) });
    const { instance } = fleet.create({ projectPath: project });
    delete process.env.FOLDERFORGE_DEFINITELY_MISSING_KEY;
    expect(() =>
      fleet.startOpenAiTunnel(instance.id, {
        tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
        apiKeyEnv: 'FOLDERFORGE_DEFINITELY_MISSING_KEY',
      }),
    ).toThrow(/not set in the Mission Control process/);
  });

  it('accepts an operator-pasted key when the env var is unset, injecting it into the child env only', () => {
    const { root, project } = fixture();
    const calls: string[] = [];
    const envs: Array<Record<string, string> | undefined> = [];
    delete process.env.FOLDERFORGE_PASTED_KEY_SLOT;
    try {
      const fleet = new FleetManager(root, {
        mainJs: HERE,
        spawn: (command, _cwd, env) => {
          calls.push(command);
          envs.push(env);
          return { sessionId: `proc_stub_${calls.length}`, pid: 4242 };
        },
        stopSession: (sessionId) => calls.push(`stop ${sessionId}`),
      });
      const { instance } = fleet.create({ projectPath: project });
      const started = fleet.startOpenAiTunnel(instance.id, {
        tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
        apiKeyEnv: 'FOLDERFORGE_PASTED_KEY_SLOT',
        apiKey: 'sk-pasted-secret',
        oauth: false,
      });
      expect(started.openAiTunnel?.state).toBe('running');
      // The key rides the child env overlay, never the command string.
      expect(envs[0]).toMatchObject({ FOLDERFORGE_PASTED_KEY_SLOT: 'sk-pasted-secret' });
      expect(envs[0]?.FOLDERFORGE_LEASE_ID).toMatch(/^lse_/);
      expect(calls[0]).not.toContain('sk-pasted-secret');
      // ...and it persists in the 0600 fleet state so a later restart needs no re-paste.
      const state = readFileSync(join(root, '.folderforge', 'fleet.json'), 'utf8');
      expect(state).toContain('sk-pasted-secret');
      const stopped = fleet.stopOpenAiTunnel(instance.id);
      expect(stopped.openAiTunnel?.state).toBe('stopped');
    } finally {
      delete process.env.FOLDERFORGE_PASTED_KEY_SLOT;
    }
  });

  it('publicFleetInstance strips the pasted key while the record keeps it', () => {
    const { root, project } = fixture();
    delete process.env.FOLDERFORGE_PASTED_KEY_SLOT;
    const fleet = new FleetManager(root, { mainJs: HERE, spawn: stubSpawner([]) });
    const { instance } = fleet.create({ projectPath: project });
    const started = fleet.startOpenAiTunnel(instance.id, {
      tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
      apiKeyEnv: 'FOLDERFORGE_PASTED_KEY_SLOT',
      apiKey: 'sk-pasted-secret',
      oauth: false,
    });
    // The internal record keeps the key (for restart + child env injection)…
    expect(started.openAiTunnel?.apiKey).toBe('sk-pasted-secret');
    // …while every API surface sees a stripped copy.
    const pub = publicFleetInstance(started);
    expect(JSON.stringify(pub)).not.toContain('sk-pasted-secret');
    expect(pub.openAiTunnel?.tunnelId).toBe('tunnel_0123456789abcdef0123456789abcdef');
  });

  it('assigns a fresh lease id on every start and fences stale exit callbacks', () => {
    const { root, project } = fixture();
    const exitListeners = new Map<string, () => void>();
    const fleet = new FleetManager(root, {
      mainJs: HERE,
      spawn: stubSpawner([]),
      stopSession: () => undefined,
      onExit: (sessionId, listener) => {
        exitListeners.set(sessionId, listener);
        return () => {
          exitListeners.delete(sessionId);
        };
      },
    });
    const { instance } = fleet.create({ projectPath: project });

    fleet.start(instance.id);
    const firstLease = fleet.get(instance.id).leaseId;
    expect(firstLease).toMatch(/^lse_/);
    const staleExit = exitListeners.get('proc_stub_1');

    fleet.stop(instance.id);
    fleet.start(instance.id);
    const current = fleet.get(instance.id);
    expect(current.leaseId).toMatch(/^lse_/);
    expect(current.leaseId).not.toBe(firstLease);

    // A stale exit from the previous generation must not fail the new one.
    staleExit?.();
    const after = fleet.get(instance.id);
    expect(after.state).toBe('running');
    expect(after.sessionId).toBe('proc_stub_2');
  });

  it('load reconciles stale pids: dead, orphaned, foreign, and unverifiable', () => {
    const { root, project } = fixture();
    const boot = new FleetManager(root, { mainJs: HERE, spawn: stubSpawner([]) });
    const { instance } = boot.create({ projectPath: project });
    boot.start(instance.id); // pid 4001, state running, then the plane "dies"
    const configPath = join(root, '.folderforge', 'fleet', `${instance.id}.yaml`);

    // pid dead after the restart -> failed with a clear reason, pid cleared.
    const dead = new FleetManager(root, { isAlive: () => false });
    const deadRecord = dead.get(instance.id);
    expect(deadRecord.state).toBe('failed');
    expect(deadRecord.lastError).toContain('no longer running');
    expect(deadRecord.pid).toBeUndefined();
    expect(deadRecord.sessionId).toBeUndefined();

    // pid alive with a matching fingerprint -> orphan kept for start() to reap.
    const orphan = new FleetManager(root, {
      isAlive: () => true,
      cmdlineOf: () => `node /fake/main.js --project ${project} --config ${configPath}`,
    });
    const orphanRecord = orphan.get(instance.id);
    expect(orphanRecord.state).toBe('failed');
    expect(orphanRecord.lastError).toContain('Orphaned fleet process 4001');
    expect(orphanRecord.pid).toBe(4001);

    // pid alive but foreign -> pid cleared, actionable error, never killed.
    const foreign = new FleetManager(root, {
      isAlive: () => true,
      cmdlineOf: () => 'python3 -m http.server 7410',
    });
    const foreignRecord = foreign.get(instance.id);
    expect(foreignRecord.state).toBe('failed');
    expect(foreignRecord.pid).toBeUndefined();
    expect(foreignRecord.lastError).toContain('unrelated process');

    // pid alive but unverifiable (e.g. win32) -> conservative: cleared, never killed.
    const unverifiable = new FleetManager(root, {
      isAlive: () => true,
      cmdlineOf: () => undefined,
    });
    const unknownRecord = unverifiable.get(instance.id);
    expect(unknownRecord.state).toBe('failed');
    expect(unknownRecord.pid).toBeUndefined();
    expect(unknownRecord.lastError).toContain('unverifiable');
  });

  it('start after a plane restart reaps a verified orphan instead of dying with EADDRINUSE', () => {
    const { root, project } = fixture();
    const alive = new Set<number>();
    const boot = new FleetManager(root, { mainJs: HERE, spawn: stubSpawner([]) });
    const { instance } = boot.create({ projectPath: project });
    boot.start(instance.id); // proc_stub_1, pid 4001
    alive.add(4001);

    const configPath = join(root, '.folderforge', 'fleet', `${instance.id}.yaml`);
    const killed: number[] = [];
    const calls: string[] = [];
    const fleet = new FleetManager(root, {
      mainJs: HERE,
      spawn: stubSpawner(calls),
      isAlive: (pid) => alive.has(pid),
      cmdlineOf: () => `node /fake/main.js --project ${project} --config ${configPath}`,
      killPidTree: (pid) => {
        killed.push(pid);
        alive.delete(pid);
      },
      reapGraceMs: 5,
    });
    expect(fleet.get(instance.id).state).toBe('failed');

    const started = fleet.start(instance.id);
    expect(killed).toEqual([4001]);
    expect(calls).toHaveLength(1);
    expect(started.state).toBe('running');
    expect(started.leaseId).toMatch(/^lse_/);
  });

  it('start refuses to kill a foreign or unverifiable process holding the recorded pid', () => {
    const { root, project } = fixture();
    const boot = new FleetManager(root, { mainJs: HERE, spawn: stubSpawner([]) });
    const { instance } = boot.create({ projectPath: project });
    boot.start(instance.id);

    const configPath = join(root, '.folderforge', 'fleet', `${instance.id}.yaml`);
    let cmdline: string | undefined = `node /fake/main.js --project ${project} --config ${configPath}`;
    const calls: string[] = [];
    const fleet = new FleetManager(root, {
      mainJs: HERE,
      spawn: stubSpawner(calls),
      isAlive: () => true,
      cmdlineOf: () => cmdline,
      killPidTree: () => {
        throw new Error('must never kill foreign pids');
      },
      reapGraceMs: 5,
    });
    // Loaded as our orphan; the pid is then reused by a foreign process.
    expect(fleet.get(instance.id).lastError).toContain('Orphaned');
    cmdline = 'python3 -m http.server 7410';
    expect(() => fleet.start(instance.id)).toThrow(/Refusing to kill a foreign process/);
    expect(calls).toHaveLength(0);

    cmdline = undefined; // unverifiable platform
    expect(() => fleet.start(instance.id)).toThrow(/cannot be verified/);
    expect(calls).toHaveLength(0);
  });

  it('start reports an orphan that refuses to die', () => {
    const { root, project } = fixture();
    const boot = new FleetManager(root, { mainJs: HERE, spawn: stubSpawner([]) });
    const { instance } = boot.create({ projectPath: project });
    boot.start(instance.id);

    const configPath = join(root, '.folderforge', 'fleet', `${instance.id}.yaml`);
    const fleet = new FleetManager(root, {
      mainJs: HERE,
      spawn: stubSpawner([]),
      isAlive: () => true,
      cmdlineOf: () => `node /fake/main.js --project ${project} --config ${configPath}`,
      killPidTree: () => undefined, // SIGTERM and SIGKILL both "fail"
      reapGraceMs: 5,
    });
    expect(() => fleet.start(instance.id)).toThrow(/did not die/);
  });

  it('surfaces an actionable EADDRINUSE error and never flaps auto-restart on it', () => {
    const { root, project } = fixture();
    const calls: string[] = [];
    const exitListeners = new Map<string, () => void>();
    const fleet = new FleetManager(root, {
      mainJs: HERE,
      spawn: stubSpawner(calls),
      stopSession: () => undefined,
      readSession: () => 'Error: listen EADDRINUSE: address already in use 127.0.0.1:7410',
      onExit: (sessionId, listener) => {
        exitListeners.set(sessionId, listener);
        return () => {
          exitListeners.delete(sessionId);
        };
      },
      autoRestartCooldownMs: 0,
    });
    const { instance } = fleet.create({ projectPath: project });
    fleet.setAutoRestart(instance.id, true);
    fleet.start(instance.id);
    exitListeners.get('proc_stub_1')?.();

    const failed = fleet.get(instance.id);
    expect(failed.state).toBe('failed');
    expect(failed.lastError).toContain('already in use');
    expect(failed.lastError).toContain('Free the port');
    expect(calls.filter((call) => call.includes('--tools-preset'))).toHaveLength(1);
  });

  it('shutdownAll stops every session and never auto-restarts (plane-stop-kills-tree)', () => {
    const { root, project } = fixture();
    const secondProject = join(root, 'project-b');
    mkdirSync(secondProject);
    const stopped: string[] = [];
    const exitListeners = new Map<string, () => void>();
    const fleet = new FleetManager(root, {
      mainJs: HERE,
      spawn: stubSpawner([]),
      stopSession: (sessionId) => {
        stopped.push(sessionId);
      },
      onExit: (sessionId, listener) => {
        exitListeners.set(sessionId, listener);
        return () => {
          exitListeners.delete(sessionId);
        };
      },
    });
    const first = fleet.create({ projectPath: project }).instance;
    const second = fleet.create({ projectPath: secondProject }).instance;
    fleet.setAutoRestart(first.id, true);
    fleet.start(first.id);
    fleet.start(second.id);

    fleet.shutdownAll();

    expect(stopped.sort()).toEqual(['proc_stub_1', 'proc_stub_2']);
    expect(fleet.get(first.id).state).toBe('stopped');
    expect(fleet.get(second.id).state).toBe('stopped');
    // Exit callbacks racing the shutdown must not mark failed or auto-restart.
    exitListeners.get('proc_stub_1')?.();
    exitListeners.get('proc_stub_2')?.();
    expect(fleet.get(first.id).state).toBe('stopped');
    expect(fleet.get(second.id).state).toBe('stopped');
    const reloaded = new FleetManager(root);
    expect(reloaded.get(first.id).state).toBe('stopped');
    expect(reloaded.get(second.id).state).toBe('stopped');
  });

  it('shutdownAll reaps a fingerprint-verified orphan even with no live session', () => {
    const { root, project } = fixture();
    const boot = new FleetManager(root, { mainJs: HERE, spawn: stubSpawner([]) });
    const { instance } = boot.create({ projectPath: project });
    boot.start(instance.id); // pid 4001 survives as an orphan

    const alive = new Set<number>([4001]);
    const killed: number[] = [];
    const configPath = join(root, '.folderforge', 'fleet', `${instance.id}.yaml`);
    const fleet = new FleetManager(root, {
      mainJs: HERE,
      spawn: stubSpawner([]),
      isAlive: (pid) => alive.has(pid),
      cmdlineOf: () => `node /fake/main.js --project ${project} --config ${configPath}`,
      killPidTree: (pid) => {
        killed.push(pid);
        alive.delete(pid);
      },
      reapGraceMs: 5,
    });
    expect(fleet.get(instance.id).state).toBe('failed');

    fleet.shutdownAll();
    expect(killed).toEqual([4001]);
    expect(fleet.get(instance.id).state).toBe('stopped');
  });
});
