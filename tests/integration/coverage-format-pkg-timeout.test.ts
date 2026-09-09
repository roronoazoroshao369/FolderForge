/**
 * Integration regression for proposal 017: a blown natural-timeout budget in
 * the coverage/format/pkg tool paths must reap the WHOLE spawned process tree
 * (the #35 pattern), not just the direct wrapper child. All three sites spawn
 * wrapper binaries (npx/npm → sh -c → the real workload), so the workload is
 * a grandchild: without the group kill it survives orphaned. Each site proves
 * the full lifecycle with a uniquely-marked grandchild (pgrep -f marker):
 * created alive pre-kill → reaped after the blown budget. POSIX-only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCoverageCommand } from '../../src/tools/coverage-tools.js';
import { runFmt } from '../../src/tools/format-tools.js';
import { runPm } from '../../src/tools/pkg-tools.js';
import type { ToolContext } from '../../src/core/types.js';

const POSIX = process.platform !== 'win32';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const roots: string[] = [];
function trackedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ff46-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function stubCtx(projectRoot: string, budgetMs: number): ToolContext {
  return {
    projectRoot,
    config: { terminal: { defaultTimeoutMs: budgetMs, maxOutputBytes: 64 * 1024 } },
    container: { policy: { secret: { redact: (s: string) => s } } },
  } as unknown as ToolContext;
}

function markerAlive(marker: string): boolean {
  try {
    execFileSync('pgrep', ['-f', marker], { stdio: 'pipe' });
    return true;
  } catch {
    return false; // pgrep exit 1: no match — the orphan is reaped.
  }
}

/** The grandchild must OBSERVABLY exist before the budget fires, otherwise a
 * vacuous pass proves nothing. Poll until pgrep sees the marker (or fail). */
async function expectAliveSoon(marker: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (markerAlive(marker)) return;
    await sleep(100);
  }
  throw new Error(`marked grandchild never appeared: ${marker}`);
}

async function expectReaped(marker: string): Promise<void> {
  for (let i = 0; i < 25; i++) {
    if (!markerAlive(marker)) return;
    await sleep(200);
  }
  throw new Error(`marked grandchild survived the blown budget: ${marker}`);
}

/** The orphaning fixture: spawns a marked grandchild in the SAME process
 * group (not detached — the bug class this regression kills), then hangs. */
const ORPHAN_JS = `const { spawn } = require('node:child_process');
const marker = process.argv[2] ?? process.env.FF46_MARKER;
spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`;

function writeOrphanFixture(root: string): string {
  const fixture = join(root, 'orphan.cjs');
  writeFileSync(fixture, ORPHAN_JS);
  return fixture;
}

describe.skipIf(!POSIX)('coverage/format/pkg natural-timeout tree-kill (proposal 017)', () => {
  it(
    'runCoverageCommand reaps a marked grandchild when the budget blows',
    { timeout: 30_000 },
    async () => {
      const root = trackedRoot();
      const marker = `ff46cov${process.pid}`;
      const pending = runCoverageCommand(stubCtx(root, 800), [
        process.execPath,
        writeOrphanFixture(root),
        marker,
      ]);
      await expectAliveSoon(marker); // grandchild provably alive pre-kill
      const res = await pending;
      // Outward contract frozen: a blown budget surfaces as exitCode null.
      expect(res.exitCode).toBeNull();
      await expectReaped(marker);
    },
  );

  it(
    'runFmt reaps a marked grandchild when the budget blows',
    { timeout: 30_000 },
    async () => {
      const root = trackedRoot();
      const marker = `ff46fmt${process.pid}`;
      const pending = runFmt(stubCtx(root, 800), [
        process.execPath,
        writeOrphanFixture(root),
        marker,
      ]);
      await expectAliveSoon(marker);
      const res = await pending;
      expect(res.ok).toBe(false);
      const data = res.data as { exitCode?: number | null };
      expect(data.exitCode).toBeNull();
      await expectReaped(marker);
    },
  );

  it(
    'runPm reaps a marked grandchild through the real npm → sh → node wrapper chain',
    { timeout: 30_000 },
    async () => {
      const root = trackedRoot();
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'ff46-fixture', scripts: { hang: 'node hang.cjs' } }),
      );
      writeFileSync(join(root, 'hang.cjs'), ORPHAN_JS);
      const marker = `ff46pkg${process.pid}`;
      process.env.FF46_MARKER = marker;
      try {
        // npm's own boot is slower than the node fixture — a wider budget
        // keeps the grandchild's creation strictly before the kill.
        const pending = runPm(stubCtx(root, 3_000), ['npm', 'run', 'hang']);
        await expectAliveSoon(marker);
        const res = await pending;
        expect(res.ok).toBe(false);
        const data = res.data as { exitCode?: number | null } | undefined;
        expect(data?.exitCode ?? null).toBeNull();
        await expectReaped(marker);
      } finally {
        delete process.env.FF46_MARKER;
      }
    },
  );
});
