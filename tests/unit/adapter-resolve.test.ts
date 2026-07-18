import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  LEGACY_GENERATED_PLAYWRIGHT_SPEC,
  PACKAGE_LOCAL_PLAYWRIGHT_COMMAND,
  resolveAdapterLaunch,
  resolvePlaywrightMcpRuntime,
} from '../../src/adapters/child-mcp/resolve.js';

describe('child adapter launch resolution', () => {
  it('resolves the generated Playwright adapter from package-local dependencies', () => {
    const launch = resolveAdapterLaunch('playwright', {
      enabled: true,
      command: PACKAGE_LOCAL_PLAYWRIGHT_COMMAND,
      args: ['--isolated'],
    });

    expect(launch.source).toBe('package-local');
    expect(launch.command).toBe(process.execPath);
    expect(launch.args.at(-1)).toBe('--isolated');
    expect(launch.args[0]).toContain('@playwright/mcp');
    expect(existsSync(launch.args[0]!)).toBe(true);
    expect(launch.packageName).toBe('@playwright/mcp');
  });

  it('migrates only the exact historical generated npx definition', () => {
    const launch = resolveAdapterLaunch('playwright', {
      enabled: true,
      command: 'npx',
      args: ['-y', LEGACY_GENERATED_PLAYWRIGHT_SPEC, '--isolated'],
    });

    expect(launch.source).toBe('package-local');
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).not.toContain('-y');
    expect(launch.args).not.toContain(LEGACY_GENERATED_PLAYWRIGHT_SPEC);
  });

  it('preserves a custom Playwright package version and command', () => {
    const args = ['-y', '@playwright/mcp@0.0.99', '--isolated'];
    const launch = resolveAdapterLaunch('playwright', {
      enabled: true,
      command: 'npx',
      args,
    });

    expect(launch).toMatchObject({ command: 'npx', args, source: 'custom' });
  });

  it('preserves arbitrary custom adapter commands unchanged', () => {
    const launch = resolveAdapterLaunch('playwright', {
      enabled: true,
      command: '/opt/custom/playwright-adapter',
      args: ['--profile', 'test profile'],
      cwd: '/tmp/custom cwd',
    });

    expect(launch).toMatchObject({
      command: '/opt/custom/playwright-adapter',
      args: ['--profile', 'test profile'],
      cwd: '/tmp/custom cwd',
      source: 'custom',
    });
  });

  it('uses the Playwright runtime declared by @playwright/mcp regardless of npm hoisting', () => {
    const runtime = resolvePlaywrightMcpRuntime();
    const mcpPackage = JSON.parse(readFileSync(runtime.mcpPackageJsonPath, 'utf8')) as {
      dependencies?: { playwright?: string };
    };

    expect(runtime.mcpVersion).toBeTruthy();
    expect(runtime.playwrightVersion).toBe(mcpPackage.dependencies?.playwright);
    expect(runtime.playwrightPackageJsonPath).toContain(`${String.raw`node_modules/playwright`}`);
    expect(runtime.playwrightCliPath).toContain(`${String.raw`node_modules/playwright`}`);
    expect(existsSync(runtime.playwrightCliPath)).toBe(true);
    expect(runtime.chromiumExecutablePath).toBeTruthy();
  });
});
