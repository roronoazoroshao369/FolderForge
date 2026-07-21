import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { runPm } from '../../src/tools/pkg-tools.js';
import { TS_FIXTURE } from '../integration/fixtures.js';

describe('package tool command diagnostics', () => {
  it('preserves evidence and a useful error when the package command exits non-zero', async () => {
    const config = loadConfig({ projectRoot: TS_FIXTURE });
    const container = new Container(config);

    const result = await runPm(
      { config, projectRoot: TS_FIXTURE, container },
      [
        process.execPath,
        '-e',
        "console.log('audit-json'); console.error('audit-warning'); process.exit(2)",
      ]
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('exited with code 2');
    expect(result.data).toMatchObject({
      exitCode: 2,
      stdout: 'audit-json',
      stderr: 'audit-warning',
    });
  });
});
