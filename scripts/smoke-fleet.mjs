/**
 * Live fleet smoke test (ADR-0012 Phase 1): provisions three folders in
 * parallel against the locally built runtime (dist/main.js), starts all three
 * instances, and verifies over real HTTP MCP traffic that:
 *
 *  - each instance enforces its bearer token (401 unauthenticated),
 *  - initialize reports the per-instance server name,
 *  - file_read works inside the instance's own folder, and
 *  - file_read into a sibling instance's folder is denied (tool isolation).
 *
 * Usage: npm run build && node scripts/smoke-fleet.mjs
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetManager } from '../dist/provisioner/fleet-manager.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mainJs = join(repoRoot, 'dist', 'main.js');
const root = mkdtempSync(join(tmpdir(), 'ff-fleet-smoke-'));

const children = [];
const tails = new Map();

function note(pid, chunk) {
  const prev = tails.get(pid) ?? '';
  tails.set(pid, (prev + chunk).slice(-4000));
}

function realSpawn(command, cwd) {
  const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => note(child.pid, chunk));
  child.stderr.on('data', (chunk) => note(child.pid, chunk));
  children.push(child);
  return { sessionId: `smoke_${children.length}`, pid: child.pid };
}

function parseRpc(text, contentType) {
  if (contentType.includes('text/event-stream')) {
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    if (!data.length) throw new Error(`Empty MCP event stream: ${text.slice(0, 400)}`);
    return JSON.parse(data.at(-1));
  }
  return JSON.parse(text);
}

async function postRpc({ port, token, sessionId, id, method, params }) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      connection: 'close',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      ...(id !== undefined ? { id } : {}),
      method,
      ...(params ? { params } : {}),
    }),
  });
  const text = await response.text();
  return {
    status: response.status,
    sessionId: response.headers.get('mcp-session-id'),
    text,
    message: text ? parseRpc(text, response.headers.get('content-type') ?? '') : undefined,
  };
}

async function waitForReady(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const probe = await postRpc({ port, id: 0, method: 'initialize', params: {} });
      if (probe.status === 401) return; // up and enforcing auth
      if (probe.status === 200) return; // up (should not happen: requireAuth is on)
    } catch {
      // connection refused while the child is still booting
    }
    if (Date.now() > deadline) throw new Error(`Instance on port ${port} did not become ready`);
    await new Promise((resolve_) => setTimeout(resolve_, 250));
  }
}

async function initialize(port, token) {
  const initialized = await postRpc({
    port,
    token,
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fleet-smoke', version: '1.0.0' },
    },
  });
  if (initialized.status !== 200 || !initialized.sessionId) {
    throw new Error(`initialize failed on port ${port}: ${initialized.status} ${initialized.text.slice(0, 300)}`);
  }
  await postRpc({ port, token, sessionId: initialized.sessionId, method: 'notifications/initialized' });
  return initialized;
}

async function callTool(port, token, sessionId, name, args) {
  const result = await postRpc({
    port,
    token,
    sessionId,
    id: 2,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  return result.message;
}

function toolPayload(message) {
  const item = message?.result?.content?.[0]?.text;
  return typeof item === 'string' ? item : JSON.stringify(message ?? {});
}

function assert(condition, label) {
  if (!condition) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`  ok - ${label}`);
}

const fleet = new FleetManager(root, { mainJs, spawn: realSpawn });

async function main() {
  const folders = ['alpha', 'beta', 'gamma'].map((name) => {
    const folder = join(root, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'marker.txt'), `i-am-${name}`);
    return { name, folder };
  });

  console.log('create: provisioning 3 folders');
  const provisioned = folders.map(({ name, folder }) => {
    const { instance, token } = fleet.create({ projectPath: folder, actor: 'smoke-fleet' });
    return { name, folder, instance, token };
  });
  const ports = provisioned.map((entry) => entry.instance.port);
  assert(new Set(ports).size === 3, `distinct ports (${ports.join(', ')})`);
  assert(provisioned.every((entry) => entry.instance.state === 'stopped'), 'all instances start stopped');

  console.log('start: launching all 3 instances in parallel');
  provisioned.forEach((entry) => fleet.start(entry.instance.id));
  assert(fleet.list().every((entry) => entry.state === 'running'), 'all instances running');
  await Promise.all(provisioned.map((entry) => waitForReady(entry.instance.port)));
  console.log('  ok - all 3 MCP HTTP endpoints ready');

  for (const entry of provisioned) {
    console.log(`verify: ${entry.name} on port ${entry.instance.port}`);
    const unauthenticated = await postRpc({
      port: entry.instance.port,
      id: 9,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } },
    });
    assert(unauthenticated.status === 401, 'unauthenticated request rejected with 401');

    const session = await initialize(entry.instance.port, entry.token);
    const serverName = session.message?.result?.serverInfo?.name ?? '';
    assert(serverName === `folderforge-fleet-${entry.instance.id}`, `server name ${serverName}`);

    const ownRead = await callTool(entry.instance.port, entry.token, session.sessionId, 'file_read', {
      path: 'marker.txt',
    });
    assert(toolPayload(ownRead).includes(`i-am-${entry.name}`), 'reads its own folder');

    const sibling = entry.name === 'alpha' ? 'beta' : 'alpha';
    const crossRead = await callTool(entry.instance.port, entry.token, session.sessionId, 'file_read', {
      path: `../${sibling}/marker.txt`,
    });
    const crossPayload = toolPayload(crossRead);
    assert(/outside allowed|denied by policy|not a project folder/i.test(crossPayload), 'cross-folder read denied');
  }

  console.log('stop/destroy: converging the fleet back to zero');
  for (const entry of provisioned) fleet.stop(entry.instance.id);
  assert(fleet.list().every((entry) => entry.state === 'stopped'), 'all instances stopped');
  for (const entry of provisioned) fleet.destroy(entry.instance.id);
  assert(fleet.list().length === 0, 'fleet empty after destroy');

  console.log('FLEET SMOKE PASS: 3 folders provisioned in parallel, tokens enforced, tool isolation verified');
}

main()
  .catch((error) => {
    console.error(`FLEET SMOKE FAIL: ${error instanceof Error ? error.message : String(error)}`);
    for (const [pid, tail] of tails) console.error(`--- child pid ${pid} tail ---\n${tail}`);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const child of children) {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
