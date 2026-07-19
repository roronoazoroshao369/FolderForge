import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const parsedRuns = Number(process.env.FOLDERFORGE_STRESS_RUNS ?? 25);
if (!Number.isSafeInteger(parsedRuns) || parsedRuns < 1 || parsedRuns > 500) {
  throw new Error('FOLDERFORGE_STRESS_RUNS must be an integer from 1 to 500.');
}

const startedAt = Date.now();
for (let run = 1; run <= parsedRuns; run += 1) {
  const result = spawnSync(
    process.execPath,
    [
      vitest,
      'run',
      'tests/unit/child-mcp-client.test.ts',
      '--testNamePattern',
      'keeps a responsive idle child healthy|closes an idle child that stops answering heartbeat pings',
      '--reporter=dot',
    ],
    {
      cwd: root,
      env: { ...process.env, FOLDERFORGE_STRESS_ITERATION: String(run) },
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    }
  );

  if (result.status !== 0) {
    process.stderr.write(`Child MCP stress iteration ${run}/${parsedRuns} failed.\n`);
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    process.exit(result.status ?? 1);
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      suite: 'child-mcp-heartbeat',
      runs: parsedRuns,
      durationMs: Date.now() - startedAt,
      node: process.version,
      platform: process.platform,
    },
    null,
    2
  )
);
