import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultShell, quoteShellArg } from '../dist/core/shell.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const project = mkdtempSync(join(tmpdir(), 'folderforge-http-smoke-'));
const authValue = randomBytes(32).toString('base64url');
let child;
let logs = '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a TCP port.');
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

function parseRpcResponse(text, contentType) {
  if (contentType.includes('text/event-stream')) {
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    if (data.length === 0) throw new Error(`Empty MCP event stream: ${text}`);
    return JSON.parse(data.at(-1));
  }
  return JSON.parse(text);
}

async function rpc(url, method, params, id) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'x-api-key': authValue,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${method}: ${text}`);
  const message = parseRpcResponse(text, response.headers.get('content-type') ?? '');
  if (message.error) throw new Error(`${method} returned JSON-RPC error: ${JSON.stringify(message.error)}`);
  return message.result;
}

async function waitForHealth(url) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child?.exitCode !== null) {
      throw new Error(`FolderForge exited before becoming healthy.\n${logs}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`healthz returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`FolderForge did not become healthy: ${String(lastError)}\n${logs}`);
}

async function stopChild() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    sleep(3000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) child.kill('SIGKILL');
}

try {
  const port = await freePort();
  const configPath = join(project, 'folderforge-smoke.yaml');
  writeFileSync(join(project, 'README.md'), 'folderforge release smoke\n');
  const failureScript = join(project, 'folderforge-fail-shell.cjs');
  writeFileSync(failureScript, "console.log('wire-out'); console.error('wire-error'); process.exit(7);\n");
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ name: 'folderforge-http-smoke', version: '0.0.0', private: true }, null, 2)
  );
  writeFileSync(
    join(project, 'package-lock.json'),
    JSON.stringify(
      {
        name: 'folderforge-http-smoke',
        version: '0.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'folderforge-http-smoke', version: '0.0.0' },
        },
      },
      null,
      2
    )
  );
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        workspace: { defaultProject: project, allowedDirectories: [project] },
        policy: { defaultMode: 'danger' },
        tools: { preset: 'vibe-lite', enabled: ['pkg_audit', 'shell_exec'] },
        adapters: {
          serena: { enabled: false },
          playwright: { enabled: true },
          desktopCommander: { enabled: false },
        },
        server: {
          transport: 'http',
          http: { host: '127.0.0.1', port, requireAuth: true },
          dashboard: { enabled: false },
        },
      },
      null,
      2
    )
  );

  child = spawn(
    process.execPath,
    [
      join(root, 'dist', 'main.js'),
      '--config',
      configPath,
      '--project',
      project,
      '--http',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--no-dashboard',
      '--tools-preset',
      'vibe-lite',
      '--require-auth',
      '--api-key',
      authValue,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        FOLDERFORGE_APPROVALS_PATH: join(project, '.folderforge', 'approvals-smoke.jsonl'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const collect = (chunk) => {
    logs = `${logs}${chunk.toString()}`.slice(-65536);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(`${base}/healthz`);

  const unauthorized = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }),
  });
  if (unauthorized.status !== 401) {
    throw new Error(`Expected unauthenticated MCP request to return 401, got ${unauthorized.status}.`);
  }

  const initialized = await rpc(
    `${base}/mcp`,
    'initialize',
    {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'folderforge-release-smoke', version: '1.0.0' },
    },
    1
  );
  if (initialized?.serverInfo?.version !== packageJson.version) {
    throw new Error(
      `MCP version mismatch: expected ${packageJson.version}, got ${initialized?.serverInfo?.version}.`
    );
  }

  const listed = await rpc(`${base}/mcp`, 'tools/list', undefined, 2);
  if (!Array.isArray(listed?.tools) || listed.tools.length !== 50) {
    throw new Error(`Expected vibe-lite to advertise 50 tools, got ${listed?.tools?.length}.`);
  }

  if (!listed.tools.some((tool) => tool.name === 'pkg_audit')) {
    throw new Error('Explicitly enabled pkg_audit was not retained by vibe-lite.');
  }

  const auditCall = await rpc(
    `${base}/mcp`,
    'tools/call',
    { name: 'pkg_audit', arguments: {} },
    3
  );
  if (auditCall?.isError === true || !JSON.stringify(auditCall).includes('exitCode')) {
    throw new Error(`pkg_audit smoke call failed: ${JSON.stringify(auditCall)}`);
  }

  const called = await rpc(
    `${base}/mcp`,
    'tools/call',
    { name: 'file_read', arguments: { path: 'README.md' } },
    4
  );
  if (called?.isError === true || !JSON.stringify(called).includes('folderforge release smoke')) {
    throw new Error(`file_read smoke call failed: ${JSON.stringify(called)}`);
  }

  const failedShell = await rpc(
    `${base}/mcp`,
    'tools/call',
    {
      name: 'shell_exec',
      arguments: {
        command: [process.execPath, failureScript]
          .map((value) => quoteShellArg(defaultShell(), value))
          .join(' '),
      },
    },
    5
  );
  if (
    failedShell?.isError !== true ||
    failedShell?.structuredContent?.exitCode !== 7 ||
    !String(failedShell?.structuredContent?.stdout ?? '').includes('wire-out') ||
    !String(failedShell?.structuredContent?.stderr ?? '').includes('wire-error')
  ) {
    throw new Error(
      `shell_exec structured failure smoke did not preserve wire evidence: ${JSON.stringify(failedShell)}`
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        version: initialized.serverInfo.version,
        advertisedTools: listed.tools.length,
        auth: '401-without-key / success-with-key',
        toolCalls: ['pkg_audit', 'file_read', 'shell_exec:error-evidence'],
      },
      null,
      2
    )
  );
} finally {
  await stopChild();
  rmSync(project, { recursive: true, force: true });
}
