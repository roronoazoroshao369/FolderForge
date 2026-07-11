import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeBrowserSetupCli, type BrowserSetupReport } from '../../src/setup/browser.js';

const projectDir = join(tmpdir(), 'folderforge-browser-setup-project');
const cliPath = join(projectDir, 'node_modules', 'playwright', 'cli.js');

function parseReport(output: string): BrowserSetupReport {
  return JSON.parse(output) as BrowserSetupReport;
}

describe('folderforge setup browser', () => {
  it('resolves the packaged Playwright CLI without executing or downloading in dry-run mode', () => {
    const run = vi.fn();
    const result = executeBrowserSetupCli(['browser', '--dry-run', '--json'], {
      resolvePlaywrightCli: () => cliPath,
      run,
      cwd: projectDir,
      env: { PATH: '/usr/bin' },
    });
    const report = parseReport(result.output);

    expect(result.exitCode).toBe(0);
    expect(report).toMatchObject({
      schemaVersion: 1,
      ok: true,
      browser: 'chromium',
      dryRun: true,
      withDeps: false,
      exitCode: 0,
      command: process.execPath,
      args: [cliPath, 'install', 'chromium'],
    });
    expect(run).not.toHaveBeenCalled();
    expect(result.output).not.toContain('npx');
  });

  it('adds operating-system dependency installation only when explicitly requested', () => {
    const result = executeBrowserSetupCli(['browser', '--with-deps', '--dry-run', '--json'], {
      resolvePlaywrightCli: () => cliPath,
    });

    expect(parseReport(result.output).args).toEqual([
      cliPath,
      'install',
      '--with-deps',
      'chromium',
    ]);
  });

  it('executes the package-local CLI and preserves successful evidence', () => {
    const run = vi.fn(() => ({ status: 0, stdout: 'Chromium installed\n', stderr: '' }));
    const env = { PATH: '/custom/bin', HTTPS_PROXY: 'http://proxy.invalid' };
    const result = executeBrowserSetupCli(['browser', '--json'], {
      resolvePlaywrightCli: () => cliPath,
      run,
      cwd: projectDir,
      env,
    });
    const report = parseReport(result.output);

    expect(result.exitCode).toBe(0);
    expect(report.stdout).toBe('Chromium installed\n');
    expect(run).toHaveBeenCalledWith(
      process.execPath,
      [cliPath, 'install', 'chromium'],
      { cwd: projectDir, env }
    );
  });

  it('returns exit 1 with stdout and stderr when Playwright fails', () => {
    const result = executeBrowserSetupCli(['browser', '--json'], {
      resolvePlaywrightCli: () => cliPath,
      run: () => ({ status: 1, stdout: 'partial output', stderr: 'network unavailable' }),
    });
    const report = parseReport(result.output);

    expect(result.exitCode).toBe(1);
    expect(report).toMatchObject({
      ok: false,
      exitCode: 1,
      stdout: 'partial output',
      stderr: 'network unavailable',
      error: 'Playwright exited with code 1.',
    });
  });

  it('returns exit 1 when the packaged Playwright CLI cannot be resolved', () => {
    const result = executeBrowserSetupCli(['browser', '--dry-run', '--json'], {
      resolvePlaywrightCli: () => {
        throw new Error('module missing');
      },
    });
    const report = parseReport(result.output);

    expect(result.exitCode).toBe(1);
    expect(report.error).toContain('Could not resolve the packaged Playwright CLI');
    expect(report.error).toContain('module missing');
  });

  it('returns exit 2 for invalid arguments without invoking Playwright', () => {
    const run = vi.fn();
    const result = executeBrowserSetupCli(['browser', '--unknown', '--json'], {
      resolvePlaywrightCli: () => cliPath,
      run,
    });

    expect(result.exitCode).toBe(2);
    expect(parseReport(result.output).error).toBe('Unknown argument: --unknown');
    expect(run).not.toHaveBeenCalled();
  });

  it('documents that browser installation is explicit and network-capable', () => {
    const result = executeBrowserSetupCli(['browser', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('explicitly opt-in');
    expect(result.output).toContain('Normal FolderForge installation does not download browsers');
    expect(result.output).toContain('--with-deps');
    expect(result.output).toContain('--dry-run');
  });
});
