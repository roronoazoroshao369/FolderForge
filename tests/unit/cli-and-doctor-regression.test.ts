import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Regression guards for six defects found during production-readiness review:
 *  1. An unrecognized flag was warned about and ignored, so a typo such as
 *     --apiKey silently dropped the credential and left the server open.
 *  2. A mistyped positional command was ignored and fell through to server startup.
 *  3. A value-taking root option at the end of argv was silently ignored.
 *  4. A value-taking root option could consume the following option token as its value.
 *  5. Invalid CLI security-policy modes were warned about and ignored, so
 *     the server started under a different policy than the operator requested.
 *  6. doctor treated every run file written by the current WorkflowManager
 *     (schemaVersion 2) as corrupt, failing a healthy workspace.
 */
const CLI = resolve(__dirname, '..', '..', 'dist', 'main.js');
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-cli-regression-'));
  roots.push(root);
  return root;
}

function runCli(args: string[], timeout = 60_000) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout,
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

  it('rejects an unknown positional command instead of starting the server', () => {
    const { code, output } = runCli(['doctro', '--no-dashboard'], 2_000);
    expect(code).toBe(1);
    expect(output).toMatch(/Unknown command: doctro/);
  });

  it('rejects a value-taking option when its value is missing', () => {
    const { code, output } = runCli(['--no-dashboard', '--project'], 2_000);
    expect(code).toBe(1);
    expect(output).toMatch(/Missing value for --project/);
  });

  it.each([
    ['--project', '--http'],
    ['--config', '--stdio'],
    ['--token', '--require-auth'],
    ['--port', '--http'],
  ])('rejects a following option token as a missing value for %s', (flag, nextFlag) => {
    const { code, output } = runCli(['--no-dashboard', flag, nextFlag], 2_000);
    expect(code).toBe(1);
    expect(output).toMatch(new RegExp(`Missing value for ${flag}`));
  });

  it.each(['--policy', '--policy-mode'])(
    'rejects invalid security-policy mode for %s rather than silently falling back',
    (flag) => {
      const { code, output } = runCli(['--no-dashboard', flag, 'unexpected-mode', '--stdio'], 2_000);
      expect(code).toBe(1);
      expect(output).toMatch(/Invalid (?:--policy|--policy-mode) value: unexpected-mode/);
    },
  );

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
