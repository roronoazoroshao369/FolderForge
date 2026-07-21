import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { buildRegistry } from '../../src/tools/index.js';
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
      risk: 'LOW',
    });
  });
});
