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
 * State lives in <projectRoot>/.folderforge/control.json (no secrets). Optional
 * dashboard auth (`--auth token|api-key`, changeable via `control auth`) keeps
 * its credential separately in control-auth.json (0600); the printed/opened SPA
 * link then carries `?token=` so the browser session is signed in immediately.
 * `--openai-tunnel` additionally supervises the OpenAI Secure MCP Tunnel for
 * ChatGPT (tunnel id + API-key env var name) as an alternative to Cloudflare.
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

import { ENV_NAME_PATTERN, TUNNEL_ID_PATTERN } from '../chatgpt/openai-tunnel.js';
import { startDashboard } from '../dashboard/server.js';
import { logger } from '../core/logger.js';
import { readFolderForgeVersion } from '../core/version.js';
import { Container } from '../runtime/container.js';
import { stopManagedProcessTrees } from '../runtime/shutdown.js';
import {
  applyHttpAuthDefaults,
  loadConfig,
  validateConfig,
} from '../runtime/config.js';
import { buildRegistry } from '../tools/index.js';
import {
  CONTROL_AUTH_MODES,
  clearControlAuth,
  controlAuthPath,
  generateControlCredential,
  loadControlAuth,
  maskedControlAuth,
  saveControlAuth,
  type ControlAuthMode,
} from './auth-store.js';
import {
  loadOpenAiTunnelConfig,
  setOpenAiTunnelSupervisorPid,
  upsertOpenAiTunnelConfig,
} from './openai-tunnel-store.js';

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
  /** Detached watchdog pid (from --watchdog); killed before the plane on stop. */
  watchdogPid?: number;
  /** Dashboard auth mode; the credential itself lives in control-auth.json (0600). */
  auth?: { mode: ControlAuthMode };
  /** Detached OpenAI Secure MCP Tunnel supervisor (from --openai-tunnel). */
  openaiTunnel?: { pid: number; tunnelId: string; apiKeyEnv: string };
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
  /** Spawn a detached child; returns its pid. env is merged over process.env. */
  spawnServe: (args: string[], logPath: string, env?: Record<string, string>) => number;
  /** Send SIGTERM to a child process. */
  terminate: (pid: number) => void;
  /** Open a URL in the default browser (best-effort). */
  openUrl: (url: string) => void;
  /** Read an environment variable (e.g. the OpenAI API key for --openai-tunnel). */
  getEnv?: (name: string) => string | undefined;
  stdoutIsTty: boolean;
  platform: NodeJS.Platform;
}

const DEFAULT_CONTROL_PORT = 7332;
const DEFAULT_OPENAI_API_KEY_ENV = 'CONTROL_PLANE_API_KEY';
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

function defaultSpawnServe(args: string[], logPath: string, env?: Record<string, string>): number {
  const out = openSync(logPath, 'a');
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', out, out],
      ...(env ? { env: { ...process.env, ...env } } : {}),
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

function controlTunnelLogPath(projectRoot: string): string {
  return join(projectRoot, '.folderforge', 'control-openai-tunnel.log');
}

/** SPA link that carries the credential, signing the browser session in at once. */
function dynamicAppUrl(port: number, credential?: string): string {
  const base = `http://127.0.0.1:${port}/app`;
  return credential ? `${base}?token=${encodeURIComponent(credential)}` : base;
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
  /** Second positional, e.g. the mode in `control auth <mode>`. */
  commandArg: string | null;
  projectRoot: string;
  port?: number;
  open?: boolean;
  allow?: string[];
  watchdog?: boolean;
  auth?: ControlAuthMode;
  openaiTunnel?: boolean;
  tunnelId?: string;
  apiKeyEnv?: string;
  json: boolean;
  help: boolean;
}

function parseControlArgs(argv: string[]): ControlOptions {
  const positionals: string[] = [];
  let projectRoot: string | undefined;
  let port: number | undefined;
  let open: boolean | undefined;
  let allow: string[] | undefined;
  let watchdog = false;
  let auth: ControlAuthMode | undefined;
  let openaiTunnel = false;
  let tunnelId: string | undefined;
  let apiKeyEnv: string | undefined;
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
      case '--watchdog':
        watchdog = true;
        break;
      case '--auth': {
        const v = argv[++i];
        if (v === undefined || !(CONTROL_AUTH_MODES as readonly string[]).includes(v)) {
          throw new Error(`--auth must be one of: ${CONTROL_AUTH_MODES.join(', ')}`);
        }
        auth = v as ControlAuthMode;
        break;
      }
      case '--openai-tunnel':
        openaiTunnel = true;
        break;
      case '--tunnel-id': {
        const v = argv[++i];
        if (v === undefined) throw new Error('--tunnel-id requires a value');
        if (!TUNNEL_ID_PATTERN.test(v)) {
          throw new Error('--tunnel-id must match tunnel_<32 lowercase hex>');
        }
        tunnelId = v;
        break;
      }
      case '--api-key-env': {
        const v = argv[++i];
        if (v === undefined) throw new Error('--api-key-env requires a variable name');
        if (!ENV_NAME_PATTERN.test(v)) throw new Error(`Invalid --api-key-env name: ${v}`);
        apiKeyEnv = v;
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
        positionals.push(a);
    }
  }
  const [command = null, commandArg = null, ...extraPositionals] = positionals;
  if (extraPositionals.length > 0) {
    throw new Error(`Unexpected argument: ${extraPositionals[0]}`);
  }
  if (commandArg !== null && command !== 'auth') {
    throw new Error(`Unexpected argument: ${commandArg}`);
  }
  if (!openaiTunnel && (tunnelId !== undefined || apiKeyEnv !== undefined)) {
    throw new Error('--tunnel-id and --api-key-env require --openai-tunnel');
  }
  const result: ControlOptions = {
    command,
    commandArg,
    projectRoot: resolve(projectRoot ?? process.cwd()),
    json,
    help,
  };
  if (port !== undefined) result.port = port;
  if (open !== undefined) result.open = open;
  if (allow !== undefined) result.allow = allow;
  if (watchdog) result.watchdog = true;
  if (auth !== undefined) result.auth = auth;
  if (openaiTunnel) result.openaiTunnel = true;
  if (tunnelId !== undefined) result.tunnelId = tunnelId;
  if (apiKeyEnv !== undefined) result.apiKeyEnv = apiKeyEnv;
  return result;
}

export function controlHelp(): string {
  return [
    'FolderForge Mission Control plane',
    '',
    'Usage: folderforge control <start|stop|status|open|auth> [options]',
    '',
    'Commands:',
    '  start      Start the local control plane in the background and open the SPA',
    '  stop       Stop the background control plane (and the ChatGPT tunnel) gracefully',
    '  status     Show control plane state and probe its endpoint',
    '  open       Open the Mission Control SPA in the default browser',
    '  auth       Show or change dashboard auth: control auth [none|token|api-key]',
    '',
    'Options:',
    '  -p, --project <dir>  Project the control plane governs (default: cwd)',
    '      --port <n>       Dashboard port (default 7332)',
    '      --allow <dir>    Extra directory the plane may govern (repeatable)',
    '      --watchdog       Auto-restart the plane if it stops answering',
    '      --auth <mode>    Dashboard auth: none|token|api-key (default none; persisted).',
    '                       token/api-key mint a credential (0600 file) and print a',
    '                       signed dynamic link (…/app?token=…)',
    '      --openai-tunnel  Also supervise the OpenAI Secure MCP Tunnel for ChatGPT',
    '                       (tunnel id + API-key env var; no Cloudflare involved)',
    '      --tunnel-id <id> OpenAI tunnel id (tunnel_<32 hex>) for --openai-tunnel',
    '      --api-key-env <n> Env var holding the OpenAI control-plane API key',
    '                       (default CONTROL_PLANE_API_KEY; only the name is persisted)',
    '      --open/--no-open Open the SPA after start (default: open on a TTY)',
    '      --json           Machine-readable output for status',
    '  -h, --help           Show this help',
    '',
    'Examples:',
    '  folderforge control start --auth token',
    '  folderforge control auth api-key            # change later; restarts the plane',
    "  export CONTROL_PLANE_API_KEY='sk-...'",
    '  folderforge control start --openai-tunnel --tunnel-id tunnel_<32 hex>',
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
      const auth = loadControlAuth(projectRoot);
      return {
        output:
          `Mission Control is already running (pid ${existing.pid}).\n` +
          `${dynamicAppUrl(existing.port, auth?.credential)}\n` +
          (options.auth !== undefined || options.openaiTunnel
            ? 'To change auth use `folderforge control auth <mode>`; to reconfigure the tunnel run `control stop` then `control start` with the new flags.\n'
            : ''),
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

  // Auth config: apply --auth, otherwise keep the stored credential (default
  // none). The credential never enters argv or control.json — the serve child
  // reads the 0600 file itself at boot.
  const storedAuth = loadControlAuth(projectRoot);
  const authMode: ControlAuthMode = options.auth ?? storedAuth?.mode ?? 'none';
  let credential: string | undefined;
  if (authMode === 'none') {
    clearControlAuth(projectRoot);
  } else if (storedAuth && storedAuth.mode === authMode) {
    credential = storedAuth.credential; // stable across restarts
  } else {
    credential = generateControlCredential();
    saveControlAuth(projectRoot, {
      mode: authMode,
      credential,
      createdAt: new Date(deps.now()).toISOString(),
    });
  }

  // ChatGPT tunnel config: validate before spawning anything so a bad config
  // fails fast and leaves nothing running. Falls back to the config saved in
  // Mission Control (Tunnels → ChatGPT tunnel card).
  const getEnv = deps.getEnv ?? ((name: string) => process.env[name]);
  let tunnelId: string | undefined;
  let apiKeyEnv: string | undefined;
  let tunnelApiKey: string | undefined;
  if (options.openaiTunnel) {
    const storedTunnel = loadOpenAiTunnelConfig(projectRoot);
    tunnelId = options.tunnelId ?? existing?.openaiTunnel?.tunnelId ?? storedTunnel?.tunnelId;
    if (!tunnelId) {
      return {
        output:
          '--openai-tunnel requires --tunnel-id tunnel_<32 hex> on the first run ' +
          '(or save it in Mission Control → Tunnels → ChatGPT tunnel).\n',
        exitCode: 1,
      };
    }
    apiKeyEnv =
      options.apiKeyEnv ??
      existing?.openaiTunnel?.apiKeyEnv ??
      storedTunnel?.apiKeyEnv ??
      DEFAULT_OPENAI_API_KEY_ENV;
    // A key pasted in Mission Control (0600 store) satisfies the check when
    // the env var itself was not exported.
    tunnelApiKey = storedTunnel?.apiKey;
    if (!getEnv(apiKeyEnv) && !tunnelApiKey) {
      return {
        output:
          `Environment variable ${apiKeyEnv} is not set and no key is saved. Export the ` +
          `OpenAI control-plane API key first:\n  export ${apiKeyEnv}='sk-...'\n` +
          'or paste the key in Mission Control → Tunnels → ChatGPT tunnel (stored 0600).\n',
        exitCode: 1,
      };
    }
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

  const state: ControlState = {
    schemaVersion: 1,
    pid,
    port,
    projectRoot,
    startedAt: new Date(deps.now()).toISOString(),
    version: deps.version,
    ...(options.allow && options.allow.length > 0 ? { allow: options.allow } : {}),
    ...(authMode !== 'none' ? { auth: { mode: authMode } } : {}),
  };
  if (options.watchdog) {
    try {
      state.watchdogPid = deps.spawnServe(
        [deps.mainJs, 'control', 'watch', '--project', projectRoot, '--port', String(port)],
        logPath,
      );
    } catch {
      // Best-effort: the plane itself is already healthy without a watchdog.
    }
  }
  let tunnelSpawnFailed = false;
  if (options.openaiTunnel && tunnelId && apiKeyEnv) {
    try {
      // The supervisor boots its own loopback MCP server + OpenAI tunnel
      // client; --no-dashboard avoids clashing with this plane's dashboard port.
      const tunnelPid = deps.spawnServe(
        [
          deps.mainJs,
          'connect',
          'chatgpt',
          '--openai-tunnel',
          '--project',
          projectRoot,
          '--no-dashboard',
          '--tunnel-id',
          tunnelId,
          '--api-key-env',
          apiKeyEnv,
        ],
        controlTunnelLogPath(projectRoot),
        // Inject the app-saved key only when the env var itself is absent.
        tunnelApiKey && !getEnv(apiKeyEnv) ? { [apiKeyEnv]: tunnelApiKey } : undefined,
      );
      state.openaiTunnel = { pid: tunnelPid, tunnelId, apiKeyEnv };
      // Share with Mission Control: config + running pid visible in the app.
      upsertOpenAiTunnelConfig(projectRoot, { tunnelId, apiKeyEnv });
      setOpenAiTunnelSupervisorPid(projectRoot, tunnelPid);
    } catch {
      tunnelSpawnFailed = true; // The plane itself is healthy; reported below.
    }
  }
  writeControlState(projectRoot, state);

  const url = dynamicAppUrl(port, credential);
  if (options.open ?? deps.stdoutIsTty) deps.openUrl(url);
  return {
    output:
      `Mission Control plane started (pid ${pid}, project ${projectRoot}).\n` +
      `${url}\n` +
      (authMode !== 'none'
        ? `Auth: ${authMode} — credential stored in ${controlAuthPath(projectRoot)} (0600); the signed link is printed here and by \`control open\`.\n`
        : '') +
      `Logs: ${logPath}\n` +
      (state.watchdogPid
        ? `Watchdog: pid ${state.watchdogPid} — restarts the plane automatically if it stops answering.\n`
        : '') +
      (state.openaiTunnel
        ? `ChatGPT tunnel: ${state.openaiTunnel.tunnelId} supervised (pid ${state.openaiTunnel.pid}, key from $${state.openaiTunnel.apiKeyEnv}) — no Cloudflare. Logs: ${controlTunnelLogPath(projectRoot)}\n`
        : '') +
      (tunnelSpawnFailed
        ? 'ChatGPT tunnel failed to spawn; the plane is running without it.\n'
        : ''),
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
  // Kill the watchdog FIRST, before the plane: otherwise it observes the
  // plane going down and restarts it mid-stop.
  if (existing.watchdogPid && deps.pidAlive(existing.watchdogPid)) {
    try {
      deps.terminate(existing.watchdogPid);
    } catch {
      // Best-effort; the plane stop below still proceeds.
    }
  }
  // Stop the ChatGPT tunnel supervisor too; it owns its own MCP child process.
  if (existing.openaiTunnel && deps.pidAlive(existing.openaiTunnel.pid)) {
    try {
      deps.terminate(existing.openaiTunnel.pid);
    } catch {
      // Best-effort; the plane stop below still proceeds.
    }
  }
  // Also stop an app-started tunnel supervisor recorded in the shared store
  // (Mission Control → Tunnels → ChatGPT tunnel).
  const storedTunnel = loadOpenAiTunnelConfig(projectRoot);
  if (
    storedTunnel?.supervisorPid &&
    storedTunnel.supervisorPid !== existing.openaiTunnel?.pid &&
    deps.pidAlive(storedTunnel.supervisorPid)
  ) {
    try {
      deps.terminate(storedTunnel.supervisorPid);
    } catch {
      // Best-effort; the plane stop below still proceeds.
    }
  }
  if (storedTunnel?.supervisorPid) setOpenAiTunnelSupervisorPid(projectRoot, undefined);
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

const WATCH_INTERVAL_MS = 15_000;
const WATCH_MAX_FAILURES = 3;

/**
 * Detached watchdog loop (spawned by `control start --watchdog`). Probes the
 * plane's /status endpoint; after WATCH_MAX_FAILURES consecutive failures it
 * restarts the serve child with the same args recorded in control.json. Exits
 * when the state file disappears (a deliberate `control stop`).
 */
async function controlWatch(
  options: ControlOptions,
  deps: ControlDeps,
): Promise<ControlCliResult> {
  const { projectRoot } = options;
  let failures = 0;
  let restarts = 0;
  for (;;) {
    await deps.sleep(WATCH_INTERVAL_MS);
    const state = readControlState(projectRoot);
    if (!state) break;
    const ok = await deps.probe(state.port, '/status', 4_000);
    if (ok) {
      failures = 0;
      continue;
    }
    failures += 1;
    if (failures < WATCH_MAX_FAILURES) continue;
    if (deps.pidAlive(state.pid)) {
      try {
        deps.terminate(state.pid);
      } catch {
        // The pid may have raced away; the respawn below still happens.
      }
    }
    const serveArgs = [
      deps.mainJs,
      'control',
      'serve',
      '--project',
      state.projectRoot,
      '--port',
      String(state.port),
      ...(state.allow ?? []).flatMap((dir) => ['--allow', dir]),
    ];
    try {
      state.pid = deps.spawnServe(serveArgs, controlLogPath(projectRoot));
      state.startedAt = new Date(deps.now()).toISOString();
      writeControlState(projectRoot, state);
      restarts += 1;
    } catch {
      // Keep watching; the next cycle retries the respawn.
    }
    failures = 0;
  }
  return {
    output: `watchdog stopped (plane state removed); restarts performed: ${restarts}\n`,
    exitCode: 0,
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
  const auth = loadControlAuth(projectRoot);
  const url = dynamicAppUrl(existing.port, auth?.credential);
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
        url: `http://127.0.0.1:${existing.port}/app`,
        auth: { mode: existing.auth?.mode ?? 'none', ...maskedControlAuth(projectRoot) },
        ...(existing.openaiTunnel
          ? {
              openaiTunnel: {
                ...existing.openaiTunnel,
                alive: deps.pidAlive(existing.openaiTunnel.pid),
              },
            }
          : {}),
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
      `Started: ${existing.startedAt} (version ${existing.version})\n` +
      `Auth: ${existing.auth?.mode ?? 'none'}\n` +
      (existing.openaiTunnel
        ? `ChatGPT tunnel: ${existing.openaiTunnel.tunnelId} — ${
            deps.pidAlive(existing.openaiTunnel.pid) ? 'running' : 'NOT running'
          } (pid ${existing.openaiTunnel.pid}, key from $${existing.openaiTunnel.apiKeyEnv})\n`
        : ''),
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
    const url = dynamicAppUrl(
      existing.port,
      loadControlAuth(projectRoot)?.credential,
    );
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
 * `control auth [none|token|api-key]` — show or change the dashboard auth mode.
 * Auth is applied by the serve child at boot, so a running plane is restarted
 * in place (watchdog first, mirroring `control stop`) to pick up the change.
 * The credential is stable when the mode is unchanged, freshly minted on a mode
 * switch, and removed entirely for `none`.
 */
async function controlAuthMode(
  options: ControlOptions,
  deps: ControlDeps,
): Promise<ControlCliResult> {
  const { projectRoot } = options;
  const modeArg = options.commandArg;
  const state = readControlState(projectRoot);
  const stored = loadControlAuth(projectRoot);

  if (modeArg === null) {
    const masked = maskedControlAuth(projectRoot);
    return {
      output:
        `Dashboard auth: ${stored?.mode ?? state?.auth?.mode ?? 'none'}\n` +
        (masked.configured && masked.credentialPreview
          ? `Credential: ${masked.credentialPreview} (created ${masked.createdAt})\n`
          : '') +
        'Change with: folderforge control auth <none|token|api-key>\n',
      exitCode: 0,
    };
  }
  if (!(CONTROL_AUTH_MODES as readonly string[]).includes(modeArg)) {
    return {
      output: `Unknown auth mode: ${modeArg}. Use one of: ${CONTROL_AUTH_MODES.join(', ')}.\n`,
      exitCode: 2,
    };
  }
  const mode = modeArg as ControlAuthMode;

  let credential: string | undefined;
  if (mode === 'none') {
    clearControlAuth(projectRoot);
  } else if (stored && stored.mode === mode) {
    credential = stored.credential;
  } else {
    credential = generateControlCredential();
    saveControlAuth(projectRoot, {
      mode,
      credential,
      createdAt: new Date(deps.now()).toISOString(),
    });
  }

  if (!state || !deps.pidAlive(state.pid)) {
    return {
      output:
        `Dashboard auth set to ${mode}; no plane is running, so it applies on the next \`control start\`.\n` +
        (credential
          ? `Signed link after start: ${dynamicAppUrl(state?.port ?? DEFAULT_CONTROL_PORT, credential)}\n`
          : ''),
      exitCode: 0,
    };
  }

  // Kill the watchdog first so it cannot respawn the old plane mid-restart.
  let watchdogPid = state.watchdogPid;
  if (watchdogPid && deps.pidAlive(watchdogPid)) {
    try {
      deps.terminate(watchdogPid);
    } catch {
      // Best-effort; the plane restart below still proceeds.
    }
  }
  try {
    deps.terminate(state.pid);
  } catch {
    // Already exiting; the respawn below still happens.
  }
  const stopDeadline = deps.now() + STOP_TIMEOUT_MS;
  while (deps.now() < stopDeadline && deps.pidAlive(state.pid)) {
    await deps.sleep(STOP_INTERVAL_MS);
  }
  const serveArgs = [
    deps.mainJs,
    'control',
    'serve',
    '--project',
    state.projectRoot,
    '--port',
    String(state.port),
    ...(state.allow ?? []).flatMap((dir) => ['--allow', dir]),
  ];
  let pid: number;
  try {
    pid = deps.spawnServe(serveArgs, controlLogPath(projectRoot));
  } catch (err) {
    return {
      output: `Auth changed to ${mode} but the plane failed to restart: ${String(err)}\n`,
      exitCode: 1,
    };
  }
  const readyDeadline = deps.now() + READY_TIMEOUT_MS;
  let ready = false;
  while (deps.now() < readyDeadline) {
    if (!deps.pidAlive(pid)) break;
    if (await deps.probe(state.port, '/status', 1_000)) {
      ready = true;
      break;
    }
    await deps.sleep(READY_INTERVAL_MS);
  }
  if (!ready) {
    return {
      output:
        `Auth changed to ${mode} but the plane did not become ready on port ${state.port}. ` +
        `Check ${controlLogPath(projectRoot)}\n`,
      exitCode: 1,
    };
  }
  if (watchdogPid) {
    try {
      watchdogPid = deps.spawnServe(
        [
          deps.mainJs,
          'control',
          'watch',
          '--project',
          state.projectRoot,
          '--port',
          String(state.port),
        ],
        controlLogPath(projectRoot),
      );
    } catch {
      watchdogPid = undefined;
    }
  }
  const next: ControlState = {
    ...state,
    pid,
    startedAt: new Date(deps.now()).toISOString(),
    version: deps.version,
  };
  if (mode === 'none') delete next.auth;
  else next.auth = { mode };
  if (watchdogPid) next.watchdogPid = watchdogPid;
  else delete next.watchdogPid;
  writeControlState(projectRoot, next);
  return {
    output:
      `Dashboard auth changed to ${mode}; plane restarted (pid ${pid}).\n` +
      `${dynamicAppUrl(state.port, credential)}\n`,
    exitCode: 0,
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

  // Optional dashboard auth: a credential file means the operator configured
  // token/api-key auth (`--auth` or `control auth`). It is read here, inside
  // the child, so the secret never appears in process argv.
  const dashboardAuth = loadControlAuth(options.projectRoot);

  const container = new Container(config);
  const registry = buildRegistry(container);
  container.audit.record({
    type: 'server_start',
    summary: 'transport=control-plane dashboard-only',
    detail: {
      version: deps.version,
      projectRoot: container.projectRoot(),
      ...(dashboardAuth ? { authMode: dashboardAuth.mode } : {}),
    },
  });

  const server = startDashboard(container, registry, {
    host: config.server.dashboard.host,
    port: config.server.dashboard.port,
    ...(dashboardAuth ? { token: dashboardAuth.credential, requireAuth: true } : {}),
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
          stopManagedProcessTrees(container, 1_500),
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
    case 'auth':
      return controlAuthMode(options, deps);
    case 'serve':
      return controlServe(options, deps);
    case 'watch':
      return controlWatch(options, deps);
    default:
      return {
        output: `Unknown control command: ${options.command}\n\n${controlHelp()}`,
        exitCode: 2,
      };
  }
}
