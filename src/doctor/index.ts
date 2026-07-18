import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { defaultConfig, loadConfig } from '../core/config.js';
import type { AdapterDef, FolderForgeConfig } from '../core/types.js';
import { readFolderForgeVersion } from '../core/version.js';
import { PluginManager } from '../plugins/plugin-manager.js';
import {
  StdioChildClient,
  ChildMcpError,
  classifyChildFailureDisposition,
  redactChildArgs,
  type ChildMcpDiagnostic,
  type ChildTransportStats,
} from '../adapters/child-mcp/client.js';
import { resolveAdapterLaunch, resolvePlaywrightMcpRuntime } from '../adapters/child-mcp/resolve.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail';
export type DoctorSeverity = 'info' | 'warning' | 'error' | 'blocker';
export type DoctorExitCode = 0 | 1 | 2;

export interface DoctorFinding {
  id: string;
  status: DoctorStatus;
  severity: DoctorSeverity;
  summary: string;
  evidence: string;
  remediation: string;
  exitCode: 0 | 1;
}

export interface DoctorReport {
  schemaVersion: 1;
  ok: boolean;
  version: string;
  projectRoot: string;
  generatedAt: string;
  exitCode: DoctorExitCode;
  findings: DoctorFinding[];
}

export interface AdapterReadinessProbeResult {
  command: string;
  args: string[];
  cwd: string;
  source: 'custom' | 'package-local';
  tools: number;
  protocolVersion?: string;
  elapsedMs?: number;
  transport?: ChildTransportStats;
  packageName?: string;
  packageVersion?: string;
}

export interface DoctorOptions {
  projectRoot?: string;
  configPath?: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
  portProbe?: (host: string, port: number) => Promise<{ ok: boolean; evidence: string }>;
  playwrightProbe?: () => { packagePath: string; executablePath: string; exists: boolean };
  adapterProbe?: (
    name: string,
    def: AdapterDef,
    env: NodeJS.ProcessEnv,
    projectRoot: string
  ) => Promise<AdapterReadinessProbeResult>;
}

export interface DoctorCliResult {
  exitCode: DoctorExitCode;
  output: string;
  report?: DoctorReport;
}

const VERSION = readFolderForgeVersion();
const STALE_MS = 24 * 60 * 60 * 1000;
const requireFromDoctor = createRequire(import.meta.url);

function finding(
  id: string,
  status: DoctorStatus,
  severity: DoctorSeverity,
  summary: string,
  evidence: string,
  remediation = ''
): DoctorFinding {
  return {
    id,
    status,
    severity,
    summary,
    evidence,
    remediation,
    exitCode: status === 'fail' ? 1 : 0,
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function resolvePackageJson(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolve(here, '..', '..', 'package.json'),
    resolve(here, '..', 'package.json'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function hasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\') || command.includes(sep);
}

function findExecutable(command: string, env: NodeJS.ProcessEnv): string | null {
  if (!command.trim()) return null;
  if (hasPathSeparator(command)) {
    const candidate = isAbsolute(command) ? command : resolve(command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      return null;
    }
  }

  const pathValue = env.PATH ?? env.Path ?? env.path ?? '';
  const extensions =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, process.platform === 'win32' ? `${command}${extension}` : command);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return null;
}

function runReadOnly(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const isWindowsScript = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    ...(isWindowsScript ? { shell: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe' } : {}),
  });
  return {
    ok: result.status === 0 && result.error === undefined,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? result.error?.message ?? '').trim(),
    status: result.status,
  };
}

function configCandidates(projectRoot: string, explicit: string | undefined, env: NodeJS.ProcessEnv): string[] {
  const raw = [
    explicit,
    env.FOLDERFORGE_CONFIG,
    resolve(projectRoot, 'folderforge.yaml'),
    resolve(projectRoot, '.folderforge.yaml'),
    resolve(projectRoot, '.folderforge/config.yaml'),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(raw.map((value) => (isAbsolute(value) ? resolve(value) : resolve(projectRoot, value))))];
}

function inspectConfig(
  projectRoot: string,
  explicitConfigPath: string | undefined,
  env: NodeJS.ProcessEnv,
  findings: DoctorFinding[]
): { config: FolderForgeConfig; invocationInvalid: boolean } {
  const candidates = configCandidates(projectRoot, explicitConfigPath, env);
  const selected = candidates.find((candidate) => existsSync(candidate));

  if (explicitConfigPath && !existsSync(candidates[0]!)) {
    findings.push(
      finding(
        'config.discovery',
        'fail',
        'blocker',
        'Explicit config file does not exist.',
        candidates[0]!,
        'Pass an existing YAML file to --config or omit --config to use discovery.'
      )
    );
    return { config: defaultConfig(projectRoot), invocationInvalid: true };
  }

  if (!selected) {
    findings.push(
      finding(
        'config.discovery',
        'warn',
        'warning',
        'No FolderForge config file was discovered; built-in defaults will be used.',
        `Checked: ${candidates.join(', ')}`,
        'Create a config explicitly when you need non-default transports, tools, adapters, or policy.'
      )
    );
    return { config: defaultConfig(projectRoot), invocationInvalid: false };
  }

  try {
    accessSync(selected, constants.R_OK);
    const raw = readFileSync(selected, 'utf8');
    const parsed = parseYaml(raw);
    if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
      throw new Error('Config root must be a YAML mapping/object.');
    }
    const config = loadConfig({ configPath: selected, projectRoot });
    findings.push(
      finding(
        'config.discovery',
        'pass',
        'info',
        'Config file was discovered and validated.',
        selected
      )
    );
    return { config, invocationInvalid: false };
  } catch (error) {
    findings.push(
      finding(
        'config.validation',
        'fail',
        explicitConfigPath ? 'blocker' : 'error',
        'Config file is unreadable or invalid.',
        `${selected}: ${errorText(error)}`,
        'Fix the YAML or validation error, then run folderforge doctor again.'
      )
    );
    return { config: defaultConfig(projectRoot), invocationInvalid: explicitConfigPath !== undefined };
  }
}

function checkNode(findings: DoctorFinding[]): void {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major >= 22) {
    findings.push(
      finding('runtime.node', 'pass', 'info', 'Node.js is compatible.', `node ${process.versions.node}; required >=22.0.0`)
    );
  } else {
    findings.push(
      finding(
        'runtime.node',
        'fail',
        'blocker',
        'Node.js is not compatible.',
        `node ${process.versions.node}; required >=22.0.0`,
        'Install and select Node.js 22 or newer.'
      )
    );
  }
}

function checkPackageVersion(findings: DoctorFinding[]): string | null {
  const packageJson = resolvePackageJson();
  if (!packageJson) {
    findings.push(
      finding(
        'version.consistency',
        'fail',
        'blocker',
        'FolderForge package.json could not be located.',
        `runtime version=${VERSION}`,
        'Reinstall FolderForge from a complete package artifact.'
      )
    );
    return null;
  }

  try {
    const pkg = readJson(packageJson) as { name?: string; version?: string };
    const packageVersion = String(pkg.version ?? '');
    const lockPath = join(dirname(packageJson), 'package-lock.json');
    let lockVersion: string | undefined;
    if (existsSync(lockPath)) {
      const lock = readJson(lockPath) as { version?: string; packages?: Record<string, { version?: string }> };
      lockVersion = lock.packages?.['']?.version ?? lock.version;
    }
    const consistent = packageVersion === VERSION && (!lockVersion || lockVersion === packageVersion);
    if (consistent) {
      findings.push(
        finding(
          'version.consistency',
          'pass',
          'info',
          'Package, lockfile, and runtime versions are consistent.',
          `package=${packageVersion}; runtime=${VERSION}${lockVersion ? `; lock=${lockVersion}` : '; lock=not present'}`
        )
      );
    } else {
      findings.push(
        finding(
          'version.consistency',
          'fail',
          'blocker',
          'FolderForge version metadata is inconsistent.',
          `package=${packageVersion || 'missing'}; runtime=${VERSION}; lock=${lockVersion ?? 'not present'}`,
          'Synchronize package.json, package-lock.json, build output, and release metadata.'
        )
      );
    }
    return packageJson;
  } catch (error) {
    findings.push(
      finding(
        'version.consistency',
        'fail',
        'blocker',
        'FolderForge version metadata could not be read.',
        `${packageJson}: ${errorText(error)}`,
        'Reinstall FolderForge or repair package metadata.'
      )
    );
    return packageJson;
  }
}

function checkPackageManager(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  packageJsonPath: string | null,
  findings: DoctorFinding[]
): void {
  const npm = findExecutable(process.platform === 'win32' ? 'npm.cmd' : 'npm', env) ?? findExecutable('npm', env);
  if (!npm) {
    findings.push(
      finding(
        'package-manager.npm',
        'fail',
        'blocker',
        'npm is not available on PATH.',
        `PATH=${env.PATH ?? ''}`,
        'Install npm with Node.js 22+ and ensure it is on PATH.'
      )
    );
    return;
  }
  const result = runReadOnly(npm, ['--version'], projectRoot, env);
  findings.push(
    result.ok
      ? finding('package-manager.npm', 'pass', 'info', 'npm is available.', `${npm}; version=${result.stdout}`)
      : finding(
          'package-manager.npm',
          'fail',
          'error',
          'npm executable failed.',
          `${npm}; exit=${result.status ?? 'spawn-error'}; ${result.stderr}`,
          'Repair the npm installation or select a working Node.js installation.'
        )
  );

  if (!packageJsonPath) return;
  const required = [
    { label: '@modelcontextprotocol/sdk', request: '@modelcontextprotocol/sdk/server/index.js' },
    { label: 'yaml', request: 'yaml' },
    { label: 'zod', request: 'zod' },
    { label: '@playwright/mcp', request: '@playwright/mcp/package.json' },
  ];
  const resolver = createRequire(packageJsonPath);
  const missing: string[] = [];
  for (const dependency of required) {
    try {
      resolver.resolve(dependency.request);
    } catch {
      missing.push(dependency.label);
    }
  }
  if (missing.length > 0) {
    findings.push(
      finding(
        'dependencies.installation',
        'fail',
        'error',
        'FolderForge dependencies are incomplete.',
        `missing=${missing.join(', ')}`,
        'Run npm ci (repository) or reinstall the published package.'
      )
    );
  } else {
    findings.push(
      finding(
        'dependencies.installation',
        'pass',
        'info',
        'Required FolderForge dependencies are installed.',
        `Resolved: ${required.map((dependency) => dependency.label).join(', ')}`
      )
    );
  }
}

function checkWorkspaceAndGit(projectRoot: string, env: NodeJS.ProcessEnv, findings: DoctorFinding[]): void {
  try {
    accessSync(projectRoot, constants.R_OK);
    findings.push(finding('workspace.readable', 'pass', 'info', 'Workspace is readable.', projectRoot));
  } catch (error) {
    findings.push(
      finding(
        'workspace.readable',
        'fail',
        'blocker',
        'Workspace is not readable.',
        `${projectRoot}: ${errorText(error)}`,
        'Grant read and execute permission on the workspace path.'
      )
    );
  }

  const git = findExecutable('git', env);
  if (!git) {
    findings.push(
      finding(
        'git.available',
        'fail',
        'error',
        'Git is not available on PATH.',
        `PATH=${env.PATH ?? ''}`,
        'Install Git and ensure the executable is on PATH.'
      )
    );
    return;
  }
  const version = runReadOnly(git, ['--version'], projectRoot, env);
  findings.push(
    version.ok
      ? finding('git.available', 'pass', 'info', 'Git is available.', `${git}; ${version.stdout}`)
      : finding(
          'git.available',
          'fail',
          'error',
          'Git executable failed.',
          `${git}; exit=${version.status ?? 'spawn-error'}; ${version.stderr}`,
          'Repair the Git installation.'
        )
  );
  if (!version.ok) return;

  const inside = runReadOnly(git, ['rev-parse', '--is-inside-work-tree'], projectRoot, env);
  if (!inside.ok || inside.stdout !== 'true') {
    findings.push(
      finding(
        'workspace.repository',
        'warn',
        'warning',
        'Workspace is not a Git working tree.',
        inside.stderr || inside.stdout || `exit=${inside.status ?? 'spawn-error'}`,
        'Initialize Git when repository-aware tools are required.'
      )
    );
    return;
  }

  const status = runReadOnly(git, ['status', '--porcelain=v1', '--branch'], projectRoot, env);
  const lines = status.stdout.split('\n').filter(Boolean);
  const changes = lines.filter((line) => !line.startsWith('##'));
  findings.push(
    status.ok
      ? finding(
          'workspace.repository',
          changes.length === 0 ? 'pass' : 'warn',
          changes.length === 0 ? 'info' : 'warning',
          changes.length === 0 ? 'Git working tree is clean.' : 'Git working tree has uncommitted changes.',
          status.stdout || 'clean',
          changes.length === 0 ? '' : 'Review or checkpoint changes before release operations.'
        )
      : finding(
          'workspace.repository',
          'fail',
          'error',
          'Git repository status could not be read.',
          `exit=${status.status ?? 'spawn-error'}; ${status.stderr}`,
          'Repair the repository or filesystem permissions.'
        )
  );
}

function checkWritableRuntime(projectRoot: string, findings: DoctorFinding[]): void {
  const stateRoot = join(projectRoot, '.folderforge');
  try {
    const stateExists = existsSync(stateRoot);
    if (stateExists && !statSync(stateRoot).isDirectory()) {
      throw new Error('runtime state path exists but is not a directory');
    }
    const target = stateExists ? stateRoot : projectRoot;
    accessSync(target, constants.W_OK);
    if (stateExists && lstatSync(stateRoot).isSymbolicLink()) {
      findings.push(
        finding(
          'runtime.directories',
          'warn',
          'warning',
          'Runtime state directory is writable but is a symbolic link.',
          stateRoot,
          'Review the symlink target and trust boundary before running mutating tools.'
        )
      );
    } else {
      findings.push(
        finding(
          'runtime.directories',
          'pass',
          'info',
          'Runtime state location is writable.',
          stateExists ? stateRoot : `${projectRoot} (state directory not created)`
        )
      );
    }
  } catch (error) {
    findings.push(
      finding(
        'runtime.directories',
        'fail',
        'error',
        'Runtime state location is not writable.',
        `${existsSync(stateRoot) ? stateRoot : projectRoot}: ${errorText(error)}`,
        'Grant write permission to the project state directory or choose a writable project.'
      )
    );
  }
}

async function defaultPortProbe(host: string, port: number): Promise<{ ok: boolean; evidence: string }> {
  return new Promise((resolveProbe) => {
    const server = createServer();
    let settled = false;
    const finish = (result: { ok: boolean; evidence: string }): void => {
      if (settled) return;
      settled = true;
      resolveProbe(result);
    };
    server.once('error', (error) => finish({ ok: false, evidence: errorText(error) }));
    server.listen({ host, port, exclusive: true }, () => {
      const address = server.address();
      server.close((error) =>
        finish({
          ok: error === undefined,
          evidence: error ? errorText(error) : `bind succeeded at ${typeof address === 'string' ? address : `${address?.address}:${address?.port}`}`,
        })
      );
    });
  });
}

async function checkPorts(
  config: FolderForgeConfig,
  probe: (host: string, port: number) => Promise<{ ok: boolean; evidence: string }>,
  findings: DoctorFinding[]
): Promise<void> {
  const ports = [
    { id: 'port.http', label: 'HTTP MCP', host: config.server.http.host, port: config.server.http.port },
    { id: 'port.dashboard', label: 'dashboard', host: config.server.dashboard.host, port: config.server.dashboard.port },
  ];
  if (ports[0]!.host === ports[1]!.host && ports[0]!.port === ports[1]!.port) {
    findings.push(
      finding(
        'port.conflict',
        'fail',
        'error',
        'HTTP MCP and dashboard are configured for the same host and port.',
        `${ports[0]!.host}:${ports[0]!.port}`,
        'Configure distinct ports for server.http.port and server.dashboard.port.'
      )
    );
    return;
  }
  for (const item of ports) {
    try {
      const result = await probe(item.host, item.port);
      findings.push(
        result.ok
          ? finding(item.id, 'pass', 'info', `${item.label} port is available.`, `${item.host}:${item.port}; ${result.evidence}`)
          : finding(
              item.id,
              'fail',
              'error',
              `${item.label} port is unavailable.`,
              `${item.host}:${item.port}; ${result.evidence}`,
              'Stop the conflicting process or configure another port.'
            )
      );
    } catch (error) {
      findings.push(
        finding(
          item.id,
          'fail',
          'error',
          `${item.label} port could not be probed.`,
          `${item.host}:${item.port}; ${errorText(error)}`,
          'Check host resolution, permissions, and network policy.'
        )
      );
    }
  }
}

function adapterEntries(config: FolderForgeConfig): Array<[string, AdapterDef]> {
  const out: Array<[string, AdapterDef]> = [];
  for (const [name, value] of Object.entries(config.adapters)) {
    if (name === 'godot' || !value || typeof value !== 'object' || !('command' in value)) continue;
    out.push([name, value as AdapterDef]);
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

function checkAdapters(config: FolderForgeConfig, env: NodeJS.ProcessEnv, findings: DoctorFinding[]): void {
  const definitions = adapterEntries(config);
  const invalid = definitions.filter(([, def]) => !def.command.trim() || !Array.isArray(def.args) || !def.args.every((arg) => typeof arg === 'string'));
  findings.push(
    invalid.length === 0
      ? finding(
          'adapters.definitions',
          'pass',
          'info',
          'Child MCP adapter definitions are structurally valid.',
          definitions.map(([name, def]) => `${name}:${def.enabled ? 'enabled' : 'disabled'}`).join(', ') || 'none configured'
        )
      : finding(
          'adapters.definitions',
          'fail',
          'error',
          'One or more child MCP adapter definitions are invalid.',
          invalid.map(([name]) => name).join(', '),
          'Set a non-empty command and string-only args array for each adapter.'
        )
  );

  for (const [name, def] of definitions) {
    if (!def.enabled) {
      findings.push(finding(`adapter.${name}`, 'pass', 'info', `${name} adapter is disabled.`, `command=${def.command}`));
      continue;
    }

    try {
      const launch = resolveAdapterLaunch(name, def);
      const executable = launch.source === 'package-local'
        ? launch.command
        : findExecutable(launch.command, env);
      if (!executable) {
        findings.push(
          finding(
            `adapter.${name}`,
            'fail',
            'error',
            `${name} adapter executable is unavailable.`,
            `command=${launch.command}; source=${launch.source}`,
            `Install ${launch.command} or update the adapter command.`
          )
        );
      } else {
        const unpinned = def.args.some((arg) => arg.includes('@latest'));
        findings.push(
          finding(
            `adapter.${name}`,
            unpinned ? 'warn' : 'pass',
            unpinned ? 'warning' : 'info',
            launch.source === 'package-local'
              ? `${name} adapter resolved from the FolderForge dependency tree.`
              : unpinned
                ? `${name} adapter uses an unpinned package reference.`
                : `${name} adapter executable is available.`,
            `command=${launch.command}; args=${JSON.stringify(redactChildArgs(launch.args))}; source=${launch.source}` +
              (launch.packageName ? `; package=${launch.packageName}@${launch.packageVersion}` : ''),
            unpinned ? 'Pin the child MCP package version for repeatable installs and provenance review.' : ''
          )
        );
      }
    } catch (error) {
      findings.push(
        finding(
          `adapter.${name}`,
          'fail',
          'error',
          `${name} adapter could not be resolved.`,
          errorText(error),
          name === 'playwright'
            ? 'Reinstall FolderForge so @playwright/mcp is present package-locally, then run folderforge doctor again.'
            : 'Repair the adapter installation or command configuration.'
        )
      );
    }

    if (def.inheritEnv !== false) {
      findings.push(
        finding(
          `adapter.${name}.environment`,
          'warn',
          'warning',
          `${name} adapter may inherit the parent environment.`,
          `inheritEnv=${String(def.inheritEnv ?? true)}`,
          'Use an explicit environment allowlist and set inheritEnv=false for untrusted child MCP processes.'
        )
      );
    } else {
      findings.push(
        finding(
          `adapter.${name}.environment`,
          'pass',
          'info',
          `${name} adapter does not inherit the full parent environment.`,
          `allowlisted keys=${Object.keys(def.env ?? {}).sort().join(', ') || 'none'}`
        )
      );
    }
  }
}

function defaultPlaywrightProbe(): { packagePath: string; executablePath: string; exists: boolean } {
  const runtime = resolvePlaywrightMcpRuntime(requireFromDoctor);
  return {
    packagePath: `${runtime.playwrightPackageJsonPath} (${runtime.playwrightVersion}; @playwright/mcp ${runtime.mcpVersion})`,
    executablePath: runtime.chromiumExecutablePath,
    exists: existsSync(runtime.chromiumExecutablePath),
  };
}

function checkPlaywright(
  config: FolderForgeConfig,
  findings: DoctorFinding[],
  probe: () => { packagePath: string; executablePath: string; exists: boolean } = defaultPlaywrightProbe
): void {
  const enabled = config.adapters.playwright?.enabled === true;
  try {
    const result = probe();
    if (result.exists) {
      findings.push(
        finding(
          'playwright.chromium',
          'pass',
          'info',
          'Playwright and Chromium are available.',
          `package=${result.packagePath}; chromium=${result.executablePath}`
        )
      );
    } else {
      findings.push(
        finding(
          'playwright.chromium',
          enabled ? 'fail' : 'warn',
          enabled ? 'error' : 'warning',
          'Playwright is installed but the Chromium executable is missing.',
          result.executablePath,
          'Run folderforge setup browser explicitly when browser tools are needed.'
        )
      );
    }
  } catch (error) {
    findings.push(
      finding(
        'playwright.chromium',
        enabled ? 'fail' : 'warn',
        enabled ? 'error' : 'warning',
        'Playwright or Chromium could not be resolved.',
        errorText(error),
        'Install package dependencies, then run folderforge setup browser explicitly.'
      )
    );
  }
}

async function defaultAdapterReadinessProbe(
  name: string,
  def: AdapterDef,
  env: NodeJS.ProcessEnv,
  projectRoot: string
): Promise<AdapterReadinessProbeResult> {
  const launch = resolveAdapterLaunch(name, def);
  let diagnostic: ChildMcpDiagnostic | null = null;
  const client = new StdioChildClient({
    adapter: name,
    command: launch.command,
    args: launch.args,
    cwd: launch.cwd ?? projectRoot,
    env: {
      ...(def.env ?? {}),
      // Doctor never permits npx/npm to fetch from the network. Legacy generated
      // Playwright definitions are resolved package-locally before this point.
      npm_config_offline: 'true',
      NPM_CONFIG_OFFLINE: 'true',
    },
    inheritEnv: def.inheritEnv !== false,
    requestTimeoutMs: 5_000,
    stderrLimit: 16 * 1024,
    onDiagnostic: (value) => {
      diagnostic = value;
    },
  });
  const startedAt = Date.now();
  try {
    await client.start();
    const tools = await client.listTools(5_000);
    return {
      command: launch.command,
      args: redactChildArgs(launch.args),
      cwd: launch.cwd ?? projectRoot,
      source: launch.source,
      tools: tools.length,
      ...(client.protocolVersion() ? { protocolVersion: client.protocolVersion()! } : {}),
      elapsedMs: Date.now() - startedAt,
      transport: client.transportStats(),
      ...(launch.packageName ? { packageName: launch.packageName } : {}),
      ...(launch.packageVersion ? { packageVersion: launch.packageVersion } : {}),
    };
  } catch (error) {
    if (error instanceof ChildMcpError) throw error;
    if (diagnostic) throw new ChildMcpError(`${name} adapter readiness probe failed`, diagnostic);
    throw error;
  } finally {
    await client.stopAndWait(1_000);
  }
}

async function checkAdapterReadiness(
  config: FolderForgeConfig,
  env: NodeJS.ProcessEnv,
  projectRoot: string,
  findings: DoctorFinding[],
  probe: DoctorOptions['adapterProbe'] = defaultAdapterReadinessProbe
): Promise<void> {
  for (const [name, def] of adapterEntries(config)) {
    const id = `adapter.${name}.handshake`;
    const label = name === 'playwright' ? 'Playwright' : name;
    if (!def.enabled) {
      findings.push(
        finding(
          id,
          'pass',
          'info',
          `${label} adapter handshake probe was skipped because the adapter is disabled.`,
          'enabled=false'
        )
      );
      continue;
    }

    try {
      const result = await probe!(name, def, env, projectRoot);
      const transport = result.transport
        ? `; transport=${JSON.stringify({
            bytesSent: result.transport.bytesSent,
            bytesReceived: result.transport.bytesReceived,
            requestsSent: result.transport.requestsSent,
            responsesReceived: result.transport.responsesReceived,
            pendingRequests: result.transport.pendingRequests,
          })}`
        : '';
      findings.push(
        finding(
          id,
          'pass',
          'info',
          name === 'playwright'
            ? 'Playwright child completed MCP initialize and tools/list.'
            : `${label} child completed MCP initialize and tools/list.`,
          `phase=tools/list; command=${result.command}; args=${JSON.stringify(result.args)}; cwd=${result.cwd}; ` +
            `source=${result.source}; tools=${result.tools}` +
            (result.protocolVersion ? `; protocol=${result.protocolVersion}` : '') +
            (result.elapsedMs !== undefined ? `; elapsedMs=${result.elapsedMs}` : '') +
            transport +
            (result.packageName ? `; package=${result.packageName}@${result.packageVersion}` : '')
        )
      );
    } catch (error) {
      const diagnostic = error instanceof ChildMcpError ? error.diagnostic : undefined;
      const disposition = diagnostic
        ? classifyChildFailureDisposition(diagnostic.kind)
        : 'transient';
      findings.push(
        finding(
          id,
          'fail',
          'error',
          name === 'playwright'
            ? 'Playwright child failed its MCP readiness handshake.'
            : `${label} child failed its MCP readiness handshake.`,
          diagnostic
            ? `phase=${diagnostic.phase}; kind=${diagnostic.kind}; disposition=${disposition}; ` +
              `command=${diagnostic.command}; args=${JSON.stringify(diagnostic.args)}; cwd=${diagnostic.cwd}; ` +
              `exit=${diagnostic.exitCode ?? 'none'}; signal=${diagnostic.signal ?? 'none'}; ` +
              `timeout=${diagnostic.timedOut}; spawnError=${diagnostic.spawnError || 'none'}; ` +
              `stderr=${diagnostic.stderrTail || 'none'}`
            : `disposition=${disposition}; ${errorText(error)}`,
          diagnostic?.remediation ??
            (name === 'playwright'
              ? 'Run folderforge setup browser, then run folderforge doctor again.'
              : 'Repair the adapter command or package, then run folderforge doctor again.')
        )
      );
    }
  }
}

function checkPlugins(projectRoot: string, env: NodeJS.ProcessEnv, findings: DoctorFinding[]): void {
  const root = join(projectRoot, '.folderforge', 'plugins');
  if (!existsSync(root)) {
    findings.push(finding('plugins.registry', 'pass', 'info', 'No local plugin registry is present.', root));
    return;
  }
  try {
    if (lstatSync(root).isSymbolicLink()) {
      findings.push(
        finding(
          'plugins.directory',
          'fail',
          'error',
          'Plugin directory is a symbolic link.',
          root,
          'Use a real directory inside the workspace state root and review plugin provenance.'
        )
      );
    }
    accessSync(root, constants.R_OK);
    const manager = new PluginManager(projectRoot, VERSION);
    const plugins = manager.list().sort((a, b) => a.id.localeCompare(b.id));
    findings.push(
      finding(
        'plugins.registry',
        'pass',
        'info',
        'Plugin registry is readable.',
        `${plugins.length} installed plugin(s)`
      )
    );
    for (const plugin of plugins) {
      try {
        const rel = relative(root, resolve(plugin.installDir));
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('installDir escapes the plugin root');
        if (!existsSync(plugin.installDir)) throw new Error('installDir does not exist');
        if (lstatSync(plugin.installDir).isSymbolicLink()) throw new Error('installDir is a symbolic link');
        const inspected = manager.inspect(plugin.id);
        const runtime = manager.adapter(plugin.id);
        const command = runtime.def.command;
        const executable = hasPathSeparator(command)
          ? existsSync(command)
            ? command
            : null
          : findExecutable(command, env);
        if (!executable) throw new Error(`runtime executable is unavailable: ${command}`);
        const declared = inspected.manifest.permissions ?? {};
        const sensitive = declared.network === true || declared.filesystem === 'external' || (declared.env?.length ?? 0) > 0;
        const unverified = inspected.integrity.status === 'unverified';
        const warn = sensitive || unverified;
        findings.push(
          finding(
            `plugin.${plugin.id}`,
            warn ? 'warn' : 'pass',
            warn ? 'warning' : 'info',
            unverified
              ? `Plugin ${plugin.id} has no recorded package integrity digest.`
              : sensitive
                ? `Plugin ${plugin.id} has elevated declared permissions.`
                : `Plugin ${plugin.id} manifest, compatibility, and integrity are valid.`,
            `version=${plugin.version}; enabled=${plugin.enabled}; command=${command}; ` +
              `integrity=${inspected.integrity.status}:${inspected.integrity.actual.digest}; ` +
              `permissions=${JSON.stringify(declared)}`,
            unverified
              ? 'Reinstall or update the plugin from a reviewed local source to record a SHA-256 package digest.'
              : sensitive
                ? 'Treat plugin permissions as review metadata, not an OS sandbox; verify publisher, provenance, and runtime behavior.'
                : ''
          )
        );
      } catch (error) {
        findings.push(
          finding(
            `plugin.${plugin.id}`,
            'fail',
            'error',
            `Plugin ${plugin.id} is invalid or incompatible.`,
            errorText(error),
            'Disable or reinstall the plugin from a reviewed local source.'
          )
        );
      }
    }
  } catch (error) {
    findings.push(
      finding(
        'plugins.registry',
        'fail',
        'error',
        'Plugin registry is unreadable or corrupt.',
        `${root}: ${errorText(error)}`,
        'Restore registry.json and installed plugin directories from a known-good checkpoint.'
      )
    );
  }
}

function parseJsonLines(path: string): { records: Array<Record<string, unknown>>; corrupt: number } {
  const records: Array<Record<string, unknown>> = [];
  let corrupt = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) corrupt++;
      else records.push(value as Record<string, unknown>);
    } catch {
      corrupt++;
    }
  }
  return { records, corrupt };
}

function checkState(projectRoot: string, now: number, findings: DoctorFinding[]): void {
  const approvalPath = join(projectRoot, '.folderforge', 'approvals.jsonl');
  if (!existsSync(approvalPath)) {
    findings.push(finding('state.approvals', 'pass', 'info', 'Approval state file is absent.', approvalPath));
  } else {
    try {
      const { records, corrupt } = parseJsonLines(approvalPath);
      const stale = records.filter(
        (record) => record.state === 'pending' && typeof record.createdAt === 'number' && now - record.createdAt > STALE_MS
      ).length;
      findings.push(
        corrupt > 0
          ? finding(
              'state.approvals',
              'fail',
              'error',
              'Approval state contains corrupt JSONL records.',
              `records=${records.length}; corrupt=${corrupt}; stalePending=${stale}`,
              'Restore or repair approvals.jsonl without discarding valid audit history.'
            )
          : finding(
              'state.approvals',
              stale > 0 ? 'warn' : 'pass',
              stale > 0 ? 'warning' : 'info',
              stale > 0 ? 'Approval state contains stale pending requests.' : 'Approval state is readable.',
              `records=${records.length}; stalePending=${stale}`,
              stale > 0 ? 'Review and explicitly deny or re-create stale approval requests.' : ''
            )
      );
    } catch (error) {
      findings.push(
        finding(
          'state.approvals',
          'fail',
          'error',
          'Approval state cannot be read.',
          `${approvalPath}: ${errorText(error)}`,
          'Repair file permissions or restore the state file.'
        )
      );
    }
  }

  const auditPath = join(projectRoot, '.folderforge', 'audit', 'audit.jsonl');
  if (!existsSync(auditPath)) {
    findings.push(finding('state.audit', 'pass', 'info', 'Audit log is absent.', auditPath));
  } else {
    try {
      const { records, corrupt } = parseJsonLines(auditPath);
      findings.push(
        corrupt > 0
          ? finding(
              'state.audit',
              'fail',
              'error',
              'Audit log contains corrupt JSONL records.',
              `records=${records.length}; corrupt=${corrupt}`,
              'Preserve the original log, then repair invalid lines in a reviewed copy.'
            )
          : finding('state.audit', 'pass', 'info', 'Audit log is readable.', `records=${records.length}; corrupt=0`)
      );
    } catch (error) {
      findings.push(
        finding(
          'state.audit',
          'fail',
          'error',
          'Audit log cannot be read.',
          `${auditPath}: ${errorText(error)}`,
          'Repair file permissions or restore the audit log.'
        )
      );
    }
  }

  const runsDir = join(projectRoot, '.folderforge', 'workflows', 'runs');
  if (!existsSync(runsDir)) {
    findings.push(finding('state.workflows', 'pass', 'info', 'Workflow state directory is absent.', runsDir));
    return;
  }
  try {
    const names = readdirSync(runsDir).sort();
    const runFiles = names.filter((name) => /^wf_[a-z0-9]+\.json$/i.test(name));
    const leftovers = names.filter((name) => name.includes('.tmp') || name.includes('.backup') || name.includes('.staging'));
    let corrupt = 0;
    let stale = 0;
    for (const name of runFiles.slice(0, 1000)) {
      try {
        const value = readJson(join(runsDir, name)) as Record<string, unknown>;
        if (value.schemaVersion !== 1 || typeof value.id !== 'string') {
          corrupt++;
          continue;
        }
        if (
          ['running', 'paused'].includes(String(value.state)) &&
          typeof value.updatedAt === 'number' &&
          now - value.updatedAt > STALE_MS
        ) {
          stale++;
        }
      } catch {
        corrupt++;
      }
    }
    if (corrupt > 0) {
      findings.push(
        finding(
          'state.workflows',
          'fail',
          'error',
          'Workflow state contains corrupt run files.',
          `runs=${runFiles.length}; corrupt=${corrupt}; stale=${stale}; leftovers=${leftovers.length}`,
          'Restore corrupt run files or archive them after preserving evidence.'
        )
      );
    } else if (stale > 0 || leftovers.length > 0) {
      findings.push(
        finding(
          'state.workflows',
          'warn',
          'warning',
          'Workflow state contains stale runs or temporary leftovers.',
          `runs=${runFiles.length}; stale=${stale}; leftovers=${leftovers.join(', ') || 'none'}`,
          'Review resumable runs and remove leftovers only after confirming no process owns them.'
        )
      );
    } else {
      findings.push(
        finding('state.workflows', 'pass', 'info', 'Workflow state is readable.', `runs=${runFiles.length}; stale=0; leftovers=0`)
      );
    }
  } catch (error) {
    findings.push(
      finding(
        'state.workflows',
        'fail',
        'error',
        'Workflow state cannot be read.',
        `${runsDir}: ${errorText(error)}`,
        'Repair directory permissions or restore workflow state.'
      )
    );
  }
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const findings: DoctorFinding[] = [];

  if (!existsSync(projectRoot)) {
    findings.push(
      finding(
        'invocation.project',
        'fail',
        'blocker',
        'Project path does not exist.',
        projectRoot,
        'Pass an existing directory with --project.'
      )
    );
    return finalizeReport(projectRoot, findings, true, now);
  }
  try {
    if (!statSync(projectRoot).isDirectory()) throw new Error('path is not a directory');
  } catch (error) {
    findings.push(
      finding(
        'invocation.project',
        'fail',
        'blocker',
        'Project path is not a usable directory.',
        `${projectRoot}: ${errorText(error)}`,
        'Pass an existing directory with --project.'
      )
    );
    return finalizeReport(projectRoot, findings, true, now);
  }

  checkNode(findings);
  const packageJsonPath = checkPackageVersion(findings);
  checkPackageManager(projectRoot, env, packageJsonPath, findings);
  checkWorkspaceAndGit(projectRoot, env, findings);
  const configResult = inspectConfig(projectRoot, options.configPath, env, findings);
  checkWritableRuntime(projectRoot, findings);
  await checkPorts(configResult.config, options.portProbe ?? defaultPortProbe, findings);
  checkAdapters(configResult.config, env, findings);
  checkPlaywright(configResult.config, findings, options.playwrightProbe);
  await checkAdapterReadiness(configResult.config, env, projectRoot, findings, options.adapterProbe);
  checkPlugins(projectRoot, env, findings);
  checkState(projectRoot, now, findings);

  return finalizeReport(projectRoot, findings, configResult.invocationInvalid, now);
}

function finalizeReport(
  projectRoot: string,
  findings: DoctorFinding[],
  invocationInvalid: boolean,
  now: number
): DoctorReport {
  const sorted = [...findings].sort((a, b) => a.id.localeCompare(b.id));
  const exitCode: DoctorExitCode = invocationInvalid ? 2 : sorted.some((item) => item.status === 'fail') ? 1 : 0;
  return {
    schemaVersion: 1,
    ok: exitCode === 0,
    version: VERSION,
    projectRoot,
    generatedAt: new Date(now).toISOString(),
    exitCode,
    findings: sorted,
  };
}

export function formatDoctorHuman(report: DoctorReport): string {
  const labels: Record<DoctorStatus, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };
  const lines = [
    `FolderForge doctor ${report.version}`,
    `Project: ${report.projectRoot}`,
    '',
  ];
  for (const item of report.findings) {
    lines.push(`[${labels[item.status]}] ${item.id}: ${item.summary}`);
    if (item.evidence) lines.push(`  Evidence: ${item.evidence}`);
    if (item.remediation) lines.push(`  Remediation: ${item.remediation}`);
  }
  const warnings = report.findings.filter((item) => item.status === 'warn').length;
  const failures = report.findings.filter((item) => item.status === 'fail').length;
  lines.push('', `Result: exit ${report.exitCode}; ${failures} failure(s), ${warnings} warning(s).`, '');
  return lines.join('\n');
}

export function doctorHelp(): string {
  return [
    'Usage: folderforge doctor [options]',
    '',
    'Options:',
    '  -p, --project <dir>  Project root to inspect (default: cwd)',
    '  -c, --config <file>  Explicit YAML config to validate',
    '      --json           Emit a stable JSON report',
    '  -h, --help           Show this help',
    '',
    'Doctor is read-only: it does not create config, install browsers, change permissions, or repair state.',
    '',
  ].join('\n');
}

function invocationErrorReport(projectRoot: string, message: string): DoctorReport {
  return finalizeReport(
    resolve(projectRoot),
    [
      finding(
        'invocation.arguments',
        'fail',
        'blocker',
        'Doctor invocation is invalid.',
        message,
        'Run folderforge doctor --help for supported arguments.'
      ),
    ],
    true,
    Date.now()
  );
}

export async function executeDoctorCli(argv: string[], cwd = process.cwd()): Promise<DoctorCliResult> {
  let projectRoot = cwd;
  let configPath: string | undefined;
  let json = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') return { exitCode: 0, output: doctorHelp() };
    if (arg === '--project' || arg === '-p' || arg === '--config' || arg === '-c') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        const report = invocationErrorReport(projectRoot, `Missing value for ${arg}.`);
        return { exitCode: 2, output: json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorHuman(report), report };
      }
      index++;
      if (arg === '--project' || arg === '-p') projectRoot = isAbsolute(value) ? value : resolve(cwd, value);
      else configPath = value;
      continue;
    }
    const report = invocationErrorReport(projectRoot, `Unknown argument: ${arg}`);
    return { exitCode: 2, output: json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorHuman(report), report };
  }

  const report = await runDoctor({
    projectRoot,
    ...(configPath !== undefined ? { configPath } : {}),
  });
  return {
    exitCode: report.exitCode,
    output: json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorHuman(report),
    report,
  };
}
