/**
 * `folderforge control` — Mission Control plane lifecycle (ADR-0012, Phase 2 bootstrap).
 *
 * After `npm i -g @musashishao/folderforge`, this is the single command needed to
 * get the web control plane running on the machine:
 *
 *   folderforge control start     Spawn a detached control plane and open the SPA
 *   folderforge control status    Report pid + endpoint health
 *   folderforge control stop      Graceful shutdown (SIGTERM)
 *   folderforge control open      Open the SPA in the default browser
 *
 * `control serve` (hidden) is the foreground child started by `control start`. It
 * boots config + container + registry exactly like the MCP server but serves ONLY
 * the dashboard, so no stdio transport is left waiting on a detached stdin.
 *
 * State lives in <projectRoot>/.folderforge/control.json (no secrets; the
 * dashboard binds loopback and therefore needs no token).
 */

import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { get as httpGet } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startDashboard } from '../dashboard/server.js';
import { logger } from '../core/logger.js';
import { readFolderForgeVersion } from '../core/version.js';
import { Container } from '../runtime/container.js';
import {
  applyHttpAuthDefaults,
  loadConfig,
  validateConfig,
} from '../runtime/config.js';
import { buildRegistry } from '../tools/index.js';

export interface ControlCliResult {
  output: string;
  exitCode: number;
}

interface ControlState {
  schemaVersion: 1;
  pid: number;
  port: number;
  projectRoot: string;
  startedAt: string;
  version: string;
  /** Extra directories the control plane may govern (from --allow). */
  allow?: string[];
}

export interface ControlDeps {
  /** Entrypoint of the built runtime; defaults to <dist>/main.js. */
  mainJs: string;
  version: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Check whether a pid refers to a live process. */
  pidAlive: (pid: number) => boolean;
  /** Probe a loopback endpoint; resolves true when any HTTP response arrives. */
  probe: (port: number, path: string, timeoutMs: number) => Promise<boolean>;
  /** Spawn the detached `control serve` child; returns its pid. */
  spawnServe: (args: string[], logPath: string) => number;
  /** Send SIGTERM to a child process. */
  terminate: (pid: number) => void;
  /** Open a URL in the default browser (best-effort). */
  openUrl: (url: string) => void;
  stdoutIsTty: boolean;
  platform: NodeJS.Platform;
}

const DEFAULT_CONTROL_PORT = 7332;
const READY_TIMEOUT_MS = 10_000;
const READY_INTERVAL_MS = 250;
const STOP_TIMEOUT_MS = 5_000;
const STOP_INTERVAL_MS = 100;

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function defaultProbe(
  port: number,
  path: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const req = httpGet(
      { host: '127.0.0.1', port, path, timeout: timeoutMs },
      (res) => {
        res.resume();
        // Any HTTP response (even 401/404) proves a server is listening.
        resolvePromise(res.statusCode !== undefined && res.statusCode < 500);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolvePromise(false);
    });
    req.on('error', () => resolvePromise(false));
  });
}

function defaultSpawnServe(args: string[], logPath: string): number {
  const out = openSync(logPath, 'a');
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    if (child.pid === undefined) {
      throw new Error('spawn returned no pid');
    }
    return child.pid;
  } finally {
    closeSync(out);
  }
}

function defaultTerminate(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already exited.
  }
}

function defaultOpenUrl(url: string, platform: NodeJS.Platform): void {
  const command =
    platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // Opening a browser is best-effort; the URL is always printed.
  }
}

function controlStatePath(projectRoot: string): string {
  return join(projectRoot, '.folderforge', 'control.json');
}

function controlLogPath(projectRoot: string): string {
  return join(projectRoot, '.folderforge', 'control.log');
}

function readControlState(projectRoot: string): ControlState | null {
  const path = controlStatePath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ControlState>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.port !== 'number' ||
      typeof parsed.projectRoot !== 'string' ||
      typeof parsed.startedAt !== 'string' ||
      typeof parsed.version !== 'string'
    ) {
      return null;
    }
    return parsed as ControlState;
  } catch {
    return null;
  }
}

function writeControlState(projectRoot: string, state: ControlState): void {
  const dir = join(projectRoot, '.folderforge');
  mkdirSync(dir, { recursive: true });
  const path = controlStatePath(projectRoot);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

function removeControlState(projectRoot: string): void {
  try {
    unlinkSync(controlStatePath(projectRoot));
  } catch {
    // Already gone.
  }
}

function tailFile(path: string, maxChars: number): string {
  try {
    const content = readFileSync(path, 'utf8');
    return content.length > maxChars ? content.slice(-maxChars) : content;
  } catch {
    return '';
  }
}

interface ControlOptions {
  command: string | null;
  projectRoot: string;
  port?: number;
  open?: boolean;
  allow?: string[];
  json: boolean;
  help: boolean;
}

function parseControlArgs(argv: string[]): ControlOptions {
  let command: string | null = null;
  let projectRoot: string | undefined;
  let port: number | undefined;
  let open: boolean | undefined;
  let allow: string[] | undefined;
  let json = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    switch (a) {
      case '-p':
      case '--project': {
        const v = argv[++i];
        if (v === undefined) throw new Error('--project requires a directory');
        projectRoot = v;
        break;
      }
      case '--port': {
        const v = argv[++i];
        if (v === undefined) throw new Error('--port requires a number');
        const parsed = Number(v);
        if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
          throw new Error(`Invalid --port value: ${v}`);
        }
        port = parsed;
        break;
      }
      case '--open':
        open = true;
        break;
      case '--allow': {
        const v = argv[++i];
        if (v === undefined) throw new Error('--allow requires a directory');
        (allow ??= []).push(v);
        break;
      }
      case '--no-open':
        open = false;
        break;
      case '--json':
        json = true;
        break;
      case '-h':
      case '--help':
        help = true;
        break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown control option: ${a}`);
        if (command !== null) throw new Error(`Unexpected argument: ${a}`);
        command = a;
    }
  }
  const result: ControlOptions = {
    command,
    projectRoot: resolve(projectRoot ?? process.cwd()),
    json,
    help,
  };
  if (port !== undefined) result.port = port;
  if (open !== undefined) result.open = open;
  if (allow !== undefined) result.allow = allow;
  return result;
}

export function controlHelp(): string {
  return [
    'FolderForge Mission Control plane',
    '',
    'Usage: folderforge control <start|stop|status|open> [options]',
    '',
    'Commands:',
    '  start     Start the local control plane in the background and open the SPA',
    '  stop      Stop the background control plane gracefully',
    '  status    Show control plane state and probe its endpoint',
    '  open      Open the Mission Control SPA in the default browser',
    '',
    'Options:',
    '  -p, --project <dir>  Project the control plane governs (default: cwd)',
    '      --port <n>       Dashboard port (default 7332)',
    '      --allow <dir>      Extra directory the plane may govern (repeatable)',
    '      --open/--no-open Open the SPA after start (default: open on a TTY)',
    '      --json           Machine-readable output for status',
    '  -h, --help           Show this help',
    '',
  ].join('\n');
}

async function controlStart(
  options: ControlOptions,
  deps: ControlDeps,
): Promise<ControlCliResult> {
  const { projectRoot } = options;
  const port = options.port ?? DEFAULT_CONTROL_PORT;
  const existing = readControlState(projectRoot);
  if (existing && deps.pidAlive(existing.pid)) {
    if (await deps.probe(existing.port, '/status', 1_000)) {
      return {
        output:
          `Mission Control is already running (pid ${existing.pid}).\n` +
          `http://127.0.0.1:${existing.port}/app\n`,
        exitCode: 0,
      };
    }
    // Pid alive but endpoint dead: the process is stuck; ask the operator.
    return {
      output:
        `A control plane process (pid ${existing.pid}) exists but is not answering on ` +
        `port ${existing.port}. Run \`folderforge control stop\` and retry.\n`,
      exitCode: 1,
    };
  }
  if (existing) removeControlState(projectRoot); // stale state file

  if (await deps.probe(port, '/status', 500)) {
    return {
      output:
        `Port ${port} already answers HTTP but no control plane state exists. ` +
        'Pick another port with --port.\n',
      exitCode: 1,
    };
  }

  mkdirSync(join(projectRoot, '.folderforge'), { recursive: true });
  const logPath = controlLogPath(projectRoot);
  const serveArgs = [
    deps.mainJs,
    'control',
    'serve',
    '--project',
    projectRoot,
    '--port',
    String(port),
    ...(options.allow ?? []).flatMap((dir) => ['--allow', dir]),
  ];
  let pid: number;
  try {
    pid = deps.spawnServe(serveArgs, logPath);
  } catch (err) {
    return {
      output: `Failed to spawn the control plane: ${String(err)}\n`,
      exitCode: 1,
    };
  }

  const deadline = deps.now() + READY_TIMEOUT_MS;
  let ready = false;
  while (deps.now() < deadline) {
    if (!deps.pidAlive(pid)) break;
    if (await deps.probe(port, '/status', 1_000)) {
      ready = true;
      break;
    }
    await deps.sleep(READY_INTERVAL_MS);
  }
  if (!ready) {
    deps.terminate(pid);
    removeControlState(projectRoot);
    const logTail = tailFile(logPath, 4_096);
    return {
      output:
        `Control plane failed to become ready on port ${port} within ${READY_TIMEOUT_MS}ms.\n` +
        (logTail
          ? `Log tail (${logPath}):\n${logTail}\n`
          : `See log: ${logPath}\n`),
      exitCode: 1,
    };
  }

  writeControlState(projectRoot, {
    schemaVersion: 1,
    pid,
    port,
    projectRoot,
    startedAt: new Date(deps.now()).toISOString(),
    version: deps.version,
    ...(options.allow && options.allow.length > 0 ? { allow: options.allow } : {}),
  });

  const url = `http://127.0.0.1:${port}/app`;
  if (options.open ?? deps.stdoutIsTty) deps.openUrl(url);
  return {
    output:
      `Mission Control plane started (pid ${pid}, project ${projectRoot}).\n` +
      `${url}\n` +
      `Logs: ${logPath}\n`,
    exitCode: 0,
  };
}

async function controlStop(
  options: ControlOptions,
  deps: ControlDeps,
): Promise<ControlCliResult> {
  const { projectRoot } = options;
  const existing = readControlState(projectRoot);
  if (!existing) {
    return {
      output: 'No Mission Control plane state found; nothing to stop.\n',
      exitCode: 0,
    };
  }
  if (!deps.pidAlive(existing.pid)) {
    removeControlState(projectRoot);
    return {
      output: `Control plane (pid ${existing.pid}) was not running; cleared stale state.\n`,
      exitCode: 0,
    };
  }
  deps.terminate(existing.pid);
  const deadline = deps.now() + STOP_TIMEOUT_MS;
  while (deps.now() < deadline) {
    if (!deps.pidAlive(existing.pid)) {
      removeControlState(projectRoot);
      return {
        output: `Mission Control plane stopped (pid ${existing.pid}).\n`,
        exitCode: 0,
      };
    }
    await deps.sleep(STOP_INTERVAL_MS);
  }
  return {
    output:
      `Control plane (pid ${existing.pid}) did not exit within ${STOP_TIMEOUT_MS}ms after SIGTERM. ` +
      'Kill it manually, then run `folderforge control stop` again to clear state.\n',
    exitCode: 1,
  };
}

async function controlStatus(
  options: ControlOptions,
  deps: ControlDeps,
): Promise<ControlCliResult> {
  const { projectRoot } = options;
  const existing = readControlState(projectRoot);
  if (!existing) {
    return {
      output: options.json
        ? `${JSON.stringify({ running: false, projectRoot })}\n`
        : 'Mission Control plane is not running.\n',
      exitCode: 0,
    };
  }
  const pidAlive = deps.pidAlive(existing.pid);
  const endpointOk = pidAlive
    ? await deps.probe(existing.port, '/status', 1_000)
    : false;
  if (!pidAlive) removeControlState(projectRoot);
  const url = `http://127.0.0.1:${existing.port}/app`;
  if (options.json) {
    return {
      output: `${JSON.stringify({
        running: pidAlive && endpointOk,
        pid: existing.pid,
        port: existing.port,
        projectRoot: existing.projectRoot,
        startedAt: existing.startedAt,
        version: existing.version,
        pidAlive,
        endpointOk,
        url,
      })}\n`,
      exitCode: 0,
    };
  }
  if (!pidAlive) {
    return {
      output: `Control plane (pid ${existing.pid}) is not running; cleared stale state.\n`,
      exitCode: 0,
    };
  }
  return {
    output:
      `Mission Control plane (pid ${existing.pid}) is ${
        endpointOk ? 'running' : 'alive but NOT answering'
      }.\n` +
      `${url}\n` +
      `Started: ${existing.startedAt} (version ${existing.version})\n`,
    exitCode: 0,
  };
}

async function controlOpen(
  options: ControlOptions,
  deps: ControlDeps,
): Promise<ControlCliResult> {
  const { projectRoot } = options;
  const existing = readControlState(projectRoot);
  if (
    existing &&
    deps.pidAlive(existing.pid) &&
    (await deps.probe(existing.port, '/status', 1_000))
  ) {
    const url = `http://127.0.0.1:${existing.port}/app`;
    deps.openUrl(url);
    return { output: `${url}\n`, exitCode: 0 };
  }
  return {
    output:
      'Mission Control plane is not running. Start it with `folderforge control start`.\n',
    exitCode: 1,
  };
}

/**
 * Hidden foreground entrypoint used by the detached child. Boots the dashboard
 * exactly like the MCP server does, but never starts an MCP transport, so a
 * detached stdin cannot wedge the process. Loopback-only by design: remote
 * exposure belongs to a full `folderforge --http` deployment with credentials.
 */
async function controlServe(
  options: ControlOptions,
  deps: ControlDeps,
): Promise<ControlCliResult> {
  const config = loadConfig({ projectRoot: options.projectRoot });
  if (options.allow && options.allow.length > 0) {
    // Extra governable directories passed by the operator at start time.
    const extra = options.allow.map((dir) => resolve(options.projectRoot, dir));
    config.workspace.allowedDirectories = [
      ...(config.workspace.allowedDirectories ?? []),
      ...extra,
    ];
  }
  config.server.dashboard.enabled = true;
  config.server.dashboard.host = '127.0.0.1';
  if (options.port !== undefined) config.server.dashboard.port = options.port;
  applyHttpAuthDefaults(config);
  validateConfig(config);

  const container = new Container(config);
  const registry = buildRegistry(container);
  container.audit.record({
    type: 'server_start',
    summary: 'transport=control-plane dashboard-only',
    detail: { version: deps.version, projectRoot: container.projectRoot() },
  });

  const server = startDashboard(container, registry, {
    host: config.server.dashboard.host,
    port: config.server.dashboard.port,
  });
  if (!server.listening) {
    await new Promise<void>((resolvePromise, reject) => {
      server.once('listening', () => resolvePromise());
      server.once('error', reject);
    });
  }
  const address = server.address();
  const boundPort =
    typeof address === 'object' && address !== null
      ? address.port
      : config.server.dashboard.port;
  process.stdout.write(`CONTROL_READY http://127.0.0.1:${boundPort}/app\n`);
  logger.info(
    { port: boundPort, projectRoot: container.projectRoot() },
    'Mission Control plane serving',
  );

  await new Promise<void>((resolvePromise) => {
    let shuttingDown = false;
    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'Shutting down Mission Control plane');
      server.close(() => {
        void Promise.allSettled([
          container.adapters.stopAllAndWait(1_500),
          container.browserEmulation.close(),
        ]).then(() => resolvePromise());
      });
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });
  return { output: '', exitCode: 0 };
}

export async function executeControlCli(
  argv: string[],
  overrides: Partial<ControlDeps> = {},
): Promise<ControlCliResult> {
  const platform = overrides.platform ?? process.platform;
  const deps: ControlDeps = {
    mainJs: fileURLToPath(new URL('../main.js', import.meta.url)),
    version: readFolderForgeVersion(),
    now: () => Date.now(),
    sleep: (ms) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
    pidAlive: defaultPidAlive,
    probe: defaultProbe,
    spawnServe: defaultSpawnServe,
    terminate: defaultTerminate,
    openUrl: (url) => defaultOpenUrl(url, platform),
    stdoutIsTty: Boolean(process.stdout.isTTY),
    platform,
    ...overrides,
  };

  let options: ControlOptions;
  try {
    options = parseControlArgs(argv);
  } catch (err) {
    return {
      output: `${(err as Error).message}\n\n${controlHelp()}`,
      exitCode: 2,
    };
  }
  if (options.help) return { output: controlHelp(), exitCode: 0 };
  if (options.command === null) {
    return { output: controlHelp(), exitCode: 2 };
  }
  switch (options.command) {
    case 'start':
      return controlStart(options, deps);
    case 'stop':
      return controlStop(options, deps);
    case 'status':
      return controlStatus(options, deps);
    case 'open':
      return controlOpen(options, deps);
    case 'serve':
      return controlServe(options, deps);
    default:
      return {
        output: `Unknown control command: ${options.command}\n\n${controlHelp()}`,
        exitCode: 2,
      };
  }
}
