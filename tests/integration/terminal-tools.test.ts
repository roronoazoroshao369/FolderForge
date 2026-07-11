import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../../src/core/config.js';
import { Container } from '../../src/core/container.js';
import { buildRegistry } from '../../src/tools/index.js';

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

    const result = await registry.call('shell_exec', {
      command: `node -e "console.error('diagnostic failure'); process.exit(7)"`,
    });

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
