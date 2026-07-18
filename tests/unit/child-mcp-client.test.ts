import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import {
  ChildMcpError,
  ChildMcpRequestError,
  StdioChildClient,
  classifyChildFailure,
  type ChildMcpDiagnostic,
} from '../../src/adapters/child-mcp/client.js';
import { ChildMcpRegistry } from '../../src/adapters/child-mcp/registry.js';

const fixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'diagnostic-mcp-server.mjs'
);

interface ClientOptions {
  timeout?: number;
  stderrLimit?: number;
  pidFile?: string;
  auxiliaryFile?: string;
  cwd?: string;
  maxCatalogTools?: number;
  maxCatalogPages?: number;
  onToolsListChanged?: () => void;
}

const clients: StdioChildClient[] = [];
const registries: ChildMcpRegistry[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((child) => child.stopAndWait(200)));
  for (const registry of registries.splice(0)) registry.stopAll();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function client(mode: string, options: ClientOptions = {}): StdioChildClient {
  const instance = new StdioChildClient({
    adapter: 'playwright',
    command: process.execPath,
    args: [
      fixture,
      mode,
      ...((options.auxiliaryFile ?? options.pidFile)
        ? [options.auxiliaryFile ?? options.pidFile!]
        : []),
    ],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    requestTimeoutMs: options.timeout ?? 200,
    stderrLimit: options.stderrLimit ?? 16 * 1024,
    ...(options.maxCatalogTools !== undefined
      ? { maxCatalogTools: options.maxCatalogTools }
      : {}),
    ...(options.maxCatalogPages !== undefined
      ? { maxCatalogPages: options.maxCatalogPages }
      : {}),
    ...(options.onToolsListChanged
      ? { onToolsListChanged: options.onToolsListChanged }
      : {}),
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function waitForFile(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(path)) return true;
    await sleep(10);
  }
  return false;
}

function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  const text = content?.find((block) => block.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error('Expected a text child MCP result.');
  return text;
}

describe('StdioChildClient diagnostics and protocol handling', () => {
  it('requests and negotiates the SDK latest protocol version', async () => {
    const child = client('success');
    await child.start();
    const tools = await child.listTools();

    expect(child.isReady()).toBe(true);
    expect(child.protocolVersion()).toBe(LATEST_PROTOCOL_VERSION);
    expect(child.supportsToolsListChanged()).toBe(false);
    expect(tools.map((tool) => tool.name)).toEqual(['echo']);
    expect(child.diagnostic()).toBeNull();
  });

  it('accepts a supported older protocol selected by the child', async () => {
    const child = client('legacy-protocol');
    await child.start();

    expect(child.protocolVersion()).toBe('2024-11-05');
    expect(child.isReady()).toBe(true);
  });

  it('rejects an unsupported protocol selected by the child', async () => {
    const child = client('unsupported-protocol');
    const diagnostic = await failure(() => child.start());

    expect(diagnostic).toMatchObject({
      phase: 'initialize',
      kind: 'unsupported_protocol_version',
    });
    expect(child.isReady()).toBe(false);
    expect(child.protocolVersion()).toBeNull();
  });

  it('follows tools/list cursor pagination until completion', async () => {
    const child = client('paginated-tools');
    await child.start();

    const tools = await child.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'page-one',
      'page-two',
      'page-three',
    ]);
  });

  it('fails closed when a child catalog exceeds the tool bound', async () => {
    const child = client('paginated-tools', { maxCatalogTools: 2 });
    await child.start();

    const diagnostic = await failure(() => child.listTools());
    expect(diagnostic).toMatchObject({
      phase: 'tools/list',
      kind: 'tools_list_limit_exceeded',
    });
    expect(child.isReady()).toBe(false);
  });

  it('fails closed when a child catalog exceeds the page bound', async () => {
    const child = client('paginated-tools', { maxCatalogPages: 2 });
    await child.start();

    const diagnostic = await failure(() => child.listTools());
    expect(diagnostic).toMatchObject({
      phase: 'tools/list',
      kind: 'tools_list_limit_exceeded',
    });
  });

  it('detects a repeated tools/list cursor', async () => {
    const child = client('pagination-cycle');
    await child.start();

    const diagnostic = await failure(() => child.listTools());
    expect(diagnostic).toMatchObject({
      phase: 'tools/list',
      kind: 'tools_list_pagination_cycle',
    });
  });

  it('ignores tools/list_changed when the child did not advertise the capability', async () => {
    let changes = 0;
    const child = client('unadvertised-list-change', {
      onToolsListChanged: () => {
        changes += 1;
      },
    });
    await child.start();
    await child.listTools();
    await sleep(40);

    expect(child.supportsToolsListChanged()).toBe(false);
    expect(changes).toBe(0);
  });

  it('invalidates and refreshes the registry cache for advertised list changes', async () => {
    const registry = new ChildMcpRegistry({
      serena: {
        enabled: true,
        command: process.execPath,
        args: [fixture, 'list-change'],
        facade: true,
      },
    });
    registries.push(registry);

    const first = await registry.catalog('serena');
    expect(first.map((tool) => tool.name)).toEqual(['echo-v1']);
    await sleep(40);
    const second = await registry.catalog('serena');
    expect(second.map((tool) => tool.name)).toEqual(['echo-v2']);
  });

  it('isolates a JSON-RPC error from unrelated concurrent calls', async () => {
    const child = client('concurrent-calls', { timeout: 500 });
    await child.start();

    const slow = child.callTool('slow', { text: 'slow-ok', delayMs: 40 });
    const failed = child.callTool('fail', { delayMs: 10 }).then(
      () => new Error('Expected the deliberate request to fail.'),
      (error: unknown) => error
    );
    const fast = child.callTool('fast', { text: 'fast-ok', delayMs: 0 });

    expect(resultText(await fast)).toBe('fast-ok');
    const requestError = await failed;
    expect(requestError).toBeInstanceOf(ChildMcpRequestError);
    expect(requestError).toMatchObject({
      code: -32001,
      data: { tool: 'fail' },
      diagnostic: { phase: 'runtime', kind: 'json_rpc_error' },
    });
    expect(resultText(await slow)).toBe('slow-ok');
    expect(child.isReady()).toBe(true);
    expect(child.diagnostic()).toBeNull();
  });

  it('sends cancellation for an aborted call and ignores its late response', async () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-child-cancel-'));
    tempRoots.push(root);
    const cancellationFile = join(root, 'cancelled.json');
    const child = client('cancel-call', { timeout: 500, auxiliaryFile: cancellationFile });
    await child.start();

    const controller = new AbortController();
    const pending = child.callTool(
      'slow',
      { text: 'late-abort' },
      { signal: controller.signal }
    ).then(
      () => new Error('Expected the aborted request to fail.'),
      (error: unknown) => error
    );
    controller.abort(new Error('caller cancelled'));

    const error = await pending;
    expect(error).toMatchObject({ name: 'AbortError', message: 'caller cancelled' });
    expect(await waitForFile(cancellationFile)).toBe(true);
    expect(JSON.parse(readFileSync(cancellationFile, 'utf8'))).toHaveLength(1);

    await sleep(150);
    expect(resultText(await child.callTool('fast', { text: 'after-abort' }))).toBe('after-abort');
    expect(child.isReady()).toBe(true);
    expect(child.diagnostic()).toBeNull();
  });

  it('times out one runtime call without draining concurrent work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-child-timeout-'));
    tempRoots.push(root);
    const cancellationFile = join(root, 'cancelled.json');
    const child = client('cancel-call', { timeout: 500, auxiliaryFile: cancellationFile });
    await child.start();

    const slow = child.callTool('slow', { text: 'late-timeout' }, { timeoutMs: 30 });
    const fast = child.callTool('fast', { text: 'parallel-ok' });
    const diagnostic = await failure(() => slow);

    expect(diagnostic).toMatchObject({
      phase: 'runtime',
      kind: 'request_timeout',
      timedOut: true,
    });
    expect(resultText(await fast)).toBe('parallel-ok');
    expect(await waitForFile(cancellationFile)).toBe(true);
    await sleep(150);
    expect(resultText(await child.callTool('fast', { text: 'after-timeout' }))).toBe('after-timeout');
    expect(child.isReady()).toBe(true);
    expect(child.diagnostic()).toBeNull();
  });

  it('answers child-initiated ping requests while remaining ready', async () => {
    const child = client('server-ping', { timeout: 500 });
    await child.start();

    const tools = await child.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['ping-ok']);
    expect(child.isReady()).toBe(true);
  });

  it('ignores an unknown malformed notification without corrupting the connection', async () => {
    const child = client('malformed-notification');
    await child.start();

    expect((await child.listTools()).map((tool) => tool.name)).toEqual(['echo']);
    expect(child.isReady()).toBe(true);
  });

  it('fails the connection on an invalid JSON-RPC response version', async () => {
    const child = client('invalid-jsonrpc-response');
    await child.start();

    const diagnostic = await failure(() => child.listTools());
    expect(diagnostic).toMatchObject({ phase: 'tools/list', kind: 'malformed_json_rpc' });
    expect(child.isReady()).toBe(false);
  });

  it('drains pending calls on crash and restarts the same client cleanly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-child-restart-'));
    tempRoots.push(root);
    const crashState = join(root, 'crashed-once');
    const child = client('crash-once', { timeout: 500, auxiliaryFile: crashState });
    await child.start();

    const first = child.callTool('echo', { text: 'first' }).then(
      () => new Error('Expected first pending request to fail.'),
      (error: unknown) => error
    );
    const second = child.callTool('echo', { text: 'second' }).then(
      () => new Error('Expected second pending request to fail.'),
      (error: unknown) => error
    );

    for (const error of await Promise.all([first, second])) {
      expect(error).toBeInstanceOf(ChildMcpError);
      expect(error).toMatchObject({
        diagnostic: { phase: 'runtime', kind: 'runtime_crash', exitCode: 7 },
      });
    }
    expect(existsSync(crashState)).toBe(true);
    expect(child.isReady()).toBe(false);

    await child.start();
    expect(resultText(await child.callTool('echo', { text: 'after-restart' }))).toBe('after-restart');
    expect(child.isReady()).toBe(true);
    expect(child.diagnostic()).toBeNull();
  });

  it('prevents a stale child exit from clobbering a rapid restart', async () => {
    const child = client('delayed-call', { timeout: 500 });
    await child.start();
    const oldPid = child.pid();
    const pending = child.callTool('slow', { text: 'old-child' }).then(
      () => new Error('Expected stopped request to fail.'),
      (error: unknown) => error
    );

    child.stop();
    await child.start();
    const stoppedError = await pending;
    expect(stoppedError).toMatchObject({ name: 'AbortError' });
    expect(child.pid()).not.toBe(oldPid);

    await sleep(50);
    expect((await child.listTools()).map((tool) => tool.name)).toEqual(['echo']);
    expect(child.isReady()).toBe(true);
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
    const child = client('tools-list-timeout', { timeout: 500 });
    await child.start();

    const diagnostic = await failure(() => child.listTools(80));
    expect(diagnostic).toMatchObject({ phase: 'tools/list', kind: 'tools_list_timeout', timedOut: true });
    expect(child.isReady()).toBe(true);
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
