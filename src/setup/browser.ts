import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readFolderForgeVersion } from '../core/version.js';
import { resolvePlaywrightMcpRuntime } from '../adapters/child-mcp/resolve.js';

export type BrowserSetupExitCode = 0 | 1 | 2;

export interface BrowserSetupReport {
  schemaVersion: 1;
  ok: boolean;
  version: string;
  browser: 'chromium';
  command: string;
  args: string[];
  dryRun: boolean;
  withDeps: boolean;
  exitCode: BrowserSetupExitCode;
  stdout: string;
  stderr: string;
  error: string;
  executablePath?: string;
  runtimeVersion?: string;
}

export interface BrowserSetupCliResult {
  exitCode: BrowserSetupExitCode;
  output: string;
  report?: BrowserSetupReport;
}

interface RunResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

export interface BrowserSetupDependencies {
  resolvePlaywrightCli?: () => string;
  resolveChromiumExecutable?: () => { executablePath: string; runtimeVersion: string };
  run?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => RunResult;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const VERSION = readFolderForgeVersion();
function defaultResolvePlaywrightCli(): string {
  return resolvePlaywrightMcpRuntime().playwrightCliPath;
}

function defaultResolveChromiumExecutable(): { executablePath: string; runtimeVersion: string } {
  const runtime = resolvePlaywrightMcpRuntime();
  return { executablePath: runtime.chromiumExecutablePath, runtimeVersion: runtime.playwrightVersion };
}

function defaultRun(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): RunResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeReport(input: Omit<BrowserSetupReport, 'schemaVersion' | 'ok' | 'version' | 'browser'>): BrowserSetupReport {
  return {
    schemaVersion: 1,
    ok: input.exitCode === 0,
    version: VERSION,
    browser: 'chromium',
    ...input,
  };
}

export function browserSetupHelp(): string {
  return [
    'Usage: folderforge setup browser [options]',
    '',
    'Options:',
    '      --with-deps  Also ask Playwright to install operating-system dependencies',
    '      --dry-run    Resolve and print the package-local command without downloading',
    '      --json       Emit a stable JSON report',
    '  -h, --help       Show this help',
    '',
    'This command is explicitly opt-in and may access the network. Normal FolderForge installation does not download browsers.',
    '',
  ].join('\n');
}

function setupHelp(): string {
  return [
    'Usage: folderforge setup <target> [options]',
    '',
    'Targets:',
    '  browser  Install the package-compatible Playwright Chromium runtime',
    '',
    'Run folderforge setup browser --help for target options.',
    '',
  ].join('\n');
}

function formatHuman(report: BrowserSetupReport): string {
  if (report.exitCode === 2) {
    return `FolderForge browser setup: invalid invocation\n${report.error}\nRun folderforge setup browser --help.\n`;
  }
  if (report.dryRun) {
    return [
      'FolderForge browser setup (dry run)',
      `Command: ${report.command} ${report.args.join(' ')}`,
      'No browser was downloaded.',
      '',
    ].join('\n');
  }
  if (report.ok) {
    return [
      'FolderForge browser setup complete.',
      report.stdout.trim(),
      report.stderr.trim(),
      report.executablePath ? `Chromium: ${report.executablePath}` : '',
      '',
    ].filter((line, index, all) => line || index === all.length - 1).join('\n');
  }
  return [
    'FolderForge browser setup failed.',
    report.error,
    report.stdout.trim(),
    report.stderr.trim(),
    'Run folderforge doctor for diagnostics, then retry when network and filesystem access are available.',
    '',
  ].filter((line, index, all) => line || index === all.length - 1).join('\n');
}

export function executeBrowserSetupCli(
  argv: string[],
  dependencies: BrowserSetupDependencies = {}
): BrowserSetupCliResult {
  const cwd = resolve(dependencies.cwd ?? process.cwd());
  const env = dependencies.env ?? process.env;
  const json = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  const withDeps = argv.includes('--with-deps');

  if (argv[0] === '--help' || argv[0] === '-h') return { exitCode: 0, output: setupHelp() };
  if (argv[0] !== 'browser') {
    const report = makeReport({
      command: process.execPath,
      args: [],
      dryRun: false,
      withDeps: false,
      exitCode: 2,
      stdout: '',
      stderr: '',
      error: argv.length === 0 ? 'Missing setup target.' : `Unknown setup target: ${argv[0]}`,
    });
    return {
      exitCode: 2,
      output: json ? `${JSON.stringify(report, null, 2)}\n` : formatHuman(report),
      report,
    };
  }

  for (const arg of argv.slice(1)) {
    if (arg === '--json' || arg === '--dry-run' || arg === '--with-deps') continue;
    if (arg === '--help' || arg === '-h') return { exitCode: 0, output: browserSetupHelp() };
    else {
      const report = makeReport({
        command: process.execPath,
        args: [],
        dryRun,
        withDeps,
        exitCode: 2,
        stdout: '',
        stderr: '',
        error: `Unknown argument: ${arg}`,
      });
      return {
        exitCode: 2,
        output: json ? `${JSON.stringify(report, null, 2)}\n` : formatHuman(report),
        report,
      };
    }
  }

  let cliPath: string;
  try {
    cliPath = (dependencies.resolvePlaywrightCli ?? defaultResolvePlaywrightCli)();
  } catch (error) {
    const report = makeReport({
      command: process.execPath,
      args: [],
      dryRun,
      withDeps,
      exitCode: 1,
      stdout: '',
      stderr: '',
      error: `Could not resolve the packaged Playwright CLI: ${errorText(error)}`,
    });
    return {
      exitCode: 1,
      output: json ? `${JSON.stringify(report, null, 2)}\n` : formatHuman(report),
      report,
    };
  }

  const args = [cliPath, 'install', ...(withDeps ? ['--with-deps'] : []), 'chromium'];
  let expectedRuntime: { executablePath: string; runtimeVersion: string } | undefined;
  try {
    expectedRuntime = (dependencies.resolveChromiumExecutable ?? defaultResolveChromiumExecutable)();
  } catch {
    // Dry-run can still show the exact package-local install command even when
    // the runtime metadata is incomplete; real setup will fail verification.
  }
  if (dryRun) {
    const report = makeReport({
      command: process.execPath,
      args,
      dryRun: true,
      withDeps,
      exitCode: 0,
      stdout: '',
      stderr: '',
      error: '',
      ...(expectedRuntime ? expectedRuntime : {}),
    });
    return {
      exitCode: 0,
      output: json ? `${JSON.stringify(report, null, 2)}\n` : formatHuman(report),
      report,
    };
  }

  const result = (dependencies.run ?? defaultRun)(process.execPath, args, { cwd, env });
  let exitCode: BrowserSetupExitCode = result.status === 0 ? 0 : 1;
  let verificationError = '';
  let verifiedRuntime = expectedRuntime;
  if (exitCode === 0) {
    try {
      verifiedRuntime = (dependencies.resolveChromiumExecutable ?? defaultResolveChromiumExecutable)();
      if (!existsSync(verifiedRuntime.executablePath)) {
        exitCode = 1;
        verificationError = `Chromium executable is still missing after setup: ${verifiedRuntime.executablePath}`;
      }
    } catch (error) {
      exitCode = 1;
      verificationError = `Could not verify the @playwright/mcp Chromium runtime: ${errorText(error)}`;
    }
  }
  const report = makeReport({
    command: process.execPath,
    args,
    dryRun: false,
    withDeps,
    exitCode,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error
      ? errorText(result.error)
      : verificationError || (exitCode === 0 ? '' : `Playwright exited with code ${String(result.status)}.`),
    ...(verifiedRuntime ? verifiedRuntime : {}),
  });
  return {
    exitCode,
    output: json ? `${JSON.stringify(report, null, 2)}\n` : formatHuman(report),
    report,
  };
}
