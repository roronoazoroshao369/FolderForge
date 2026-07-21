import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { StdioChildClient } from '../dist/adapters/child-mcp/client.js';

const fixture = resolve('tests/fixtures/diagnostic-mcp-server.mjs');
const tempRoot = mkdtempSync(join(tmpdir(), 'folderforge-child-compat-'));
const results = [];

function client(mode, extraArgs = [], options = {}) {
  return new StdioChildClient({
    adapter: `compat-${mode}`,
    command: process.execPath,
    args: [fixture, mode, ...extraArgs],
    requestTimeoutMs: options.requestTimeoutMs ?? 500,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 0,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 200,
    maxCatalogPages: options.maxCatalogPages ?? 20,
    maxCatalogTools: options.maxCatalogTools ?? 1000,
    maxJsonRpcMessageBytes: options.maxJsonRpcMessageBytes ?? 1024 * 1024,
    maxStdoutBufferBytes: options.maxStdoutBufferBytes ?? 1024 * 1024,
    maxPendingRequests: options.maxPendingRequests ?? 32,
  });
}

async function runProfile(name, execute) {
  const startedAt = performance.now();
  try {
    const evidence = await execute();
    results.push({
      name,
      status: 'pass',
      elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
      evidence,
    });
  } catch (error) {
    results.push({
      name,
      status: 'fail',
      elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

try {
  await runProfile('baseline-initialize-list-call', async () => {
    const child = client('success');
    try {
      await child.start();
      const tools = await child.listTools();
      const result = await child.callTool('echo', { text: 'compatibility' });
      return {
        protocolVersion: child.protocolVersion(),
        tools: tools.map((tool) => tool.name),
        result,
      };
    } finally {
      await child.stopAndWait(500);
    }
  });

  await runProfile('paginated-catalog', async () => {
    const child = client('paginated-tools');
    try {
      await child.start();
      const tools = await child.listTools();
      if (tools.length !== 3) throw new Error(`Expected 3 tools, received ${tools.length}`);
      return { tools: tools.map((tool) => tool.name) };
    } finally {
      await child.stopAndWait(500);
    }
  });

  await runProfile('child-initiated-ping', async () => {
    const child = client('server-ping');
    try {
      await child.start();
      const tools = await child.listTools();
      if (tools[0]?.name !== 'ping-ok') throw new Error('Child ping was not answered.');
      return { tools: tools.map((tool) => tool.name) };
    } finally {
      await child.stopAndWait(500);
    }
  });

  await runProfile('malformed-frame-fail-closed', async () => {
    const child = client('malformed');
    try {
      let failed = false;
      try {
        await child.start();
        await child.listTools();
      } catch (error) {
        failed = true;
        return {
          rejected: true,
          diagnostic: error?.diagnostic ?? null,
        };
      }
      if (!failed) throw new Error('Malformed child output was accepted.');
    } finally {
      await child.stopAndWait(500);
    }
  });

  await runProfile('crash-no-automatic-replay', async () => {
    const marker = join(tempRoot, 'crashed-once');
    const child = client('crash-once', [marker]);
    try {
      await child.start();
      await child.listTools();
      let failed = false;
      try {
        await child.callTool('echo', { text: 'must-not-replay' });
      } catch (error) {
        failed = true;
        return {
          rejected: true,
          diagnostic: error?.diagnostic ?? null,
          readyAfterCrash: child.isReady(),
        };
      }
      if (!failed) throw new Error('Crash-once mutation unexpectedly succeeded.');
    } finally {
      await child.stopAndWait(500);
    }
  });

  const failed = results.filter((result) => result.status !== 'pass');
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    implementation: 'FolderForge StdioChildClient',
    profiles: results,
    summary: {
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
    },
    limitations: [
      'These are deterministic protocol profiles, not claims about five third-party products.',
      'External server compatibility requires pinned versions and separate evidence runs.',
    ],
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex !== -1) {
    const output = process.argv[outputIndex + 1];
    if (!output) throw new Error('--output requires a path');
    const absolute = resolve(output);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, serialized, { encoding: 'utf8', mode: 0o600 });
  }
  process.stdout.write(serialized);
  if (failed.length > 0) process.exitCode = 1;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
