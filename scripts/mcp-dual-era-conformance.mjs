#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputOption = process.argv.indexOf('--output');
if (outputOption < 0 || !process.argv[outputOption + 1] || process.argv.length !== 4) {
  process.stderr.write('Usage: node scripts/mcp-dual-era-conformance.mjs --output <file>\n');
  process.exit(2);
}
const output = resolve(process.cwd(), process.argv[outputOption + 1]);
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const versions = {
  legacySdk: lock.packages['node_modules/@modelcontextprotocol/sdk'].version,
  modernServerSdk: lock.packages['node_modules/@modelcontextprotocol/server'].version,
  modernClientSdk: lock.packages['node_modules/@modelcontextprotocol/client'].version,
};
const cases = [
  { id: 'real-stdio-dual-client', test: 'tests/integration/mcp-dual-era-client.test.ts', transport: 'stdio', client: '@modelcontextprotocol/client + @modelcontextprotocol/sdk', clientVersion: `${versions.modernClientSdk} / ${versions.legacySdk}`, protocolVersion: '2026-07-28 + 2025-11-25', feature: 'real client discovery, tools/list, governed file_read' },
  { id: 'real-http-modern-client', test: 'tests/integration/mcp-modern-http.test.ts', transport: 'http', client: '@modelcontextprotocol/client', clientVersion: versions.modernClientSdk, protocolVersion: '2026-07-28', feature: 'header parity, real client tool list and read-only call, mutation fail-closed, legacy header fallback' },
  { id: 'modern-principal-boundary', test: 'tests/integration/mcp-modern-core.test.ts', transport: 'http', client: 'SDK v2 server fixture', clientVersion: versions.modernServerSdk, protocolVersion: '2026-07-28', feature: 'OAuth scope, resource catalog access, missing modern optional extensions' },
  { id: 'legacy-http-session', test: 'tests/integration/http-session-lifecycle.test.ts', transport: 'http', client: '@modelcontextprotocol/sdk', clientVersion: versions.legacySdk, protocolVersion: '2025-11-25 / supported negotiated revisions', feature: 'legacy session ownership, TTL, original transport' },
  { id: 'oauth-http-gate', test: 'tests/integration/oauth-http.test.ts', transport: 'http', client: 'HTTP fixture', clientVersion: 'test fixture', protocolVersion: 'legacy', feature: 'OAuth issuer, scope and gateway boundary regression' },
  { id: 'modern-header-negative', test: 'tests/unit/mcp-modern-http-headers.test.ts', transport: 'http', client: 'raw fixture', clientVersion: 'test fixture', protocolVersion: '2026-07-28', feature: 'malformed, duplicated, encoded and spoofed mirrored headers' },
];
const checks = cases.map((entry) => {
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', entry.test, '--reporter=default'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 90000,
    maxBuffer: 3 * 1024 * 1024,
  });
  const logs = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const status = result.error?.code === 'ETIMEDOUT'
    ? 'UNAVAILABLE'
    : result.status === 0 ? 'PASS' : 'FAIL';
  return {
    ...entry,
    status,
    evidence: {
      command: `node node_modules/vitest/vitest.mjs run ${entry.test} --reporter=default`,
      exitCode: result.status,
      durationSignal: result.signal ?? null,
      logSha256: createHash('sha256').update(logs).digest('hex'),
      // Only the test runner's compact counts, never raw credentials/tool payloads.
      summary: logs.split('\n').filter(line => line.includes('Test Files') || line.includes('Tests ') || line.includes('Duration ')).slice(-3).map(line => line.trim()),
    },
  };
});
const deferred = [
  ['modern-mutating-tool-parity', 'NOT_RUN', 'Design deliberately blocks modern mutations pending separately approved durable idempotency'],
  ['modern-task-extension', 'NOT_RUN', 'io.modelcontextprotocol/tasks not advertised'],
  ['modern-MRTR-input-required', 'NOT_RUN', 'modern MRTR continuation not advertised'],
  ['modern-subscriptions', 'NOT_RUN', 'subscriptions/listen not advertised'],
  ['modern-outbound-child-client', 'NOT_RUN', 'child adapter remains legacy-only'],
  ['other-platform-client-validation', 'NOT_RUN', `Only local ${process.platform}/Node ${process.version} executed by this script`],
].map(([id, status, reason]) => ({ id, status, reason }));
const report = {
  format: 'folderforge.g59.conformance.v1',
  generatedAt: new Date().toISOString(),
  source: {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    os: process.platform,
    architecture: process.arch,
    node: process.version,
    ...versions,
  },
  checks,
  deferred,
  summary: {
    passed: checks.filter(x => x.status === 'PASS').length,
    failed: checks.filter(x => x.status === 'FAIL').length,
    unavailable: checks.filter(x => x.status === 'UNAVAILABLE').length,
    notRun: deferred.length,
  },
  releaseVerdict: 'NOT_CERTIFIED — design/implementation branch, no exact-head multi-OS CI or production soak evidence',
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
process.stdout.write(JSON.stringify({ output, summary: report.summary, versions }) + '\n');
if (report.summary.failed || report.summary.unavailable) process.exitCode = 1;
