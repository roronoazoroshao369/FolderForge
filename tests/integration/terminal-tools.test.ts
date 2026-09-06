import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { buildRegistry } from '../../src/tools/index.js';
import { spawnSync } from 'node:child_process';
import { quoteShellArg } from '../../src/core/shell.js';

describe('terminal tool diagnostics', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'folderforge-terminal-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('preserves a useful primary error and structured output on non-zero exit', async () => {
    const config = defaultConfig(root);
    config.policy.defaultMode = 'danger';
    config.rateLimit.enabled = false;
    const registry = buildRegistry(new Container(config));

    const script = join(root, 'exit-seven.cjs');
    writeFileSync(script, "console.error('diagnostic failure'); process.exit(7);\n");
    const command = [process.execPath, script]
      .map((value) => quoteShellArg(config.terminal.shell, value))
      .join(' ');
    const result = await registry.call('shell_exec', { command });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Command exited with code 7.');
    expect(result.data).toMatchObject({
      exitCode: 7,
      stdout: '',
      stderr: expect.stringContaining('diagnostic failure'),
      risk: 'HIGH',
    });
  });

  it('reaps an orphaned grandchild when shell_exec hits its natural timeout', async () => {
    if (process.platform === 'win32') return; // POSIX group-kill proof
    const config = defaultConfig(root);
    config.policy.defaultMode = 'danger';
    config.rateLimit.enabled = false;
    const registry = buildRegistry(new Container(config));

    // Unique argv0 marker: the backgrounded sleep is the orphaned grandchild
    // that used to survive execa's direct-child-only timeout kill.
    const marker = `ff35x${Math.random().toString(36).slice(2, 10)}`;
    const started = Date.now();
    const result = await registry.call('shell_exec', {
      command: `exec -a ${marker} sleep 300 & wait`,
      timeoutMs: 500,
    });
    const elapsedMs = Date.now() - started;
    expect(result.ok).toBe(false);
    expect(elapsedMs).toBeLessThan(10_000); // pre-fix the orphan held the pipes ~300s
    const orphans = spawnSync('pgrep', ['-f', marker], { stdio: 'pipe' });
    expect(orphans.status).not.toBe(0); // the grandchild died with the group
  }, 20_000);
});
