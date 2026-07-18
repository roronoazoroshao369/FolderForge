import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChildMcpError,
  StdioChildClient,
  classifyChildFailure,
  type ChildMcpDiagnostic,
} from '../../src/adapters/child-mcp/client.js';

const fixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'diagnostic-mcp-server.mjs'
);

const clients: StdioChildClient[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stopAndWait(200)));
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function client(mode: string, options: { timeout?: number; stderrLimit?: number; pidFile?: string; cwd?: string } = {}) {
  const instance = new StdioChildClient({
    adapter: 'playwright',
    command: process.execPath,
    args: [fixture, mode, ...(options.pidFile ? [options.pidFile] : [])],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    requestTimeoutMs: options.timeout ?? 200,
    stderrLimit: options.stderrLimit ?? 16 * 1024,
  });
  clients.push(instance);
  return instance;
}

async function failure(action: () => Promise<unknown>): Promise<ChildMcpDiagnostic> {
  try {
    await action();
    throw new Error('Expected child MCP action to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(ChildMcpError);
    return (error as ChildMcpError).diagnostic;
  }
}

async function waitForExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  return false;
}

describe('StdioChildClient diagnostics', () => {
  it('completes initialize and tools/list successfully', async () => {
    const child = client('success');
    await child.start();
    const tools = await child.listTools();

    expect(child.isReady()).toBe(true);
    expect(tools.map((tool) => tool.name)).toEqual(['echo']);
    expect(child.diagnostic()).toBeNull();
  });


  it.each([
    ['spawn', { message: 'spawn ENOENT', code: 'ENOENT' }, 'executable_not_found'],
    ['initialize', { stderr: 'npm ERR! E404 package not found' }, 'npm_package_resolution_failure'],
    ['initialize', { stderr: 'network fetch failed EAI_AGAIN' }, 'network_or_cache_failure'],
    ['runtime', { stderr: "browser executable doesn't exist; run playwright install" }, 'missing_chromium'],
    ['runtime', { stderr: 'Failed to launch browser process' }, 'browser_launch_failure'],
    ['spawn', { stderr: 'Operation not permitted: macOS quarantine' }, 'permission_or_quarantine'],
    ['spawn', { stderr: 'Bad CPU type in executable' }, 'architecture_mismatch'],
    ['initialize', { stderr: 'Unsupported Node.js version; requires Node 22' }, 'unsupported_node_version'],
  ] as const)(
    'classifies %s diagnostics as %s',
    (phase, input, expected) => {
      expect(classifyChildFailure(phase, input)).toBe(expected);
    }
  );

  it('classifies spawn ENOENT without hanging', async () => {
    const child = new StdioChildClient({
      adapter: 'playwright',
      command: join(tmpdir(), 'folderforge-command-that-does-not-exist'),
      args: [],
      requestTimeoutMs: 100,
    });
    clients.push(child);

    const diagnostic = await failure(() => child.start());
    expect(diagnostic).toMatchObject({ phase: 'spawn', kind: 'executable_not_found', timedOut: false });
    expect(diagnostic.spawnError).toBeTruthy();
    expect(child.isReady()).toBe(false);
  });

  it('captures exit code 1 and actionable stderr before initialize', async () => {
    const diagnostic = await failure(() => client('exit-before-init').start());

    expect(diagnostic.phase).toBe('initialize');
    expect(diagnostic.kind).toBe('invalid_adapter_arguments');
    expect(diagnostic.exitCode).toBe(1);
    expect(diagnostic.stderrTail).toContain('invalid adapter arguments');
    expect(diagnostic.remediation).toContain('adapters.playwright.args');
  });

  it('bounds excessive stderr and redacts secret-like content', async () => {
    const diagnostic = await failure(() => client('stderr-flood-exit', { stderrLimit: 4096 }).start());

    expect(diagnostic.stderrTail.length).toBeLessThanOrEqual(4096);
    expect(diagnostic.stderrTail).toContain('[REDACTED]');
    expect(diagnostic.stderrTail).not.toContain(`sk-${'a'.repeat(32)}`);
  });

  it('classifies initialize timeout and cleans up the process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'folder forge ünicode-'));
    tempRoots.push(root);
    const pidFile = join(root, 'child.pid');
    const child = client('initialize-timeout', { timeout: 80, pidFile, cwd: root });

    const diagnostic = await failure(() => child.start());
    expect(diagnostic).toMatchObject({ phase: 'initialize', kind: 'initialize_timeout', timedOut: true });
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(await waitForExit(pid)).toBe(true);
  });

  it('classifies tools/list timeout separately from initialize', async () => {
    // Give process startup a realistic budget under a fully parallel test run;
    // keep the operation under test on its own short, deterministic timeout.
    const child = client('tools-list-timeout', { timeout: 500 });
    await child.start();

    const diagnostic = await failure(() => child.listTools(80));
    expect(diagnostic).toMatchObject({ phase: 'tools/list', kind: 'tools_list_timeout', timedOut: true });
    expect(child.isReady()).toBe(false);
  });

  it('treats malformed child stdout as a JSON-RPC protocol failure', async () => {
    const diagnostic = await failure(() => client('malformed').start());
    expect(diagnostic).toMatchObject({ phase: 'initialize', kind: 'malformed_json_rpc' });
  });

  it('rejects an invalid tools/list result', async () => {
    const child = client('invalid-tools-list');
    await child.start();

    const diagnostic = await failure(() => child.listTools());
    expect(diagnostic).toMatchObject({ phase: 'tools/list', kind: 'tools_list_failure' });
  });

  it('classifies a crash after readiness as runtime failure', async () => {
    const child = client('crash-after-ready');
    await child.start();
    await child.listTools();

    const diagnostic = await failure(() => child.callTool('echo', { text: 'hello' }));
    expect(diagnostic).toMatchObject({ phase: 'runtime', kind: 'runtime_crash', exitCode: 7 });
    expect(diagnostic.stderrTail).toContain('runtime browser crash');
    expect(child.isReady()).toBe(false);
  });
});
