/**
 * Per-folder MCP fleet provisioner (ADR-0012).
 *
 * Manages a bounded fleet of FolderForge MCP instances, one per project folder.
 * Instances and OpenAI tunnel supervisors are spawned through the existing
 * ProcessManager (injected here), so Mission Control containment and write-freeze
 * keep working unchanged.
 *
 * Lifecycle discipline (reconnect recovery, inspired by webcodex Runner leases):
 * every start mints a fresh `leaseId`, so exit callbacks from a previous start
 * generation can never touch the current record. `load()` reconciles persisted
 * pids against reality after a plane restart — dead pids are cleared, live pids
 * are fingerprinted via their command line: our orphans keep their pid so the
 * next start (or `shutdownAll`) can reap them, foreign processes are never
 * killed and produce an actionable error instead of EADDRINUSE.
 *
 * Secret discipline: static credentials are returned exactly once at creation,
 * rotation, or auth-mode change. Fleet state stores only SHA-256 fingerprints;
 * plaintext lives solely in the per-instance config file (mode 0600). OpenAI
 * control-plane API keys are referenced by environment-variable name; an
 * operator-pasted key may also be stored on the tunnel record (fleet state is
 * written 0600) and is injected into the supervised child's environment —
 * never into its command line.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processCommandLine, terminatePidTree } from '../core/process-tree.js';

export type FleetInstanceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
export type FleetAuthMode = 'none' | 'token' | 'api-key' | 'oauth';

export interface FleetOAuthConfig {
  resource: string;
  issuer: string;
  scopes: string[];
  readScope: string;
  writeScope: string;
  clientRegistration?: 'cimd' | 'dcr' | 'predefined';
  jwksUri?: string;
  trustedJwksHosts?: string[];
  algorithms?: string[];
  resourceDocumentation?: string;
}

export interface FleetOpenAiTunnel {
  tunnelId: string;
  apiKeyEnv: string;
  /**
   * Operator-pasted key value (fleet.json is written 0600 and matches the
   * default denied globs). Never surfaced by the dashboard API; an exported
   * environment variable always wins over this stored copy.
   */
  apiKey?: string;
  oauth: boolean;
  state: FleetInstanceState;
  sessionId?: string;
  pid?: number;
  /** Per-start lease identity (fencing): regenerated on every supervisor start. */
  leaseId?: string;
  updatedAt: string;
  lastError?: string;
}

export interface FleetInstance {
  id: string;
  name: string;
  projectPath: string;
  port: number;
  toolsPreset: string;
  policyMode: string;
  /** Operator-facing auth mode. `api-key` maps to core static-token auth + apiKeys. */
  authMode: FleetAuthMode;
  /** Non-secret OAuth resource-server configuration. */
  oauth?: FleetOAuthConfig;
  /** SHA-256 of a static token/API key. Raw values are never stored in fleet.json. */
  tokenSha256?: string;
  /** Optional OpenAI Secure MCP Tunnel supervisor state/settings. */
  openAiTunnel?: FleetOpenAiTunnel;
  /** Restart automatically after an unexpected normal-instance exit (rate-limited). */
  autoRestart?: boolean;
  state: FleetInstanceState;
  sessionId?: string;
  pid?: number;
  /** Per-start lease identity (fencing): regenerated on every start. */
  leaseId?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  lastError?: string;
}

export interface FleetSpawnResult {
  sessionId: string;
  pid: number | undefined;
}

export type FleetSpawner = (
  command: string,
  cwd: string,
  /** Optional per-child env overlay (e.g. a pasted tunnel key); merged over process.env. */
  env?: Record<string, string>,
) => FleetSpawnResult;
export type FleetSessionStopper = (sessionId: string) => unknown;
export type FleetLogReader = (sessionId: string) => string;
/** Probe an instance endpoint; resolves true when it answers. */
export type FleetHealthProbe = (port: number) => Promise<boolean>;
/** Check whether a pid refers to a live process. */
export type FleetPidAlive = (pid: number) => boolean;
/** Subscribe to a managed session's exit; returns an unsubscribe function. */
export type FleetExitSubscribe = (sessionId: string, listener: () => void) => () => void;

export interface FleetHealth {
  id: string;
  state: FleetInstanceState;
  pidAlive: boolean;
  endpointOk: boolean;
  healthy: boolean;
}

export interface FleetManagerOptions {
  spawn?: FleetSpawner;
  stopSession?: FleetSessionStopper;
  readSession?: FleetLogReader;
  probe?: FleetHealthProbe;
  isAlive?: FleetPidAlive;
  onExit?: FleetExitSubscribe;
  /** Entrypoint of the built runtime; defaults to <dist>/main.js. */
  mainJs?: string;
  /** Hard cap on provisioned instances (operator-controlled, not agent-set). */
  maxFleet?: number;
  portRange?: { start: number; end: number };
  /** Minimum delay between automatic restarts of the same instance. */
  autoRestartCooldownMs?: number;
  /** Read a pid's command line for orphan fingerprinting (undefined = unverifiable). */
  cmdlineOf?: (pid: number) => string | undefined;
  /** Kill a whole process tree by pid. Only ever called for fingerprint-verified orphans. */
  killPidTree?: (pid: number, force?: boolean) => void;
  /** Bounded wait for an orphan to die after SIGTERM (and again after SIGKILL). */
  reapGraceMs?: number;
  now?: () => number;
}

export const FLEET_TOOLS_PRESETS = ['vibe', 'vibe-lite', 'readonly', 'full', 'godot', 'adaptive'] as const;
export const FLEET_POLICY_MODES = ['readonly', 'safe', 'dev', 'danger'] as const;
export const FLEET_AUTH_MODES = ['none', 'token', 'api-key', 'oauth'] as const;

const DEFAULT_MAX_FLEET = 8;
const DEFAULT_PORT_START = 7410;
const DEFAULT_PORT_END = 7499;
const OPENAI_TUNNEL_ID_RE = /^tunnel_[0-9a-f]{32}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EADDRINUSE_RE = /EADDRINUSE|address already in use/i;

function truncateCmdline(value: string): string {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

/** States persisted mid-flight normalize to a settled state after a plane restart. */
function normalizeRestartState(state: FleetInstanceState): FleetInstanceState {
  if (state === 'running' || state === 'starting') return 'failed';
  if (state === 'stopping') return 'stopped';
  return state;
}

interface PersistedFleetState {
  schemaVersion: 1;
  instances: FleetInstance[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

function generateApiKey(): string {
  return `ffk_${randomBytes(32).toString('base64url')}`;
}

/** JSON.stringify output is a valid YAML double-quoted scalar. */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

function cloneOauth(value: FleetOAuthConfig | undefined): FleetOAuthConfig | undefined {
  if (!value) return undefined;
  return {
    ...value,
    scopes: [...value.scopes],
    ...(value.trustedJwksHosts ? { trustedJwksHosts: [...value.trustedJwksHosts] } : {}),
    ...(value.algorithms ? { algorithms: [...value.algorithms] } : {}),
  };
}

function cloneInstance(instance: FleetInstance): FleetInstance {
  const cloned: FleetInstance = { ...instance };
  if (instance.oauth) cloned.oauth = cloneOauth(instance.oauth)!;
  if (instance.openAiTunnel) cloned.openAiTunnel = { ...instance.openAiTunnel };
  return cloned;
}

/**
 * Instance shape safe to return from ANY API surface: identical to the record
 * except the pasted OpenAI key is stripped (it stays in the 0600 fleet state
 * and the supervised child's environment only).
 */
export function publicFleetInstance(instance: FleetInstance): FleetInstance {
  if (!instance.openAiTunnel?.apiKey) return { ...instance };
  const publicTunnel = { ...instance.openAiTunnel };
  delete publicTunnel.apiKey;
  return { ...instance, openAiTunnel: publicTunnel };
}

function normalizeUrl(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required for OAuth auth.`);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${label} must use http or https.`);
  }
  return url.toString().replace(/\/$/, '');
}

function normalizeOauth(input: Partial<FleetOAuthConfig> | undefined): FleetOAuthConfig {
  if (!input) throw new Error('oauth configuration is required when authMode=oauth.');
  const scopes = (input.scopes ?? ['folderforge:read', 'folderforge:write'])
    .map((scope) => String(scope).trim())
    .filter(Boolean);
  const readScope = String(input.readScope ?? 'folderforge:read').trim();
  const writeScope = String(input.writeScope ?? 'folderforge:write').trim();
  if (scopes.length === 0) throw new Error('OAuth scopes must contain at least one scope.');
  if (!readScope || !writeScope) throw new Error('OAuth readScope and writeScope are required.');
  const clientRegistration = input.clientRegistration ?? 'cimd';
  if (!['cimd', 'dcr', 'predefined'].includes(clientRegistration)) {
    throw new Error('OAuth clientRegistration must be cimd, dcr, or predefined.');
  }
  return {
    resource: normalizeUrl(String(input.resource ?? ''), 'OAuth resource'),
    issuer: normalizeUrl(String(input.issuer ?? ''), 'OAuth issuer'),
    scopes,
    readScope,
    writeScope,
    clientRegistration,
    ...(input.jwksUri ? { jwksUri: normalizeUrl(String(input.jwksUri), 'OAuth JWKS URI') } : {}),
    ...(input.trustedJwksHosts?.length
      ? { trustedJwksHosts: input.trustedJwksHosts.map((item) => String(item).trim()).filter(Boolean) }
      : {}),
    ...(input.algorithms?.length
      ? { algorithms: input.algorithms.map((item) => String(item).trim()).filter(Boolean) }
      : {}),
    ...(input.resourceDocumentation
      ? { resourceDocumentation: normalizeUrl(String(input.resourceDocumentation), 'OAuth documentation URL') }
      : {}),
  };
}

function yamlList(lines: string[], indent: string, key: string, values: string[]): void {
  lines.push(`${indent}${key}:`);
  for (const value of values) lines.push(`${indent}  - ${yamlString(value)}`);
}

function instanceConfigYaml(record: FleetInstance, credential?: string): string {
  const lines = [
    '# Generated by the FolderForge fleet provisioner. May contain static credential material.',
    '# Mode 0600; the path matches DEFAULT_DENIED_GLOBS so agent file tools cannot read it.',
    'server:',
    `  name: ${yamlString(`folderforge-fleet-${record.id}`)}`,
    '  transport: http',
    '  http:',
    '    host: "127.0.0.1"',
    `    port: ${record.port}`,
  ];

  if (record.authMode === 'none') {
    lines.push('    auth:', '      mode: "none"');
  } else if (record.authMode === 'token') {
    if (!credential) throw new Error('Token auth requires credential material.');
    lines.push(
      '    auth:',
      '      mode: "token"',
      `    token: ${yamlString(credential)}`,
      '    requireAuth: true',
    );
  } else if (record.authMode === 'api-key') {
    if (!credential) throw new Error('API-key auth requires credential material.');
    lines.push('    auth:', '      mode: "token"', '    apiKeys:', `      - ${yamlString(credential)}`, '    requireAuth: true');
  } else {
    const oauth = record.oauth;
    if (!oauth) throw new Error('OAuth auth requires oauth configuration.');
    lines.push('    auth:', '      mode: "oauth"', '      oauth:');
    lines.push(`        resource: ${yamlString(oauth.resource)}`);
    lines.push(`        issuer: ${yamlString(oauth.issuer)}`);
    yamlList(lines, '        ', 'scopes', oauth.scopes);
    lines.push(`        readScope: ${yamlString(oauth.readScope)}`);
    lines.push(`        writeScope: ${yamlString(oauth.writeScope)}`);
    lines.push(`        clientRegistration: ${yamlString(oauth.clientRegistration ?? 'cimd')}`);
    if (oauth.jwksUri) lines.push(`        jwksUri: ${yamlString(oauth.jwksUri)}`);
    if (oauth.trustedJwksHosts?.length) yamlList(lines, '        ', 'trustedJwksHosts', oauth.trustedJwksHosts);
    if (oauth.algorithms?.length) yamlList(lines, '        ', 'algorithms', oauth.algorithms);
    if (oauth.resourceDocumentation) {
      lines.push(`        resourceDocumentation: ${yamlString(oauth.resourceDocumentation)}`);
    }
  }

  lines.push(
    '  dashboard:',
    '    enabled: false',
    'workspace:',
    `  defaultProject: ${yamlString(record.projectPath)}`,
    '  allowedDirectories:',
    `    - ${yamlString(record.projectPath)}`,
    'policy:',
    `  defaultMode: ${yamlString(record.policyMode)}`,
    '',
  );
  return lines.join('\n');
}

/** Default endpoint probe: an MCP response or auth challenge means the server is up. */
async function defaultEndpointProbe(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
      signal: AbortSignal.timeout(3000),
    });
    return response.status === 200 || response.status === 400 || response.status === 401 || response.status === 403;
  } catch {
    return false;
  }
}

/** Default liveness check for a spawned pid. */
function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class FleetManager {
  private readonly statePath: string;
  private readonly fleetDir: string;
  private readonly mainJs: string;
  private readonly maxFleet: number;
  private readonly portStart: number;
  private readonly portEnd: number;
  private readonly spawnFn: FleetSpawner | undefined;
  private readonly stopFn: FleetSessionStopper | undefined;
  private readonly readFn: FleetLogReader | undefined;
  private readonly probeFn: FleetHealthProbe;
  private readonly isAliveFn: FleetPidAlive;
  private readonly onExitFn: FleetExitSubscribe | undefined;
  private readonly autoRestartCooldownMs: number;
  private readonly cmdlineFn: (pid: number) => string | undefined;
  private readonly killPidTreeFn: (pid: number, force?: boolean) => void;
  private readonly reapGraceMs: number;
  private readonly lastAutoRestart = new Map<string, number>();
  private readonly now: () => number;
  private instances: FleetInstance[] = [];

  constructor(projectRoot: string, options: FleetManagerOptions = {}) {
    const stateDir = resolve(projectRoot, '.folderforge');
    this.statePath = resolve(stateDir, 'fleet.json');
    this.fleetDir = resolve(stateDir, 'fleet');
    this.mainJs = options.mainJs ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'main.js');
    this.maxFleet = options.maxFleet ?? DEFAULT_MAX_FLEET;
    this.portStart = options.portRange?.start ?? DEFAULT_PORT_START;
    this.portEnd = options.portRange?.end ?? DEFAULT_PORT_END;
    this.spawnFn = options.spawn;
    this.stopFn = options.stopSession;
    this.readFn = options.readSession;
    this.probeFn = options.probe ?? defaultEndpointProbe;
    this.isAliveFn = options.isAlive ?? defaultPidAlive;
    this.onExitFn = options.onExit;
    this.autoRestartCooldownMs = options.autoRestartCooldownMs ?? 60_000;
    this.cmdlineFn = options.cmdlineOf ?? processCommandLine;
    this.killPidTreeFn = options.killPidTree ?? terminatePidTree;
    this.reapGraceMs = options.reapGraceMs ?? 1_500;
    this.now = options.now ?? (() => Date.now());
    this.load();
  }

  list(): FleetInstance[] {
    return this.instances.map(cloneInstance);
  }

  get(id: string): FleetInstance {
    return cloneInstance(this.mutable(id));
  }

  create(input: {
    projectPath: string;
    name?: string;
    port?: number;
    toolsPreset?: string;
    policyMode?: string;
    authMode?: FleetAuthMode;
    apiKey?: string;
    oauth?: Partial<FleetOAuthConfig>;
    actor?: string;
  }): { instance: FleetInstance; token: string; apiKey?: string } {
    const projectPath = resolve(input.projectPath);
    if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
      throw new Error(`Not a project folder: ${projectPath}`);
    }
    if (this.instances.some((instance) => instance.projectPath === projectPath)) {
      throw new Error(`Folder already provisioned: ${projectPath}`);
    }
    if (this.instances.length >= this.maxFleet) {
      throw new Error(`Fleet cap reached (${this.maxFleet} instances). Destroy one first.`);
    }
    const port = input.port ?? this.allocatePort();
    this.assertPort(port);
    const toolsPreset = input.toolsPreset ?? 'vibe';
    if (!(FLEET_TOOLS_PRESETS as readonly string[]).includes(toolsPreset)) {
      throw new Error(`Unknown tools preset: ${toolsPreset} (allowed: ${FLEET_TOOLS_PRESETS.join(', ')})`);
    }
    const policyMode = input.policyMode ?? 'dev';
    if (!(FLEET_POLICY_MODES as readonly string[]).includes(policyMode)) {
      throw new Error(`Unknown policy mode: ${policyMode} (allowed: ${FLEET_POLICY_MODES.join(', ')})`);
    }
    const authMode = input.authMode ?? 'token';
    if (!(FLEET_AUTH_MODES as readonly string[]).includes(authMode)) {
      throw new Error(`Unknown auth mode: ${authMode} (allowed: ${FLEET_AUTH_MODES.join(', ')})`);
    }

    const id = `flt_${randomUUID().slice(0, 8)}`;
    let credential: string | undefined;
    let token = '';
    let apiKey: string | undefined;
    let oauth: FleetOAuthConfig | undefined;
    if (authMode === 'token') {
      token = generateToken();
      credential = token;
    } else if (authMode === 'api-key') {
      apiKey = input.apiKey?.trim() || generateApiKey();
      credential = apiKey;
    } else if (authMode === 'oauth') {
      oauth = normalizeOauth(input.oauth);
    }

    const timestamp = new Date(this.now()).toISOString();
    const instance: FleetInstance = {
      id,
      name: input.name?.trim() || basename(projectPath),
      projectPath,
      port,
      toolsPreset,
      policyMode,
      authMode,
      ...(oauth ? { oauth } : {}),
      ...(credential ? { tokenSha256: sha256(credential) } : {}),
      state: 'stopped',
      createdAt: timestamp,
      createdBy: input.actor?.trim() || 'unknown',
      updatedAt: timestamp,
    };

    mkdirSync(this.fleetDir, { recursive: true });
    writeFileSync(this.configPathFor(id), instanceConfigYaml(instance, credential), { mode: 0o600 });
    this.instances.push(instance);
    this.persist();
    return { instance: cloneInstance(instance), token, ...(apiKey ? { apiKey } : {}) };
  }

  start(id: string): FleetInstance {
    const record = this.mutable(id);
    if (record.openAiTunnel?.state === 'running' || record.openAiTunnel?.state === 'starting') {
      throw new Error(`Stop the OpenAI tunnel for ${id} before starting the normal Fleet instance.`);
    }
    if (record.state === 'running' || record.state === 'starting') {
      throw new Error(`Instance ${id} is already ${record.state}.`);
    }
    this.assertSpawnReady();
    // Reconnect recovery: a pid left over from a previous plane life is either
    // a fingerprint-verified orphan to reap or a foreign process to refuse.
    this.reapInstanceOrphan(record);
    const leaseId = `lse_${randomUUID().slice(0, 12)}`;
    record.leaseId = leaseId;
    record.state = 'starting';
    delete record.lastError;
    this.persist();
    try {
      const session = this.spawnFn!(this.startCommand(record), record.projectPath, {
        FOLDERFORGE_LEASE_ID: leaseId,
      });
      record.state = 'running';
      record.sessionId = session.sessionId;
      if (session.pid !== undefined) record.pid = session.pid;
      if (this.onExitFn) {
        this.onExitFn(session.sessionId, () => this.handleExit(id, session.sessionId, leaseId));
      }
    } catch (error) {
      record.state = 'failed';
      record.lastError = error instanceof Error ? error.message : String(error);
      this.persist();
      throw error;
    }
    this.touch(record);
    this.persist();
    return cloneInstance(record);
  }

  stop(id: string): FleetInstance {
    const record = this.mutable(id);
    // No live session but a recorded pid: an orphan from a previous plane
    // life — reap it (fingerprint-gated, best-effort) before converging.
    if (record.sessionId === undefined && record.state !== 'stopped') {
      this.reapRecordedOrphans(record);
    }
    if (record.state === 'stopped') return cloneInstance(record);
    if (record.sessionId && this.stopFn) {
      record.state = 'stopping';
      try {
        this.stopFn(record.sessionId);
      } catch {
        // The session may already be gone; the record still converges to stopped.
      }
    }
    record.state = 'stopped';
    delete record.sessionId;
    delete record.pid;
    delete record.leaseId;
    this.touch(record);
    this.persist();
    return cloneInstance(record);
  }

  setAuth(
    id: string,
    input: { mode: FleetAuthMode; apiKey?: string; oauth?: Partial<FleetOAuthConfig> },
  ): { instance: FleetInstance; token?: string; apiKey?: string; restartRequired: boolean } {
    const record = this.mutable(id);
    if (!(FLEET_AUTH_MODES as readonly string[]).includes(input.mode)) {
      throw new Error(`Unknown auth mode: ${input.mode} (allowed: ${FLEET_AUTH_MODES.join(', ')})`);
    }
    let credential: string | undefined;
    let token: string | undefined;
    let apiKey: string | undefined;
    let oauth: FleetOAuthConfig | undefined;
    if (input.mode === 'token') {
      token = generateToken();
      credential = token;
    } else if (input.mode === 'api-key') {
      apiKey = input.apiKey?.trim() || generateApiKey();
      credential = apiKey;
    } else if (input.mode === 'oauth') {
      oauth = normalizeOauth(input.oauth);
    }

    record.authMode = input.mode;
    if (oauth) record.oauth = oauth;
    else delete record.oauth;
    if (credential) record.tokenSha256 = sha256(credential);
    else delete record.tokenSha256;
    writeFileSync(this.configPathFor(id), instanceConfigYaml(record, credential), { mode: 0o600 });
    this.touch(record);
    this.persist();
    return {
      instance: cloneInstance(record),
      ...(token ? { token } : {}),
      ...(apiKey ? { apiKey } : {}),
      restartRequired: record.state === 'running' || record.state === 'starting',
    };
  }

  rotateToken(id: string): { instance: FleetInstance; token: string; restartRequired: boolean } {
    const record = this.mutable(id);
    if (record.authMode !== 'token') {
      throw new Error(`Instance ${id} uses authMode=${record.authMode}; rotate-token only applies to token auth.`);
    }
    const updated = this.setAuth(id, { mode: 'token' });
    return { instance: updated.instance, token: updated.token!, restartRequired: updated.restartRequired };
  }

  rotateCredential(id: string): {
    instance: FleetInstance;
    kind: 'token' | 'api-key';
    credential: string;
    restartRequired: boolean;
  } {
    const record = this.mutable(id);
    if (record.authMode !== 'token' && record.authMode !== 'api-key') {
      throw new Error(`Instance ${id} has no rotatable static credential (authMode=${record.authMode}).`);
    }
    const updated = this.setAuth(id, { mode: record.authMode });
    const credential = record.authMode === 'token' ? updated.token : updated.apiKey;
    if (!credential) throw new Error('Credential rotation failed to issue a credential.');
    return {
      instance: updated.instance,
      kind: record.authMode,
      credential,
      restartRequired: updated.restartRequired,
    };
  }

  startOpenAiTunnel(
    id: string,
    input: { tunnelId: string; apiKeyEnv?: string; oauth?: boolean; apiKey?: string },
  ): FleetInstance {
    const record = this.mutable(id);
    if (record.state === 'running' || record.state === 'starting') {
      throw new Error(`Stop instance ${id} before starting its OpenAI tunnel supervisor.`);
    }
    if (record.openAiTunnel?.state === 'running' || record.openAiTunnel?.state === 'starting') {
      throw new Error(`OpenAI tunnel for ${id} is already ${record.openAiTunnel.state}.`);
    }
    const tunnelId = input.tunnelId.trim();
    if (!OPENAI_TUNNEL_ID_RE.test(tunnelId)) {
      throw new Error('OpenAI tunnel ID must be tunnel_ followed by 32 lowercase hexadecimal characters.');
    }
    const apiKeyEnv = (input.apiKeyEnv?.trim() || 'CONTROL_PLANE_API_KEY');
    if (!ENV_NAME_RE.test(apiKeyEnv)) throw new Error('apiKeyEnv must be a valid environment variable name.');
    // A key pasted in Mission Control (stored on the record; fleet.json is
    // written 0600) satisfies the check when the env var itself was not
    // exported. Pasting again replaces the stored copy.
    const apiKey = input.apiKey?.trim() || record.openAiTunnel?.apiKey;
    if (!process.env[apiKeyEnv] && !apiKey) {
      throw new Error(
        `Environment variable ${apiKeyEnv} is not set in the Mission Control process and no key is saved. Restart control with that variable exported, or paste the key in the OpenAI tunnel dialog.`,
      );
    }
    this.assertSpawnReady();
    // Reap a fingerprint-verified orphan supervisor from a previous plane life
    // before minting the new tunnel record (the fingerprint needs the old one).
    this.reapTunnelOrphan(record);
    const oauth = input.oauth ?? record.authMode === 'oauth';
    const leaseId = `lse_${randomUUID().slice(0, 12)}`;
    const timestamp = new Date(this.now()).toISOString();
    record.openAiTunnel = {
      tunnelId,
      apiKeyEnv,
      ...(apiKey ? { apiKey } : {}),
      oauth,
      state: 'starting',
      leaseId,
      updatedAt: timestamp,
    };
    delete record.openAiTunnel.lastError;
    this.touch(record);
    this.persist();

    try {
      // The pasted key rides the child's environment (never the command
      // line); an exported env var always wins over the stored copy.
      const env: Record<string, string> = { FOLDERFORGE_LEASE_ID: leaseId };
      if (record.openAiTunnel.apiKey && !process.env[record.openAiTunnel.apiKeyEnv]) {
        env[record.openAiTunnel.apiKeyEnv] = record.openAiTunnel.apiKey;
      }
      const session = this.spawnFn!(
        this.openAiTunnelCommand(record, record.openAiTunnel),
        record.projectPath,
        env,
      );
      record.openAiTunnel.state = 'running';
      record.openAiTunnel.sessionId = session.sessionId;
      if (session.pid !== undefined) record.openAiTunnel.pid = session.pid;
      record.openAiTunnel.updatedAt = new Date(this.now()).toISOString();
      if (this.onExitFn) {
        this.onExitFn(session.sessionId, () =>
          this.handleOpenAiTunnelExit(id, session.sessionId, leaseId),
        );
      }
    } catch (error) {
      record.openAiTunnel.state = 'failed';
      record.openAiTunnel.lastError = error instanceof Error ? error.message : String(error);
      record.openAiTunnel.updatedAt = new Date(this.now()).toISOString();
      this.persist();
      throw error;
    }
    this.touch(record);
    this.persist();
    return cloneInstance(record);
  }

  stopOpenAiTunnel(id: string): FleetInstance {
    const record = this.mutable(id);
    const tunnel = record.openAiTunnel;
    // Orphan supervisor (recorded pid, no live session): reap before converging.
    if (tunnel && tunnel.sessionId === undefined && tunnel.state !== 'stopped') {
      this.reapRecordedOrphans(record);
    }
    if (!tunnel || tunnel.state === 'stopped') return cloneInstance(record);
    if (tunnel.sessionId && this.stopFn) {
      tunnel.state = 'stopping';
      try {
        this.stopFn(tunnel.sessionId);
      } catch {
        // Already gone; converge to stopped below.
      }
    }
    tunnel.state = 'stopped';
    delete tunnel.sessionId;
    delete tunnel.pid;
    delete tunnel.leaseId;
    delete tunnel.lastError;
    tunnel.updatedAt = new Date(this.now()).toISOString();
    this.touch(record);
    this.persist();
    return cloneInstance(record);
  }

  /**
   * Control-plane shutdown path: stop every instance and tunnel supervisor,
   * and reap any fingerprint-verified orphan left by a previous plane life.
   * Best-effort per record so one bad stop never blocks the rest.
   */
  shutdownAll(): void {
    for (const record of this.instances) {
      this.reapRecordedOrphans(record);
      try {
        this.stop(record.id);
      } catch {
        // Converge: remaining instances still get their stop.
      }
      try {
        this.stopOpenAiTunnel(record.id);
      } catch {
        // Converge: remaining instances still get their stop.
      }
    }
    this.persist();
  }

  openAiTunnelLogs(id: string): string {
    const record = this.mutable(id);
    const sessionId = record.openAiTunnel?.sessionId;
    if (!sessionId || !this.readFn) return '';
    return this.readFn(sessionId);
  }

  destroy(id: string): { destroyed: string } {
    const record = this.mutable(id);
    if (record.state !== 'stopped' && record.state !== 'failed') {
      throw new Error(`Stop instance ${id} before destroying it (state: ${record.state}).`);
    }
    if (
      record.openAiTunnel &&
      record.openAiTunnel.state !== 'stopped' &&
      record.openAiTunnel.state !== 'failed'
    ) {
      throw new Error(`Stop the OpenAI tunnel for ${id} before destroying the instance.`);
    }
    const configPath = this.configPathFor(id);
    if (existsSync(configPath)) unlinkSync(configPath);
    this.instances = this.instances.filter((instance) => instance.id !== id);
    this.persist();
    return { destroyed: id };
  }

  logs(id: string): string {
    const record = this.mutable(id);
    if (!record.sessionId || !this.readFn) return '';
    return this.readFn(record.sessionId);
  }

  /** Probe one normal instance: state, pid liveness, and HTTP responsiveness. */
  async health(id: string): Promise<FleetHealth> {
    const record = this.mutable(id);
    const pidAlive = record.pid !== undefined ? this.isAliveFn(record.pid) : false;
    const endpointOk = record.state === 'running' ? await this.probeFn(record.port) : false;
    return {
      id: record.id,
      state: record.state,
      pidAlive,
      endpointOk,
      healthy: record.state === 'running' && pidAlive && endpointOk,
    };
  }

  /** Restart a normal instance: graceful stop followed by start. */
  restart(id: string): FleetInstance {
    this.stop(id);
    return this.start(id);
  }

  /** Enable or disable automatic restart after an unexpected normal-instance exit. */
  setAutoRestart(id: string, enabled: boolean): FleetInstance {
    const record = this.mutable(id);
    record.autoRestart = enabled;
    this.touch(record);
    this.persist();
    return cloneInstance(record);
  }

  setToolsPreset(id: string, preset: string): FleetInstance {
    if (!(FLEET_TOOLS_PRESETS as readonly string[]).includes(preset)) {
      throw new Error(`Invalid tools preset: ${preset} (expected one of ${FLEET_TOOLS_PRESETS.join(', ')}).`);
    }
    const record = this.mutable(id);
    record.toolsPreset = preset;
    this.touch(record);
    this.persist();
    return cloneInstance(record);
  }

  setPolicyMode(id: string, mode: string): FleetInstance {
    if (!(FLEET_POLICY_MODES as readonly string[]).includes(mode)) {
      throw new Error(`Invalid policy mode: ${mode} (expected one of ${FLEET_POLICY_MODES.join(', ')}).`);
    }
    const record = this.mutable(id);
    record.policyMode = mode;
    this.touch(record);
    this.persist();
    return cloneInstance(record);
  }

  private handleExit(id: string, sessionId: string, leaseId?: string): void {
    const record = this.instances.find((instance) => instance.id === id);
    if (!record || record.sessionId !== sessionId) return;
    // Lease fencing: an exit callback from a previous start generation must
    // never touch the state of the current one.
    if (leaseId !== undefined && record.leaseId !== leaseId) return;
    if (record.state !== 'running') return;
    record.state = 'failed';
    const portBusy = this.exitLogMatches(sessionId, EADDRINUSE_RE);
    if (portBusy) {
      record.lastError = `Port ${record.port} is already in use by a process this control plane does not manage. Free the port (or assign another) and start again.`;
    } else {
      const fatalReason = this.exitFatalReason(sessionId);
      record.lastError = fatalReason
        ? `Process exited unexpectedly: ${fatalReason}`
        : 'Process exited unexpectedly.';
    }
    delete record.sessionId;
    delete record.pid;
    delete record.leaseId;
    this.touch(record);
    this.persist();
    if (!record.autoRestart) return;
    // A busy port is a deterministic failure: restarting would only flap.
    if (portBusy) return;
    const last = this.lastAutoRestart.get(id) ?? 0;
    if (this.now() - last < this.autoRestartCooldownMs) return;
    this.lastAutoRestart.set(id, this.now());
    try {
      this.start(id);
    } catch {
      // start() captures the failure.
    }
  }

  private handleOpenAiTunnelExit(id: string, sessionId: string, leaseId?: string): void {
    const record = this.instances.find((instance) => instance.id === id);
    const tunnel = record?.openAiTunnel;
    if (!record || !tunnel || tunnel.sessionId !== sessionId) return;
    // Lease fencing: an exit callback from a previous start generation must
    // never touch the state of the current one.
    if (leaseId !== undefined && tunnel.leaseId !== leaseId) return;
    if (tunnel.state !== 'running') return;
    tunnel.state = 'failed';
    tunnel.lastError = this.exitLogMatches(sessionId, EADDRINUSE_RE)
      ? `Port ${record.port} is already in use by a process this control plane does not manage. Free the port (or assign another) and start the tunnel again.`
      : 'OpenAI tunnel supervisor exited unexpectedly.';
    delete tunnel.sessionId;
    delete tunnel.pid;
    delete tunnel.leaseId;
    tunnel.updatedAt = new Date(this.now()).toISOString();
    this.touch(record);
    this.persist();
  }

  /** True when the session's buffered output matches the pattern (EADDRINUSE). */
  private exitLogMatches(sessionId: string, pattern: RegExp): boolean {
    if (!this.readFn) return false;
    try {
      return pattern.test(this.readFn(sessionId));
    } catch {
      return false;
    }
  }

  /**
   * Extracts the child's fatal startup reason from its buffered output, so the
   * dashboard shows the real cause (e.g. the unauthenticated-tunnel refusal)
   * instead of a bare "Process exited unexpectedly.".
   */
  private exitFatalReason(sessionId: string): string | undefined {
    if (!this.readFn) return undefined;
    let output: string;
    try {
      output = this.readFn(sessionId);
    } catch {
      return undefined;
    }
    const lines = output.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!.trim();
      if (!line.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line) as { level?: unknown; err?: unknown };
        const level = typeof parsed.level === 'number' ? parsed.level : 0;
        if (level >= 50 && typeof parsed.err === 'string' && parsed.err.length > 0) {
          const [firstLine] = parsed.err.split('\n');
          const cleaned = firstLine!.replace(/^Error:\s*/, '').trim();
          return cleaned.length > 240 ? `${cleaned.slice(0, 237)}...` : cleaned;
        }
      } catch {
        // Not a JSON log line; keep scanning upwards.
      }
    }
    return undefined;
  }

  /**
   * Reap the pid recorded on an instance before a fresh start. A live pid is
   * only killed when its command line fingerprints it as THIS instance's own
   * child (same generated config path and project path); anything else is a
   * foreign process and produces an actionable error instead of a kill.
   */
  private reapInstanceOrphan(record: FleetInstance): void {
    // Sessions belong to a previous plane process; they never survive a start.
    delete record.sessionId;
    const pid = record.pid;
    if (pid === undefined) return;
    if (!this.isAliveFn(pid)) {
      delete record.pid;
      delete record.leaseId;
      return;
    }
    const cmdline = this.cmdlineFn(pid);
    const ours =
      cmdline !== undefined &&
      cmdline.includes(this.configPathFor(record.id)) &&
      cmdline.includes(record.projectPath);
    if (!ours) {
      const reason =
        cmdline === undefined
          ? 'its command line cannot be verified on this platform'
          : `it is an unrelated process (${truncateCmdline(cmdline)})`;
      throw new Error(
        `Instance ${record.id} cannot start on port ${record.port}: recorded pid ${pid} is still alive but ${reason}. Refusing to kill a foreign process — free the port yourself or assign another port.`,
      );
    }
    if (!this.reapVerifiedOrphan(pid)) {
      throw new Error(
        `Instance ${record.id}: orphaned fleet process ${pid} did not die after SIGTERM+SIGKILL. Kill it manually and start again.`,
      );
    }
    delete record.pid;
    delete record.leaseId;
  }

  /** Same reap gate for an OpenAI tunnel supervisor (fingerprint: tunnel flags). */
  private reapTunnelOrphan(record: FleetInstance): void {
    const tunnel = record.openAiTunnel;
    if (!tunnel) return;
    delete tunnel.sessionId;
    const pid = tunnel.pid;
    if (pid === undefined) return;
    if (!this.isAliveFn(pid)) {
      delete tunnel.pid;
      delete tunnel.leaseId;
      return;
    }
    const cmdline = this.cmdlineFn(pid);
    const ours =
      cmdline !== undefined &&
      cmdline.includes('--openai-tunnel') &&
      cmdline.includes(tunnel.tunnelId) &&
      cmdline.includes(record.projectPath);
    if (!ours) {
      const reason =
        cmdline === undefined
          ? 'its command line cannot be verified on this platform'
          : `it is an unrelated process (${truncateCmdline(cmdline)})`;
      throw new Error(
        `OpenAI tunnel for ${record.id} cannot start: recorded supervisor pid ${pid} is still alive but ${reason}. Refusing to kill a foreign process — free it yourself first.`,
      );
    }
    if (!this.reapVerifiedOrphan(pid)) {
      throw new Error(
        `OpenAI tunnel for ${record.id}: orphaned supervisor ${pid} did not die after SIGTERM+SIGKILL. Kill it manually and start again.`,
      );
    }
    delete tunnel.pid;
    delete tunnel.leaseId;
  }

  /** Best-effort orphan reap for stop/shutdown paths; never kills foreign pids. */
  private reapRecordedOrphans(record: FleetInstance): void {
    const tryReap = (pid: number | undefined, parts: string[]): void => {
      if (pid === undefined || !this.isAliveFn(pid)) return;
      const cmdline = this.cmdlineFn(pid);
      if (cmdline === undefined || !parts.every((part) => cmdline.includes(part))) return;
      this.reapVerifiedOrphan(pid);
    };
    tryReap(record.pid, [this.configPathFor(record.id), record.projectPath]);
    const tunnel = record.openAiTunnel;
    if (tunnel) {
      tryReap(tunnel.pid, ['--openai-tunnel', tunnel.tunnelId, record.projectPath]);
    }
  }

  /** Kill a fingerprint-verified orphan tree; true once the pid is gone. */
  private reapVerifiedOrphan(pid: number): boolean {
    this.killPidTreeFn(pid, false);
    if (this.waitForDeath(pid, this.reapGraceMs)) return true;
    this.killPidTreeFn(pid, true);
    return this.waitForDeath(pid, this.reapGraceMs);
  }

  /** Bounded synchronous wait for a pid to die (start/shutdown paths only). */
  private waitForDeath(pid: number, timeoutMs: number): boolean {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const signal = new Int32Array(new SharedArrayBuffer(4));
    // Wall clock, not the injectable now(): a fake clock in tests must never
    // be able to spin this loop forever.
    while (Date.now() < deadline) {
      if (!this.isAliveFn(pid)) return true;
      Atomics.wait(signal, 0, 0, 25);
    }
    return !this.isAliveFn(pid);
  }

  private mutable(id: string): FleetInstance {
    const record = this.instances.find((instance) => instance.id === id);
    if (!record) throw new Error(`Unknown fleet instance: ${id}`);
    return record;
  }

  private allocatePort(): number {
    const used = new Set(this.instances.map((instance) => instance.port));
    for (let port = this.portStart; port <= this.portEnd; port += 1) {
      if (!used.has(port)) return port;
    }
    throw new Error(`No free fleet port in range ${this.portStart}-${this.portEnd}.`);
  }

  private assertPort(port: number): void {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error(`Invalid port: ${port} (expected an integer in 1024-65535).`);
    }
    if (this.instances.some((instance) => instance.port === port)) {
      throw new Error(`Port ${port} is already assigned to another fleet instance.`);
    }
  }

  private assertSpawnReady(): void {
    if (!this.spawnFn) throw new Error('No process spawner is wired; fleet start is unavailable.');
    if (!existsSync(this.mainJs)) {
      throw new Error('FolderForge runtime entrypoint not found; run `npm run build` first.');
    }
  }

  private startCommand(record: FleetInstance): string {
    return [
      JSON.stringify(process.execPath),
      JSON.stringify(this.mainJs),
      '--project',
      JSON.stringify(record.projectPath),
      '--config',
      JSON.stringify(this.configPathFor(record.id)),
      '--no-dashboard',
      '--policy',
      record.policyMode,
      '--tools-preset',
      record.toolsPreset,
    ].join(' ');
  }

  private openAiTunnelCommand(record: FleetInstance, tunnel: FleetOpenAiTunnel): string {
    return [
      JSON.stringify(process.execPath),
      JSON.stringify(this.mainJs),
      'connect',
      'chatgpt',
      '--openai-tunnel',
      '--tunnel-id',
      JSON.stringify(tunnel.tunnelId),
      '--api-key-env',
      JSON.stringify(tunnel.apiKeyEnv),
      '--project',
      JSON.stringify(record.projectPath),
      '--port',
      String(record.port),
      '--no-dashboard',
      '--no-open',
      '--policy',
      record.policyMode,
      '--tools-preset',
      record.toolsPreset,
      tunnel.oauth ? '--oauth' : '--no-oauth',
    ].join(' ');
  }

  private configPathFor(id: string): string {
    return resolve(this.fleetDir, `${id}.yaml`);
  }

  private touch(record: FleetInstance): void {
    record.updatedAt = new Date(this.now()).toISOString();
  }

  private load(): void {
    if (!existsSync(this.statePath)) return;
    const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as PersistedFleetState;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.instances)) {
      throw new Error(`Unsupported fleet state schema in ${this.statePath}.`);
    }
    this.instances = parsed.instances.map((instance) => {
      const wasActive = instance.state === 'running' || instance.state === 'starting';
      const normalized: FleetInstance = {
        ...instance,
        authMode: instance.authMode ?? 'token',
        state: normalizeRestartState(instance.state),
      };
      if (instance.oauth) normalized.oauth = cloneOauth(instance.oauth)!;
      // Sessions belong to the previous plane process and are never actionable.
      delete normalized.sessionId;
      if (wasActive) {
        normalized.lastError = 'Control plane restarted while instance state was active.';
      }
      this.reconcileInstancePid(normalized, wasActive);
      if (instance.openAiTunnel) {
        const tunnelWasActive =
          instance.openAiTunnel.state === 'running' ||
          instance.openAiTunnel.state === 'starting';
        normalized.openAiTunnel = {
          ...instance.openAiTunnel,
          state: normalizeRestartState(instance.openAiTunnel.state),
        };
        delete normalized.openAiTunnel.sessionId;
        if (tunnelWasActive) {
          normalized.openAiTunnel.lastError =
            'Control plane restarted while OpenAI tunnel supervisor state was active.';
        }
        this.reconcileTunnelPid(normalized, tunnelWasActive);
      }
      return normalized;
    });
  }

  /**
   * Reconcile a recorded pid with reality after a plane restart. Nothing is
   * killed here: a live pid is only CLASSIFIED (our orphan vs foreign), and
   * only an orphan keeps its pid so the next start() can reap it.
   */
  private reconcileInstancePid(record: FleetInstance, wasActive: boolean): void {
    const pid = record.pid;
    if (pid === undefined) return;
    if (!this.isAliveFn(pid)) {
      delete record.pid;
      delete record.leaseId;
      if (wasActive) {
        record.lastError = `Control plane restarted while the instance was active; recorded pid ${pid} is no longer running.`;
      }
      return;
    }
    const cmdline = this.cmdlineFn(pid);
    const ours =
      cmdline !== undefined &&
      cmdline.includes(this.configPathFor(record.id)) &&
      cmdline.includes(record.projectPath);
    if (ours) {
      record.state = 'failed';
      record.lastError =
        `Orphaned fleet process ${pid} survived a control-plane restart and may still hold ` +
        `port ${record.port}; starting the instance again will reap it automatically.`;
      return;
    }
    delete record.pid;
    delete record.leaseId;
    if (wasActive || record.state === 'failed') {
      const status =
        cmdline === undefined ? 'unverifiable on this platform' : 'an unrelated process';
      record.lastError = `Recorded pid ${pid} is now ${status}; the previous run is gone. If port ${record.port} is busy, free it before starting.`;
    }
  }

  /** Tunnel-side pid reconciliation; same classify-only contract. */
  private reconcileTunnelPid(record: FleetInstance, wasActive: boolean): void {
    const tunnel = record.openAiTunnel;
    if (!tunnel) return;
    const pid = tunnel.pid;
    if (pid === undefined) return;
    if (!this.isAliveFn(pid)) {
      delete tunnel.pid;
      delete tunnel.leaseId;
      if (wasActive) {
        tunnel.lastError = `Control plane restarted while the OpenAI tunnel supervisor was active; recorded pid ${pid} is no longer running.`;
      }
      return;
    }
    const cmdline = this.cmdlineFn(pid);
    const ours =
      cmdline !== undefined &&
      cmdline.includes('--openai-tunnel') &&
      cmdline.includes(tunnel.tunnelId) &&
      cmdline.includes(record.projectPath);
    if (ours) {
      tunnel.state = 'failed';
      tunnel.lastError =
        `Orphaned OpenAI tunnel supervisor ${pid} survived a control-plane restart; ` +
        'starting the tunnel again will reap it automatically.';
      return;
    }
    delete tunnel.pid;
    delete tunnel.leaseId;
    if (wasActive || tunnel.state === 'failed') {
      const status =
        cmdline === undefined ? 'unverifiable on this platform' : 'an unrelated process';
      tunnel.lastError = `Recorded supervisor pid ${pid} is now ${status}; the previous tunnel run is gone.`;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.${randomUUID().slice(0, 8)}.tmp`;
    const state: PersistedFleetState = { schemaVersion: 1, instances: this.instances };
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.statePath);
  }
}
