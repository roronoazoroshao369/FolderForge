import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Regression guards for three defects found during production-readiness review:
 *  1. An unrecognized flag was warned about and ignored, so a typo such as
 *     --apiKey silently dropped the credential and left the server open.
 *  2. doctor treated every run file written by the current WorkflowManager
 *     (schemaVersion 2) as corrupt, failing a healthy workspace.
 */
const CLI = resolve(__dirname, '..', '..', 'dist', 'main.js');
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-cli-regression-'));
  roots.push(root);
  return root;
}

function runCli(args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!existsSync(CLI))('CLI argument validation', () => {
  it('rejects an unknown flag instead of silently ignoring it', () => {
    const { code, output } = runCli(['--apiKey', 'should-not-be-accepted']);
    expect(code).toBe(1);
    expect(output).toMatch(/Unknown argument: --apiKey/);
  });

  it('still accepts supported flags', () => {
    const { code, output } = runCli(['--version']);
    expect(code).toBe(0);
    expect(output).toMatch(/folderforge \d+\.\d+\.\d+/);
  });
});

describe.skipIf(!existsSync(CLI))('doctor workflow state check', () => {
  it('accepts run files written at the current schema version', () => {
    const root = tempRoot();
    const runsDir = join(root, '.folderforge', 'workflows', 'runs');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, 'wf_abc123def456.json'),
      JSON.stringify({
        schemaVersion: 2,
        id: 'wf_abc123def456',
        state: 'completed',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        steps: [],
      }),
    );
    const { output } = runCli(['doctor', '-p', root]);
    expect(output).not.toMatch(/corrupt run files/);
    expect(output).toMatch(/state\.workflows/);
  });
});
