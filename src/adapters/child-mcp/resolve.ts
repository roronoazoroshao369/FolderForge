import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { AdapterDef } from '../../core/types.js';

export const PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp';
export const PACKAGE_LOCAL_PLAYWRIGHT_COMMAND = 'package:@playwright/mcp';
export const LEGACY_GENERATED_PLAYWRIGHT_SPEC = '@playwright/mcp@0.0.41';

export interface ResolvedAdapterLaunch {
  command: string;
  args: string[];
  cwd?: string;
  source: 'custom' | 'package-local';
  packageName?: string;
  packageVersion?: string;
  packageJsonPath?: string;
  cliPath?: string;
}

export interface PackageCliResolution {
  packageName: string;
  packageVersion: string;
  packageJsonPath: string;
  cliPath: string;
  binName: string;
}

const requireFromAdapter = createRequire(import.meta.url);

function readPackageJson(path: string): {
  name?: string;
  version?: string;
  bin?: string | Record<string, string>;
} {
  return JSON.parse(readFileSync(path, 'utf8')) as {
    name?: string;
    version?: string;
    bin?: string | Record<string, string>;
  };
}

export function resolvePackageCli(
  packageName: string,
  preferredBin?: string,
  resolver: NodeJS.Require = requireFromAdapter
): PackageCliResolution {
  const packageJsonPath = resolver.resolve(`${packageName}/package.json`);
  const pkg = readPackageJson(packageJsonPath);
  const bins = typeof pkg.bin === 'string' ? { [packageName]: pkg.bin } : pkg.bin ?? {};
  const binName = preferredBin && bins[preferredBin]
    ? preferredBin
    : Object.keys(bins).length === 1
      ? Object.keys(bins)[0]!
      : preferredBin ?? '';
  const relativeCli = binName ? bins[binName] : undefined;
  if (!relativeCli) {
    throw new Error(
      `Package ${packageName} does not expose the expected CLI${preferredBin ? ` (${preferredBin})` : ''}.`
    );
  }
  const cliPath = resolve(dirname(packageJsonPath), relativeCli);
  if (!existsSync(cliPath)) {
    throw new Error(`Package-local CLI is missing: ${cliPath}`);
  }
  return {
    packageName: pkg.name ?? packageName,
    packageVersion: pkg.version ?? 'unknown',
    packageJsonPath,
    cliPath,
    binName,
  };
}

function isLegacyGeneratedPlaywright(def: AdapterDef): boolean {
  if (def.command !== 'npx' && def.command !== 'npx.cmd') return false;
  const packageArg = def.args.find((arg) => arg === LEGACY_GENERATED_PLAYWRIGHT_SPEC);
  if (!packageArg) return false;
  const allowed = new Set(['-y', '--yes', packageArg, '--isolated']);
  return def.args.every((arg) => allowed.has(arg));
}

export function isPackageLocalPlaywright(name: string, def: AdapterDef): boolean {
  return name === 'playwright' && (
    def.command === PACKAGE_LOCAL_PLAYWRIGHT_COMMAND || isLegacyGeneratedPlaywright(def)
  );
}

export function resolveAdapterLaunch(
  name: string,
  def: AdapterDef,
  resolver: NodeJS.Require = requireFromAdapter
): ResolvedAdapterLaunch {
  if (isPackageLocalPlaywright(name, def)) {
    const resolved = resolvePackageCli(PLAYWRIGHT_MCP_PACKAGE, 'mcp-server-playwright', resolver);
    const passthrough = def.command === PACKAGE_LOCAL_PLAYWRIGHT_COMMAND
      ? [...def.args]
      : def.args.filter((arg) => arg !== '-y' && arg !== '--yes' && !arg.startsWith(`${PLAYWRIGHT_MCP_PACKAGE}@`));
    return {
      command: process.execPath,
      args: [resolved.cliPath, ...passthrough],
      ...(def.cwd ? { cwd: isAbsolute(def.cwd) ? def.cwd : resolve(def.cwd) } : {}),
      source: 'package-local',
      packageName: resolved.packageName,
      packageVersion: resolved.packageVersion,
      packageJsonPath: resolved.packageJsonPath,
      cliPath: resolved.cliPath,
    };
  }

  return {
    command: def.command,
    args: [...def.args],
    ...(def.cwd ? { cwd: isAbsolute(def.cwd) ? def.cwd : resolve(def.cwd) } : {}),
    source: 'custom',
  };
}


export interface PlaywrightMcpRuntimeResolution {
  mcpPackageJsonPath: string;
  mcpVersion: string;
  playwrightPackageJsonPath: string;
  playwrightVersion: string;
  playwrightCliPath: string;
  chromiumExecutablePath: string;
}

export function resolvePlaywrightMcpRuntime(
  resolver: NodeJS.Require = requireFromAdapter
): PlaywrightMcpRuntimeResolution {
  const mcpPackageJsonPath = resolver.resolve(`${PLAYWRIGHT_MCP_PACKAGE}/package.json`);
  const mcpPackage = readPackageJson(mcpPackageJsonPath);
  const requireFromMcp = createRequire(mcpPackageJsonPath);
  const playwrightPackageJsonPath = requireFromMcp.resolve('playwright/package.json');
  const playwrightPackage = readPackageJson(playwrightPackageJsonPath);
  const playwrightCliPath = resolve(dirname(playwrightPackageJsonPath), 'cli.js');
  if (!existsSync(playwrightCliPath)) {
    throw new Error(`Playwright CLI is missing next to ${playwrightPackageJsonPath}`);
  }
  const playwright = requireFromMcp('playwright') as {
    chromium?: { executablePath: () => string };
  };
  const chromiumExecutablePath = playwright.chromium?.executablePath();
  if (!chromiumExecutablePath) {
    throw new Error('The @playwright/mcp Playwright runtime does not expose chromium.executablePath().');
  }
  return {
    mcpPackageJsonPath,
    mcpVersion: mcpPackage.version ?? 'unknown',
    playwrightPackageJsonPath,
    playwrightVersion: playwrightPackage.version ?? 'unknown',
    playwrightCliPath,
    chromiumExecutablePath,
  };
}

export function packageLocalPlaywrightDef(enabled: boolean): AdapterDef {
  return {
    enabled,
    command: PACKAGE_LOCAL_PLAYWRIGHT_COMMAND,
    args: ['--isolated'],
  };
}
