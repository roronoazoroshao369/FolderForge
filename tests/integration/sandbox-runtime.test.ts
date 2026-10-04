import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { buildRegistry } from '../../src/tools/index.js';

/**
 * Real container-runtime isolation proof for danger-mode command execution.
 *
 * Unlike tests/unit/sandbox-launcher.test.ts (argv shape only), these tests run
 * real commands through the full shell_exec / process_start pipeline inside a
 * real Docker/Podman container and observe the isolation from the inside.
 *
 * Prerequisites (environment, not code):
 *   FOLDERFORGE_SANDBOX_IMAGE   digest-pinned image already present locally
 *   FOLDERFORGE_SANDBOX_RUNTIME docker (default) or podman
 *   FOLDERFORGE_REQUIRE_RUNTIME_TESTS=1  fail instead of skipping when the
 *                               prerequisites are missing (set in CI so a
 *                               missing runtime can never pass silently)
 */
const RUNTIME = (process.env.FOLDERFORGE_SANDBOX_RUNTIME ?? 'docker') as 'docker' | 'podman';
const IMAGE = (process.env.FOLDERFORGE_SANDBOX_IMAGE ?? '').trim();
const REQUIRED = process.env.FOLDERFORGE_REQUIRE_RUNTIME_TESTS === '1';
const DIGEST = /@sha256:[a-f0-9]{64}$/i;
const ABSENT_DIGEST = `docker.io/library/alpine@sha256:${'1'.repeat(64)}`;

function runtimeAvailable(): { ready: boolean; reason: string } {
  if (!DIGEST.test(IMAGE)) {
    return { ready: false, reason: 'FOLDERFORGE_SANDBOX_IMAGE is unset or not digest-pinned (@sha256:<64 hex>)' };
  }
  const probe = spawnSync(RUNTIME, ['image', 'inspect', IMAGE], { stdio: 'pipe', timeout: 30_000 });
  if (probe.error || probe.status !== 0) {
    return { ready: false, reason: `${RUNTIME} is unavailable or image ${IMAGE} is not present locally` };
  }
  return { ready: true, reason: '' };
}

interface ShellData {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function freshRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function buildSandboxedRegistry(root: string, sandbox: Record<string, unknown>) {
  const config = defaultConfig(root);
  config.policy.defaultMode = 'danger';
  config.rateLimit.enabled = false;
  config.terminal.sandbox = sandbox as unknown as typeof config.terminal.sandbox;
  return buildRegistry(new Container(config));
}

function containerRunning(marker: string): boolean {
  const ps = spawnSync(RUNTIME, ['ps', '--no-trunc', '--format', '{{.Command}}'], { stdio: 'pipe', encoding: 'utf8' });
  return ps.status === 0 && ps.stdout.includes(marker);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return predicate();
}

/** Force-remove any container this suite started so a failing test never leaks one. */
function reapTestContainers(): void {
  const ps = spawnSync(RUNTIME, ['ps', '--no-trunc', '--format', '{{.ID}} {{.Command}}'], { stdio: 'pipe', encoding: 'utf8' });
  if (ps.status !== 0) return;
  const ids = ps.stdout
    .split('\n')
    .filter((line) => line.includes('ffrt-'))
    .map((line) => line.split(' ')[0])
    .filter((id): id is string => Boolean(id));
  if (ids.length > 0) spawnSync(RUNTIME, ['rm', '-f', ...ids], { stdio: 'pipe' });
}

// ---------------------------------------------------------------------------
// No container runtime required: the pipeline must refuse, never fall back.
// ---------------------------------------------------------------------------
describe('danger command execution never falls back to the host', () => {
  let root: string;

  beforeEach(() => {
    root = freshRoot('folderforge-nofallback-');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('denies shell_exec in danger without a container sandbox and runs nothing on the host', async () => {
    const config = defaultConfig(root);
    config.policy.defaultMode = 'danger';
    config.rateLimit.enabled = false;
    const registry = buildRegistry(new Container(config));

    const marker = join(root, 'host-ran.txt');
    const result = await registry.call('shell_exec', { command: 'echo host > host-ran.txt' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/terminal\.sandbox\.mode docker or podman/);
    expect(existsSync(marker)).toBe(false);
  });

  it('denies process_start in danger without a container sandbox and starts nothing', async () => {
    const config = defaultConfig(root);
    config.policy.defaultMode = 'danger';
    config.rateLimit.enabled = false;
    const registry = buildRegistry(new Container(config));

    const marker = join(root, 'host-proc.txt');
    const result = await registry.call('process_start', { command: 'echo host > host-proc.txt' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/terminal\.sandbox\.mode docker or podman/);
    expect(existsSync(marker)).toBe(false);
  });

  it('fails closed when the configured runtime binary is missing instead of using the host shell', async () => {
    const registry = buildSandboxedRegistry(root, {
      mode: RUNTIME,
      image: `docker.io/library/alpine@sha256:${'a'.repeat(64)}`,
    });
    const emptyBin = join(root, 'empty-bin');
    mkdirSync(emptyBin);
    vi.stubEnv('PATH', emptyBin);

    const marker = join(root, 'fallback-ran.txt');
    const result = await registry.call('shell_exec', { command: 'echo host > fallback-ran.txt' });

    expect(result.ok).toBe(false);
    expect((result.data as { exitCode?: number | null } | undefined)?.exitCode ?? null).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  it('keeps hard-deny precedence when the trusted-host escape hatch is enabled', async () => {
    const config = defaultConfig(root);
    config.policy.defaultMode = 'danger';
    config.rateLimit.enabled = false;
    config.terminal.sandbox = { mode: 'process', requireInDanger: false };
    const registry = buildRegistry(new Container(config));

    const result = await registry.call('shell_exec', { command: 'rm -rf /' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Blocked destructive command/);
  });
});

// ---------------------------------------------------------------------------
// Real container runtime.
// ---------------------------------------------------------------------------
const prerequisites = runtimeAvailable();

describe('container runtime prerequisites', () => {
  it.skipIf(!REQUIRED)('are present when FOLDERFORGE_REQUIRE_RUNTIME_TESTS=1 (a missing runtime is a failure, not a skip)', () => {
    expect(prerequisites.reason).toBe('');
    expect(prerequisites.ready).toBe(true);
  });
});

describe.skipIf(!prerequisites.ready)('real container isolation for shell_exec and process_start', () => {
  let root: string;
  let registry: ReturnType<typeof buildSandboxedRegistry>;

  beforeEach(() => {
    root = freshRoot('folderforge-runtime-');
    registry = buildSandboxedRegistry(root, { mode: RUNTIME, image: IMAGE, network: 'none' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    reapTestContainers();
    rmSync(root, { recursive: true, force: true });
  });

  async function sh(command: string, extra: Record<string, unknown> = {}): Promise<{ ok: boolean; error?: string; data: ShellData }> {
    const result = await registry.call('shell_exec', { command, ...extra });
    return result as unknown as { ok: boolean; error?: string; data: ShellData };
  }

  it('runs commands inside a container, not on the host', async () => {
    const result = await sh('hostname');
    expect(result.ok).toBe(true);
    expect(result.data.exitCode).toBe(0);
    expect(result.data.stdout.trim()).not.toBe('');
    expect(result.data.stdout.trim()).not.toBe(hostname());
  });

  it('runs as the unprivileged host uid/gid with no capabilities and no-new-privileges', async () => {
    const result = await sh('id -u; id -g; grep -E "^(CapEff|NoNewPrivs):" /proc/self/status');
    expect(result.ok).toBe(true);
    const lines = result.data.stdout.split('\n').map((line) => line.trim());
    if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
      expect(lines[0]).toBe(String(process.getuid()));
      expect(lines[1]).toBe(String(process.getgid()));
    }
    expect(lines.find((line) => line.startsWith('CapEff'))).toMatch(/CapEff:\s+0+$/);
    expect(lines.find((line) => line.startsWith('NoNewPrivs'))).toMatch(/NoNewPrivs:\s+1$/);
  });

  it('mounts only the workspace: cwd maps into /workspace and writes persist on the host', async () => {
    mkdirSync(join(root, 'sub'));
    const top = await sh('pwd; echo from-container > top.txt');
    expect(top.ok).toBe(true);
    expect(top.data.stdout.trim()).toBe('/workspace');
    expect(readFileSync(join(root, 'top.txt'), 'utf8').trim()).toBe('from-container');

    const nested = await sh('pwd', { cwd: 'sub' });
    expect(nested.ok).toBe(true);
    expect(nested.data.stdout.trim()).toBe('/workspace/sub');
  });

  it('does not expose host paths outside the workspace or host environment variables', async () => {
    const outside = freshRoot('folderforge-outside-');
    try {
      const hostFile = join(outside, 'host-secret.txt');
      writeFileSync(hostFile, 'do-not-leak');
      vi.stubEnv('FF_HOST_SECRET_PROBE', 'leaked-value');

      const result = await sh(`ls "${hostFile}" 2>&1; env | grep -c FF_HOST_SECRET_PROBE`);
      expect(result.data.stdout).toMatch(/No such file or directory/);
      expect(result.data.stdout).not.toContain('do-not-leak');
      expect(result.data.stdout.trim().split('\n').pop()).toBe('0');
      expect(result.data.stdout).not.toContain('leaked-value');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('has no network by default: only loopback exists and outbound connections fail', async () => {
    const result = await sh('ls /sys/class/net; wget -T 3 -q -O- http://1.1.1.1/ >/dev/null 2>&1; echo net-rc=$?');
    const out = result.data.stdout.trim().split('\n');
    expect(out[0]).toBe('lo');
    expect(out).not.toContain('eth0');
    expect(out[out.length - 1]).not.toBe('net-rc=0');
  });

  it('has a read-only root, a writable noexec /tmp', async () => {
    const result = await sh(
      'touch /etc/ff-probe 2>/dev/null; echo root-rw-rc=$?; ' +
        'printf "#!/bin/sh\\necho ran\\n" > /tmp/probe.sh; echo tmp-write-rc=$?; ' +
        'chmod +x /tmp/probe.sh; /tmp/probe.sh >/dev/null 2>&1; echo tmp-exec-rc=$?',
    );
    const out = result.data.stdout;
    expect(out).not.toContain('root-rw-rc=0');
    expect(out).toContain('tmp-write-rc=0');
    expect(out).not.toContain('tmp-exec-rc=0');
  });

  it('enforces pid and memory cgroup limits when the runtime exposes them', async () => {
    const result = await sh(
      'cat /sys/fs/cgroup/pids.max 2>/dev/null || echo unavailable; cat /sys/fs/cgroup/memory.max 2>/dev/null || echo unavailable',
    );
    const [pids, memory] = result.data.stdout.trim().split('\n');
    if (pids !== 'unavailable') expect(Number(pids)).toBe(128);
    if (memory !== 'unavailable') expect(Number(memory)).toBe(512 * 1024 * 1024);
  });

  it('propagates a non-zero exit code', async () => {
    const result = await sh('exit 7');
    expect(result.ok).toBe(false);
    expect(result.data.exitCode).toBe(7);
    expect(result.error).toBe('Command exited with code 7.');
  });

  it('never pulls a missing image and does not run the command on the host', async () => {
    const missing = buildSandboxedRegistry(root, { mode: RUNTIME, image: ABSENT_DIGEST, network: 'none' });
    const marker = join(root, 'should-not-exist.txt');
    const result = await missing.call('shell_exec', { command: 'echo x > should-not-exist.txt' });

    expect(result.ok).toBe(false);
    expect(existsSync(marker)).toBe(false);
    const inspect = spawnSync(RUNTIME, ['image', 'inspect', ABSENT_DIGEST], { stdio: 'pipe' });
    expect(inspect.status).not.toBe(0);
  });

  // KNOWN DEFECT (risk R11): a natural shell_exec timeout kills only the runtime
  // CLI process tree on the host; the container keeps running, with write access
  // to the workspace, after the tool reported failure. `it.fails` keeps CI honest:
  // it passes while the defect exists and turns red once the defect is fixed,
  // forcing this marker to be removed.
  it.fails('reaps the container when shell_exec times out (KNOWN DEFECT R11)', async () => {
    const marker = `ffrt-timeout-${Math.random().toString(36).slice(2, 10)}`;
    const started = Date.now();
    const result = await sh(`echo ${marker}; sleep 300`, { timeoutMs: 1_500 });
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(await waitFor(() => !containerRunning(marker), 10_000)).toBe(true);
  }, 40_000);

  // KNOWN DEFECT (risk R11): SIGKILL of the runtime CLI (process_kill) orphans the container.
  it.fails('process_kill (SIGKILL) reaps the container (KNOWN DEFECT R11)', async () => {
    const marker = `ffrt-kill-${Math.random().toString(36).slice(2, 10)}`;
    const started = await registry.call('process_start', { command: `echo ${marker}; sleep 300` });
    expect(started.ok).toBe(true);
    const sessionId = String((started.data as { sessionId: string }).sessionId);
    expect(await waitFor(() => containerRunning(marker), 15_000)).toBe(true);

    const killed = await registry.call('process_kill', { sessionId });
    expect(killed.ok).toBe(true);
    expect(await waitFor(() => !containerRunning(marker), 10_000)).toBe(true);
  }, 40_000);

  it('process_start runs in a container and process_stop reaps it', async () => {
    const marker = `ffrt-proc-${Math.random().toString(36).slice(2, 10)}`;
    const started = await registry.call('process_start', { command: `echo ${marker}; id -u; sleep 300` });
    expect(started.ok).toBe(true);
    const sessionId = String((started.data as { sessionId: string }).sessionId);

    expect(await waitFor(() => containerRunning(marker), 15_000)).toBe(true);

    const stopped = await registry.call('process_stop', { sessionId });
    expect(stopped.ok).toBe(true);
    expect(await waitFor(() => !containerRunning(marker), 15_000)).toBe(true);
  }, 40_000);
});
