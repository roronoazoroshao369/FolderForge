/**
 * `folderforge share` — one-command temporary trial environment (modeled on
 * `webcodex share`): a single command stands up a temporary single-project
 * environment for the current folder and prints ready-to-paste connection
 * values, without touching long-lived configuration.
 *
 *   folderforge share                              # auto tunnel (cloudflare when available)
 *   folderforge share --tunnel none                # loopback only
 *   folderforge share --tunnel openai              # OpenAI Secure MCP Tunnel supervisor
 *   folderforge share --tunnel cloudflare --named trial-mcp.example.com  # stable named tunnel
 *   folderforge share --auth token|oauth           # token is the self-contained default
 *   folderforge share --ttl 30                     # auto-teardown after 30 minutes (default 120)
 *   folderforge share --json                       # machine-readable ready/ended events
 *
 * Lifecycle contract: whatever share starts dies with the command. SIGINT/
 * SIGTERM (or the --ttl deadline) tears down the tunnel (if any), closes the
 * loopback MCP server, and stops any managed process trees; the temporary
 * bearer credential lives only in the share process memory and is never
 * written to disk, argv, or logs. Sessions are recorded in the audit log as
 * `share_session` start/stop events (tunnel/auth/preset/port, stop reason,
 * duration) when share owns the server.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENV_NAME_PATTERN, TUNNEL_ID_PATTERN } from '../chatgpt/openai-tunnel.js';
import { loadCloudflareConfig } from '../cloudflare/config-store.js';
import { makeCloudflareClient } from '../cloudflare/api-client.js';
import { terminateChildProcessTree } from '../core/process-tree.js';
import { readFolderForgeVersion } from '../core/version.js';
import {
  loadOpenAiTunnelConfig,
  type OpenAiTunnelConfig,
} from '../control/openai-tunnel-store.js';
import { ProcessManager } from '../managers/process-manager.js';
import { Container } from '../runtime/container.js';
import { loadConfig } from '../runtime/config.js';
import { stopManagedProcessTrees } from '../runtime/shutdown.js';
import { createMcpServer } from '../server/mcp-server.js';
import { startHttpTransport } from '../server/transports/http.js';
import { buildRegistry, resolveActiveTools } from '../tools/index.js';
import { TunnelManager } from '../tunnels/tunnel-manager.js';

export interface ShareCliResult {
  output: string;
  exitCode: number;
}

export type ShareTunnelMode = 'openai' | 'cloudflare' | 'none';
export type ShareAuthMode = 'token' | 'oauth';
export type ShareStopReason = 'signal' | 'ttl-expired';

export interface ShareOpenAiSupervisorInput {
  projectRoot: string;
  tunnelId: string;
  apiKeyEnv: string;
  /** Stored (0600) key value — injected via the child env only when the env var is absent. */
  apiKey?: string;
}

export interface ShareServerHandle {
  port: number;
  close: () => Promise<void>;
  /** Optional audit sink for `share_session` start/stop events. */
  auditRecord?: (event: { type: 'share_session'; summary: string }) => void;
}

export interface ShareDeps {
  /** Entrypoint of the built runtime (dist/main.js), for the OpenAI supervisor child. */
  mainJs: string;
  version: string;
  now: () => number;
  getEnv: (name: string) => string | undefined;
  loadTunnelConfig: (projectRoot: string) => OpenAiTunnelConfig | null;
  /** True when a `cloudflared` binary is resolvable on PATH. */
  hasCloudflared: () => boolean;
  /** True when the project config already carries OAuth resource-server settings. */
  hasOAuthConfig: (projectRoot: string) => boolean;
  /** Start the loopback MCP HTTP server; resolves with the bound port + close. */
  startServer: (input: {
    projectRoot: string;
    token: string;
    auth: ShareAuthMode;
    toolsPreset?: string;
  }) => Promise<ShareServerHandle>;
  /** Start a Cloudflare tunnel (quick by default, named when `named` is set); resolves with the public URL + stop. */
  startCloudflareTunnel: (input: {
    targetPort: number;
    projectRoot: string;
    /** Named tunnel hostname — stable across restarts; needs a linked Cloudflare account. */
    named?: string;
  }) => Promise<{ publicUrl: string; stop: () => Promise<void> }>;
  /** Spawn the OpenAI tunnel supervisor as a managed foreground child. */
  spawnOpenAiSupervisor: (input: ShareOpenAiSupervisorInput) => {
    pid?: number;
    stop: () => void;
  };
  /** Resolves when the operator stops the session (SIGINT/SIGTERM). */
  waitForStop: () => Promise<void>;
  /** Stream output live (share is a long-running foreground command). */
  write: (text: string) => void;
}

interface ShareOptions {
  projectRoot: string;
  tunnel: ShareTunnelMode | null;
  auth: ShareAuthMode;
  tunnelId?: string;
  /** Stable named-tunnel hostname for --tunnel cloudflare. */
  named?: string;
  toolsPreset?: string;
  ttlMinutes: number;
  json: boolean;
  help: boolean;
}

const DEFAULT_OPENAI_API_KEY_ENV = 'CONTROL_PLANE_API_KEY';
const DEFAULT_TOOLS_PRESET = 'vibe';
/** Trial sessions are time-boxed by default; --ttl 0 disables the limit. */
const DEFAULT_TTL_MINUTES = 120;
const CHATGPT_CONNECTORS_URL = 'https://chatgpt.com/#settings/Connectors';

export function shareHelp(): string {
  return [
    'FolderForge share — one-command temporary trial environment',
    '',
    'Usage: folderforge share [options]',
    '',
    'Options:',
    '  --tunnel <mode>    openai | cloudflare | none (default: cloudflare when the binary exists, else none)',
    '  --named <host>     With --tunnel cloudflare: stable named tunnel on this hostname (linked Cloudflare account)',
    '  --auth <mode>      token | oauth (default: token; oauth reuses the project\'s OAuth configuration)',
    '  --tunnel-id <id>   tunnel_<32 lowercase hex> for --tunnel openai (not persisted)',
    '  --tools-preset <i> Tool preset for the share server (default: vibe; adaptive gives a small core + gateway)',
    '  --ttl <minutes>    Auto-teardown after N minutes (default: 120; 0 disables)',
    '  --json             Print machine-readable share.ready/share.ended/share.error lines (share-owned output only)',
    '  -p, --project <d>  Project root to share (default: cwd)',
    '  -h, --help         Show this help',
    '',
    'The command prints the MCP URL, the temporary credential, and the tunnel id',
    '(when --tunnel openai). Ctrl+C or the TTL deadline tears everything down:',
    'the tunnel closes and the temporary credential is invalidated with the process.',
    '',
  ].join('\n');
}

function parseShareArgs(argv: string[]): ShareOptions {
  let projectRoot: string | undefined;
  let tunnel: ShareTunnelMode | null = null;
  let auth: ShareAuthMode = 'token';
  let tunnelId: string | undefined;
  let named: string | undefined;
  let toolsPreset: string | undefined;
  let ttlMinutes = DEFAULT_TTL_MINUTES;
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
      case '--tunnel': {
        const v = argv[++i];
        if (v !== 'openai' && v !== 'cloudflare' && v !== 'none') {
          throw new Error('--tunnel must be one of: openai, cloudflare, none');
        }
        tunnel = v;
        break;
      }
      case '--auth': {
        const v = argv[++i];
        if (v !== 'token' && v !== 'oauth') {
          throw new Error('--auth must be one of: token, oauth');
        }
        auth = v;
        break;
      }
      case '--tunnel-id': {
        const v = argv[++i];
        if (v === undefined) throw new Error('--tunnel-id requires a value');
        if (!TUNNEL_ID_PATTERN.test(v)) {
          throw new Error('--tunnel-id must match tunnel_<32 lowercase hex>');
        }
        tunnelId = v;
        break;
      }
      case '--named': {
        const v = argv[++i];
        if (v === undefined || !v.trim()) {
          throw new Error('--named requires a hostname (e.g. trial-mcp.example.com)');
        }
        named = v.trim();
        break;
      }
      case '--tools-preset': {
        const v = argv[++i];
        if (v === undefined || v.startsWith('-')) {
          throw new Error('--tools-preset requires a value');
        }
        toolsPreset = v;
        break;
      }
      case '--ttl': {
        const v = argv[++i];
        const minutes = v === undefined ? NaN : Number(v);
        if (!Number.isFinite(minutes) || minutes < 0) {
          throw new Error('--ttl requires a non-negative number of minutes (0 disables the limit)');
        }
        ttlMinutes = minutes;
        break;
      }
      case '--json':
        json = true;
        break;
      case '-h':
      case '--help':
        help = true;
        break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown share option: ${a}`);
        throw new Error(`Unexpected argument: ${a}`);
    }
  }
  if (tunnelId !== undefined && tunnel !== 'openai') {
    throw new Error('--tunnel-id requires --tunnel openai');
  }
  if (named !== undefined && tunnel !== null && tunnel !== 'cloudflare') {
    throw new Error('--named only applies to --tunnel cloudflare');
  }
  return {
    projectRoot: resolve(projectRoot ?? process.cwd()),
    tunnel,
    auth,
    ...(tunnelId !== undefined ? { tunnelId } : {}),
    ...(named !== undefined ? { named } : {}),
    ...(toolsPreset !== undefined ? { toolsPreset } : {}),
    ttlMinutes,
    json,
    help,
  };
}

/**
 * Wait for the operator stop signal or the TTL deadline, whichever comes
 * first. The TTL timer is unref'd and always cleared, so a signal-stopped
 * session never lingers on a pending timer.
 */
async function waitForStopOrTtl(
  waitForStop: () => Promise<void>,
  ttlMinutes: number,
): Promise<ShareStopReason> {
  if (ttlMinutes <= 0) {
    await waitForStop();
    return 'signal';
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      waitForStop().then((): ShareStopReason => 'signal'),
      new Promise<ShareStopReason>((resolveTtl) => {
        timer = setTimeout(() => resolveTtl('ttl-expired'), ttlMinutes * 60_000);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Default cloudflared probe: resolvable on PATH on any platform. */
function defaultHasCloudflared(): boolean {
  const probe = spawnSync('cloudflared', ['--version'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return probe.error === undefined;
}

/** Default OAuth pre-check: reuse the project's existing resource-server config. */
function defaultHasOAuthConfig(projectRoot: string): boolean {
  try {
    return Boolean(loadConfig({ projectRoot }).server.http.auth?.oauth);
  } catch {
    return false;
  }
}

/** Default server: loopback MCP HTTP on an ephemeral port with the temp token. */
async function defaultStartServer(
  input: { projectRoot: string; token: string; auth: ShareAuthMode; toolsPreset?: string },
  version: string,
): Promise<ShareServerHandle> {
  const config = loadConfig({ projectRoot: input.projectRoot });
  const container = new Container(config);
  const registry = buildRegistry(container);
  const active = resolveActiveTools(registry, {
    preset: input.toolsPreset ?? DEFAULT_TOOLS_PRESET,
  });
  if (active) registry.setActive(active);
  const server = await startHttpTransport(
    (principal) =>
      createMcpServer(registry, {
        name: config.server.name,
        version,
        roots: config.workspace.allowedDirectories,
        principal,
        container,
      }),
    {
      host: '127.0.0.1',
      port: 0, // ephemeral: the share session reports the real bound port
      authMode: input.auth === 'oauth' ? 'oauth' : 'token',
      ...(input.auth === 'oauth' && config.server.http.auth?.oauth
        ? { oauth: config.server.http.auth.oauth }
        : {}),
      ...(input.auth === 'token' ? { token: input.token } : {}),
      requireAuth: true,
    },
  );
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    close: async () => {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
      await stopManagedProcessTrees(container, 1_500);
    },
    auditRecord: (event) => {
      container.audit.record(event);
    },
  };
}

/**
 * Default Cloudflare tunnel through the shared Tunnel/Process managers: a
 * quick tunnel by default, or a stable named tunnel (hostname under the
 * linked account's zone) when `named` is set. Named-tunnel Cloudflare
 * resources persist so the hostname survives future sessions; teardown stops
 * the local cloudflared process.
 */
async function defaultStartCloudflareTunnel(input: {
  targetPort: number;
  projectRoot: string;
  named?: string;
}): Promise<{ publicUrl: string; stop: () => Promise<void> }> {
  const config = loadConfig({ projectRoot: input.projectRoot });
  const processes = new ProcessManager();
  const tunnels = new TunnelManager({
    spawn: (command, cwd) => processes.start(command, cwd, config.terminal.shell),
    stopSession: (sessionId) => processes.stop(sessionId),
    readSession: (sessionId) => processes.read(sessionId).output,
    onExit: (sessionId, listener) => processes.onExit(sessionId, listener),
    ...(input.named !== undefined
      ? {
          cloudflare: {
            loadConfig: () => loadCloudflareConfig(input.projectRoot),
            makeClient: (apiToken: string) => makeCloudflareClient(apiToken),
          },
        }
      : {}),
  });
  const record =
    input.named !== undefined
      ? await tunnels.startNamed({
          targetPort: input.targetPort,
          hostname: input.named,
          actor: 'share',
        })
      : await tunnels.start({ targetPort: input.targetPort, actor: 'share' });
  if (!record.publicUrl) {
    tunnels.stopAll();
    await processes.stopAllAndWait(1_500);
    throw new Error('cloudflared did not report a public URL.');
  }
  return {
    publicUrl: record.publicUrl,
    stop: async () => {
      tunnels.stopAll();
      await processes.stopAllAndWait(1_500);
    },
  };
}

/**
 * Default OpenAI supervisor: the proven `connect chatgpt --openai-tunnel`
 * flow as a managed foreground child (it mints its own per-run credential and
 * kills its own process tree on SIGTERM). A stored (0600) key is injected via
 * the child environment only, and only when the referenced env var is absent.
 */
function defaultSpawnOpenAiSupervisor(
  input: ShareOpenAiSupervisorInput,
  mainJs: string,
): { pid?: number; stop: () => void } {
  const child = spawn(
    process.execPath,
    [
      mainJs,
      'connect',
      'chatgpt',
      '--openai-tunnel',
      '--tunnel-id',
      input.tunnelId,
      '--api-key-env',
      input.apiKeyEnv,
      '--project',
      input.projectRoot,
      '--no-dashboard',
      '--no-open',
    ],
    {
      cwd: input.projectRoot,
      stdio: 'inherit',
      windowsHide: true,
      ...(input.apiKey ? { env: { ...process.env, [input.apiKeyEnv]: input.apiKey } } : {}),
    },
  );
  return {
    ...(child.pid !== undefined ? { pid: child.pid } : {}),
    stop: () => terminateChildProcessTree(child),
  };
}

/** Default stop signal: resolve on SIGINT/SIGTERM, exactly once. */
function defaultWaitForStop(): Promise<void> {
  return new Promise<void>((resolveStop) => {
    const onSignal = (): void => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      resolveStop();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}

export async function executeShareCli(
  argv: string[],
  overrides: Partial<ShareDeps> = {},
): Promise<ShareCliResult> {
  const version = overrides.version ?? readFolderForgeVersion();
  const mainJs =
    overrides.mainJs ?? fileURLToPath(new URL('../main.js', import.meta.url));
  const deps: ShareDeps = {
    mainJs,
    version,
    now: () => Date.now(),
    getEnv: (name) => process.env[name],
    loadTunnelConfig: loadOpenAiTunnelConfig,
    hasCloudflared: defaultHasCloudflared,
    hasOAuthConfig: defaultHasOAuthConfig,
    startServer: (input) => defaultStartServer(input, version),
    startCloudflareTunnel: defaultStartCloudflareTunnel,
    spawnOpenAiSupervisor: (input) => defaultSpawnOpenAiSupervisor(input, mainJs),
    waitForStop: defaultWaitForStop,
    write: (text) => process.stdout.write(text),
    ...overrides,
  };

  let transcript = '';
  const write = (text: string): void => {
    transcript += text;
    deps.write(text);
  };
  const done = (exitCode: number): ShareCliResult => ({ output: transcript, exitCode });

  let options: ShareOptions;
  try {
    options = parseShareArgs(argv);
  } catch (error) {
    // Parse errors stay human-readable: the consumer has not established a
    // working --json invocation yet.
    write(`${(error as Error).message}\n\n${shareHelp()}`);
    return done(2);
  }
  if (options.help) {
    write(shareHelp());
    return done(0);
  }

  /** Human lines are suppressed in --json mode; JSON events always stream. */
  const writeHuman = (text: string): void => {
    if (!options.json) write(text);
  };
  const emitEvent = (event: Record<string, unknown>): void => {
    if (options.json) write(`${JSON.stringify(event)}\n`);
  };
  const fail = (message: string, exitCode = 1): ShareCliResult => {
    if (options.json) {
      emitEvent({ type: 'share.error', message: message.replace(/\n+$/, '') });
    } else {
      write(message);
    }
    return done(exitCode);
  };
  const ttlLine =
    options.ttlMinutes > 0
      ? `TTL: ${options.ttlMinutes}m — the session tears itself down after the deadline (0 disables).`
      : 'TTL: disabled (--ttl 0) — the session runs until Ctrl+C.';

  const projectRoot = options.projectRoot;
  if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
    return fail(`Not a project folder: ${projectRoot}\n`);
  }

  // --- OpenAI tunnel mode: delegate to the proven supervisor flow. ----------
  if (options.tunnel === 'openai') {
    const stored = deps.loadTunnelConfig(projectRoot);
    const tunnelId = options.tunnelId ?? stored?.tunnelId;
    if (!tunnelId) {
      return fail(
        'share --tunnel openai needs a tunnel id: pass --tunnel-id tunnel_<32 hex>, ' +
          'or save one first (Mission Control → Tunnels → ChatGPT tunnel, or ' +
          '`folderforge connect chatgpt --openai-tunnel` once). Nothing was started.\n',
      );
    }
    const apiKeyEnv = stored?.apiKeyEnv ?? DEFAULT_OPENAI_API_KEY_ENV;
    if (!ENV_NAME_PATTERN.test(apiKeyEnv)) {
      return fail(`Invalid API-key environment variable name in the stored tunnel config: ${apiKeyEnv}\n`);
    }
    // The exported environment variable always wins; the 0600 stored key is the
    // fallback and is injected into the child environment only (never argv).
    const storedKey = deps.getEnv(apiKeyEnv) ? undefined : stored?.apiKey;
    if (!deps.getEnv(apiKeyEnv) && !storedKey) {
      return fail(
        `Environment variable ${apiKeyEnv} is not set and no key is saved at ` +
          '.folderforge/openai-tunnel-config.json (0600). Export the OpenAI ' +
          `control-plane API key first:\n  export ${apiKeyEnv}='sk-...'\n` +
          'or paste the key in Mission Control → Tunnels → ChatGPT tunnel. Nothing was started.\n',
      );
    }
    writeHuman(
      [
        `FolderForge share — temporary environment for ${projectRoot}`,
        `Tunnel: OpenAI Secure MCP Tunnel ${tunnelId}`,
        'The supervisor below prints the live connection values (it mints a fresh',
        'per-run local credential; ChatGPT uses Connection: Tunnel + no auth).',
        `ChatGPT connectors: ${CHATGPT_CONNECTORS_URL} — select or paste the tunnel ID above.`,
        ttlLine,
        'Press Ctrl+C to stop: the tunnel closes and the temporary credential dies with it.',
        '',
      ].join('\n'),
    );
    const supervisor = deps.spawnOpenAiSupervisor({
      projectRoot,
      tunnelId,
      apiKeyEnv,
      ...(storedKey ? { apiKey: storedKey } : {}),
    });
    emitEvent({
      type: 'share.ready',
      tunnel: 'openai',
      tunnelId,
      ttlMinutes: options.ttlMinutes,
      chatGpt: CHATGPT_CONNECTORS_URL,
      supervisorPid: supervisor.pid ?? null,
    });
    // The supervisor process owns its own audit trail; share does not duplicate
    // share_session events for a server it does not own.
    const stopReason = await waitForStopOrTtl(deps.waitForStop, options.ttlMinutes);
    try {
      supervisor.stop();
    } catch {
      // Already exiting on its own signal handler; teardown converges.
    }
    writeHuman(
      `${stopReason === 'ttl-expired' ? 'TTL expired — ' : ''}` +
        'Share session ended: tunnel closed, temporary credential invalidated.\n',
    );
    emitEvent({ type: 'share.ended', reason: stopReason });
    return done(0);
  }

  // --- token/cloudflare/none modes: share owns the loopback MCP server. ------
  if (options.auth === 'oauth' && !deps.hasOAuthConfig(projectRoot)) {
    return fail(
      '--auth oauth needs OAuth configured for this project first (server.http.auth.oauth ' +
        'or FOLDERFORGE_OAUTH_* — FolderForge validates externally-issued tokens and does ' +
        'not run its own authorization server). Use --auth token for a self-contained ' +
        'trial, or configure OAuth (see docs/oauth.md). Nothing was started.\n',
    );
  }

  const tunnelMode = options.tunnel ?? (deps.hasCloudflared() ? 'cloudflare' : 'none');
  if (options.named !== undefined && tunnelMode !== 'cloudflare') {
    return fail(
      '--named needs a named Cloudflare tunnel, but the tunnel mode resolved to ' +
        `"${tunnelMode}". Install cloudflared and link a Cloudflare account ` +
        '(Mission Control → Settings → Cloudflare), or drop --named for a quick tunnel.\n',
    );
  }
  const token = randomBytes(32).toString('base64url');

  let server: ShareServerHandle;
  try {
    server = await deps.startServer({
      projectRoot,
      token,
      auth: options.auth,
      ...(options.toolsPreset !== undefined ? { toolsPreset: options.toolsPreset } : {}),
    });
  } catch (error) {
    return fail(
      `Failed to start the share server: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  const localUrl = `http://127.0.0.1:${server.port}/mcp`;

  let tunnelUrl: string | undefined;
  let stopTunnel: (() => Promise<void>) | undefined;
  if (tunnelMode === 'cloudflare') {
    if (!deps.hasCloudflared()) {
      await server.close();
      return fail(
        '--tunnel cloudflare needs the cloudflared binary on PATH ' +
          '(https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/). ' +
          'Use --tunnel none for loopback-only sharing. The server was stopped.\n',
      );
    }
    try {
      const tunnel = await deps.startCloudflareTunnel({
        targetPort: server.port,
        projectRoot,
        ...(options.named !== undefined ? { named: options.named } : {}),
      });
      tunnelUrl = tunnel.publicUrl;
      stopTunnel = tunnel.stop;
    } catch (error) {
      await server.close();
      return fail(
        `Cloudflare tunnel failed: ${error instanceof Error ? error.message : String(error)}. ` +
          'The server was stopped; retry or use --tunnel none.\n',
      );
    }
  }

  const publicUrl = tunnelUrl ? `${tunnelUrl.replace(/\/$/, '')}/mcp` : localUrl;
  const startedAt = deps.now();
  server.auditRecord?.({
    type: 'share_session',
    summary:
      `start tunnel=${tunnelMode} auth=${options.auth} ` +
      `preset=${options.toolsPreset ?? DEFAULT_TOOLS_PRESET} port=${server.port} ` +
      `ttlMinutes=${options.ttlMinutes}`,
  });
  writeHuman(
    [
      `FolderForge share — temporary environment for ${projectRoot}`,
      `MCP URL: ${publicUrl}`,
      options.auth === 'token'
        ? `Authorization: Bearer ${token}  (temporary, in-memory only — never written to disk, argv, or logs)`
        : 'Auth: oauth (reusing the project\'s OAuth configuration)',
      `Tunnel: ${tunnelMode}${tunnelUrl ? ` — ${tunnelUrl}` : ''}${options.tunnel === null && tunnelMode === 'cloudflare' ? ' (auto-selected)' : ''}`,
      ttlLine,
      'Paste into your MCP client (ChatGPT: Settings → Connectors → MCP server URL + Bearer credential).',
      'Press Ctrl+C to stop: the tunnel closes and the credential dies with this process.',
      '',
    ].join('\n'),
  );
  emitEvent({
    type: 'share.ready',
    mcpUrl: publicUrl,
    auth: options.auth,
    tunnel: tunnelMode,
    toolsPreset: options.toolsPreset ?? DEFAULT_TOOLS_PRESET,
    ttlMinutes: options.ttlMinutes,
    ...(options.auth === 'token' ? { authorization: `Bearer ${token}` } : {}),
    ...(tunnelUrl ? { publicUrl: tunnelUrl } : {}),
  });

  const stopReason = await waitForStopOrTtl(deps.waitForStop, options.ttlMinutes);

  writeHuman('Stopping share session…\n');
  if (stopTunnel) await stopTunnel();
  await server.close();
  server.auditRecord?.({
    type: 'share_session',
    summary: `stop reason=${stopReason} durationMs=${deps.now() - startedAt}`,
  });
  writeHuman(
    `${stopReason === 'ttl-expired' ? 'TTL expired — ' : ''}` +
      'Share session ended: tunnel closed, temporary credential invalidated.\n',
  );
  emitEvent({ type: 'share.ended', reason: stopReason });
  return done(0);
}
