import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import YAML from 'yaml';

const DEFAULT_PORT = 7331;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_SCOPES = ['folderforge:read', 'folderforge:write'] as const;
const RECEIPT_VERSION = 1;
const MAX_COMMAND_OUTPUT = 1024 * 1024;
const CLI_ENTRY = fileURLToPath(new URL('../main.js', import.meta.url));

export type ChatGptMode = 'quick' | 'secure';
export type RegistrationStrategy = 'dcr' | 'predefined';
export type CheckState = 'pass' | 'pending' | 'pending_user_login' | 'fail' | 'not_run';

export interface ChatGptConnectionReceipt {
  version: number;
  status: 'configured' | 'ready' | 'action_required' | 'stopped' | 'disconnected' | 'error';
  provider: 'auth0';
  mode: ChatGptMode;
  registration: RegistrationStrategy;
  tenant: string;
  issuer: string;
  resource: string;
  mcpUrl: string;
  metadataUrl: string;
  scopes: string[];
  projectRoot: string;
  configPath: string;
  clientId?: string;
  auth0: {
    apiId?: string;
    apiName: string;
    createdByFolderForge: boolean;
  };
  connectivity: {
    kind: 'stable-url' | 'cloudflared-quick';
    publicUrl: string;
    localUrl: string;
    warning?: string;
  };
  processes: {
    serverPid?: number;
    tunnelPid?: number;
    serverLog: string;
    tunnelLog?: string;
  };
  checks: {
    dependencies: CheckState;
    tenant: CheckState;
    issuerDiscovery: CheckState;
    auth0Api: CheckState;
    resourceMetadata: CheckState;
    unauthorizedChallenge: CheckState;
    jwks: CheckState;
    tokenValidation: CheckState;
    mcpInitialize: CheckState;
  };
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

interface AuthorizationMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

interface Auth0Api {
  id?: string;
  name?: string;
  identifier?: string;
  signing_alg?: string;
  token_dialect?: string;
  token_lifetime?: number;
  allow_offline_access?: boolean;
  scopes?: Array<{ value?: string; description?: string }>;
}

interface ParsedOptions {
  action: 'connect' | 'status' | 'doctor' | 'repair' | 'start' | 'stop' | 'disconnect';
  mode?: ChatGptMode;
  projectRoot: string;
  publicUrl?: string;
  tunnel: 'cloudflared' | 'none';
  tenant?: string;
  clientId?: string;
  host: string;
  port: number;
  start: boolean;
  json: boolean;
  dryRun: boolean;
  purgeLocal: boolean;
  yes: boolean;
}

export interface ChatGptCliResult {
  exitCode: number;
  output: string;
  receipt?: ChatGptConnectionReceipt;
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ProgressSink {
  line(message: string): void;
  output(): string;
}

function progressSink(onLine?: (line: string) => void): ProgressSink {
  const lines: string[] = [];
  return {
    line(message: string): void {
      lines.push(message);
      onLine?.(message);
    },
    output(): string {
      return `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`;
    },
  };
}

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseChatGptArgs(argv: string[], cwd = process.cwd()): ParsedOptions {
  const actionRaw = argv[0] ?? 'connect';
  const allowedActions = new Set(['connect', 'status', 'doctor', 'repair', 'start', 'stop', 'disconnect']);
  if (!allowedActions.has(actionRaw)) throw new Error(`Unknown ChatGPT command: ${actionRaw}`);

  const options: ParsedOptions = {
    action: actionRaw as ParsedOptions['action'],
    projectRoot: resolve(cwd),
    tunnel: 'cloudflared',
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    start: true,
    json: false,
    dryRun: false,
    purgeLocal: false,
    yes: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case '--quick':
        if (options.mode === 'secure') throw new Error('Choose only one of --quick or --secure');
        options.mode = 'quick';
        break;
      case '--secure':
        if (options.mode === 'quick') throw new Error('Choose only one of --quick or --secure');
        options.mode = 'secure';
        break;
      case '--project':
      case '-p':
        options.projectRoot = resolve(valueAfter(argv, index, arg));
        index += 1;
        break;
      case '--public-url':
        options.publicUrl = valueAfter(argv, index, arg);
        index += 1;
        break;
      case '--tunnel': {
        const value = valueAfter(argv, index, arg);
        if (value !== 'cloudflared' && value !== 'none') {
          throw new Error('--tunnel must be cloudflared or none');
        }
        options.tunnel = value;
        index += 1;
        break;
      }
      case '--tenant':
        options.tenant = valueAfter(argv, index, arg);
        index += 1;
        break;
      case '--client-id':
        options.clientId = valueAfter(argv, index, arg);
        index += 1;
        break;
      case '--host':
        options.host = valueAfter(argv, index, arg);
        index += 1;
        break;
      case '--port': {
        const value = Number(valueAfter(argv, index, arg));
        if (!Number.isInteger(value) || value < 1 || value > 65535) {
          throw new Error('--port must be an integer from 1 to 65535');
        }
        options.port = value;
        index += 1;
        break;
      }
      case '--no-start':
        options.start = false;
        break;
      case '--json':
        options.json = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        options.start = false;
        break;
      case '--purge-local':
        options.purgeLocal = true;
        break;
      case '--yes':
        options.yes = true;
        break;
      case '--help':
      case '-h':
        throw new Error('HELP');
      default:
        throw new Error(`Unknown ChatGPT option: ${arg}`);
    }
  }

  return options;
}

export function chatGptHelp(): string {
  return [
    'FolderForge ChatGPT OAuth connection',
    '',
    'Usage:',
    '  folderforge connect chatgpt [--quick|--secure] [options]',
    '  folderforge chatgpt <status|doctor|repair|start|stop|disconnect> [options]',
    '',
    'Modes:',
    '  --quick                 Personal testing. Uses Auth0 DCR and, by default, a temporary Cloudflare quick tunnel.',
    '  --secure                Team/production. Requires a stable --public-url and normally a predefined OAuth client.',
    '',
    'Options:',
    '  -p, --project <dir>     Project to expose (default: current directory)',
    '      --public-url <url>  Stable public HTTPS MCP URL; /mcp is appended to an origin URL',
    '      --tunnel <kind>     cloudflared|none (default cloudflared in quick mode)',
    '      --tenant <domain>   Auth0 tenant override; otherwise uses the active Auth0 CLI tenant',
    '      --client-id <id>    Predefined OAuth client id for secure mode (never stores a client secret)',
    '      --host <addr>       Local FolderForge bind host (default 127.0.0.1)',
    '      --port <n>          Local FolderForge port (default 7331)',
    '      --no-start          Configure Auth0 and generate local files without starting processes',
    '      --dry-run           Discover and validate only; do not change Auth0 or local files',
    '      --json              Machine-readable receipt/status output',
    '      --purge-local       With disconnect, remove generated config/log files after stopping',
    '      --yes               Confirm --purge-local without an interactive prompt',
    '',
    'FolderForge never stores Auth0 Management API tokens, OAuth access/refresh tokens, authorization codes,',
    'PKCE verifiers, client secrets, cookies, or API keys in the connection receipt.',
    '',
  ].join('\n');
}

function receiptPaths(projectRoot: string): {
  stateDir: string;
  receipt: string;
  config: string;
  lock: string;
  serverLog: string;
  tunnelLog: string;
} {
  const stateDir = join(projectRoot, '.folderforge');
  return {
    stateDir,
    receipt: join(stateDir, 'chatgpt-connection.json'),
    config: join(stateDir, 'chatgpt-config.yaml'),
    lock: join(stateDir, 'chatgpt-connect.lock'),
    serverLog: join(stateDir, 'chatgpt-server.log'),
    tunnelLog: join(stateDir, 'chatgpt-tunnel.log'),
  };
}

function normalizeTenant(raw: string): string {
  const trimmed = raw.trim();
  const url = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Invalid Auth0 tenant domain: ${raw}`);
  }
  return url.hostname.toLowerCase();
}

export function normalizeMcpUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('The public MCP URL must use HTTPS');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The public MCP URL must not contain userinfo, query parameters, or fragments');
  }
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/mcp';
  url.pathname = url.pathname.replace(/\/$/, '');
  if (!url.pathname.endsWith('/mcp')) {
    throw new Error('The public MCP URL must end in /mcp (or be an origin URL so FolderForge can append it)');
  }
  return url.href.replace(/\/$/, '');
}

function metadataUrlFor(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  const resourcePath = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return new URL(`/.well-known/oauth-protected-resource${resourcePath}`, url.origin).href;
}

function localUrl(host: string, port: number): string {
  const normalizedHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const bracketed = normalizedHost.includes(':') && !normalizedHost.startsWith('[') ? `[${normalizedHost}]` : normalizedHost;
  return `http://${bracketed}:${port}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<RunResult> {
  return await new Promise<RunResult>((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      rejectRun(new Error(`${basename(command)} timed out after ${options.timeoutMs ?? 30_000}ms`));
    }, options.timeoutMs ?? 30_000);

    const append = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current, 'utf8') >= MAX_COMMAND_OUTPUT) return current;
      return `${current}${chunk.toString('utf8')}`.slice(0, MAX_COMMAND_OUTPUT);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveRun({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function jsonDocumentFromOutput<T>(raw: string): T {
  const startCandidates = [raw.indexOf('{'), raw.indexOf('[')].filter((value) => value >= 0).sort((a, b) => a - b);
  for (const start of startCandidates) {
    const opening = raw[start];
    const closing = opening === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === opening) depth += 1;
      if (char === closing) depth -= 1;
      if (depth === 0) {
        return JSON.parse(raw.slice(start, index + 1)) as T;
      }
    }
  }
  throw new Error('Command did not return a JSON document');
}

async function requireCommand(command: string): Promise<string> {
  const result = await runCommand(command, ['--version'], { timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(`${command} is installed but unusable: ${result.stderr.trim()}`);
  return (result.stdout || result.stderr).trim().split(/\r?\n/)[0] ?? command;
}

async function activeAuth0Tenant(override?: string): Promise<string> {
  const result = await runCommand(
    'auth0',
    ['tenants', 'list', '--json-compact', '--no-color', '--no-input'],
    { timeoutMs: 20_000 }
  );
  if (result.exitCode !== 0) {
    throw new Error('Auth0 CLI is not logged in. Run `auth0 login`, then retry `folderforge connect chatgpt`.');
  }
  const tenants = jsonDocumentFromOutput<Array<{ active?: boolean; name?: string }>>(`${result.stdout}\n${result.stderr}`);
  const knownTenants = tenants
    .map((tenant) => tenant.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
    .map(normalizeTenant);
  if (override) {
    const requested = normalizeTenant(override);
    if (!knownTenants.includes(requested)) {
      throw new Error(
        `Auth0 tenant ${requested} is not present in the authenticated Auth0 CLI tenant list. ` +
          'Run `auth0 login` or `auth0 tenants use <tenant-domain>` before retrying.'
      );
    }
    return requested;
  }
  const active = tenants.find((tenant) => tenant.active && tenant.name);
  if (!active?.name) {
    throw new Error('No active Auth0 tenant. Run `auth0 tenants use <tenant-domain>` and retry.');
  }
  return normalizeTenant(active.name);
}

async function fetchJson(url: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_COMMAND_OUTPUT) {
    throw new Error(`${url} returned metadata larger than ${MAX_COMMAND_OUTPUT} bytes`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_COMMAND_OUTPUT) {
    throw new Error(`${url} returned metadata larger than ${MAX_COMMAND_OUTPUT} bytes`);
  }
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${url} did not return a JSON object`);
  }
  return value as Record<string, unknown>;
}

function validatedAuth0Endpoint(value: unknown, field: string, expectedOrigin: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Auth0 discovery is missing ${field}`);
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.origin !== expectedOrigin ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  ) {
    throw new Error(`Auth0 discovery ${field} must be an HTTPS URL on ${expectedOrigin}`);
  }
  return endpoint.href;
}

async function discoverAuth0(tenant: string, registration: RegistrationStrategy): Promise<AuthorizationMetadata> {
  const url = `https://${tenant}/.well-known/openid-configuration`;
  const raw = await fetchJson(url);
  const expectedIssuer = `https://${tenant}/`;
  if (raw.issuer !== expectedIssuer && raw.issuer !== expectedIssuer.replace(/\/$/, '')) {
    throw new Error(`Auth0 issuer mismatch: expected ${expectedIssuer}, got ${String(raw.issuer)}`);
  }
  const expectedOrigin = new URL(expectedIssuer).origin;
  const authorizationEndpoint = validatedAuth0Endpoint(
    raw.authorization_endpoint,
    'authorization_endpoint',
    expectedOrigin
  );
  const tokenEndpoint = validatedAuth0Endpoint(raw.token_endpoint, 'token_endpoint', expectedOrigin);
  const jwksUri = validatedAuth0Endpoint(raw.jwks_uri, 'jwks_uri', expectedOrigin);
  const registrationEndpoint =
    raw.registration_endpoint === undefined
      ? undefined
      : validatedAuth0Endpoint(raw.registration_endpoint, 'registration_endpoint', expectedOrigin);
  const pkce = Array.isArray(raw.code_challenge_methods_supported)
    ? raw.code_challenge_methods_supported.filter((item): item is string => typeof item === 'string')
    : [];
  if (!pkce.includes('S256')) throw new Error('Auth0 discovery does not advertise PKCE S256');
  if (registration === 'dcr' && !registrationEndpoint) {
    throw new Error('Quick mode requires an Auth0 dynamic client registration endpoint');
  }
  const tokenMethods = Array.isArray(raw.token_endpoint_auth_methods_supported)
    ? raw.token_endpoint_auth_methods_supported.filter((item): item is string => typeof item === 'string')
    : undefined;
  if (tokenMethods && !tokenMethods.some((method) => method === 'none' || method === 'private_key_jwt')) {
    throw new Error('Auth0 token endpoint does not advertise a ChatGPT-compatible client authentication method');
  }
  return {
    issuer: String(raw.issuer),
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    jwks_uri: jwksUri,
    ...(registrationEndpoint ? { registration_endpoint: registrationEndpoint } : {}),
    code_challenge_methods_supported: pkce,
    ...(tokenMethods ? { token_endpoint_auth_methods_supported: tokenMethods } : {}),
  };
}

function apiScopes(api: Auth0Api): string[] {
  return (api.scopes ?? [])
    .map((scope) => scope.value)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

async function listAuth0Apis(tenant: string): Promise<Auth0Api[]> {
  const result = await runCommand(
    'auth0',
    ['apis', 'list', '--json-compact', '--no-color', '--no-input', '--tenant', tenant],
    { timeoutMs: 30_000 }
  );
  if (result.exitCode !== 0) throw new Error(`Unable to list Auth0 APIs: ${result.stderr.trim()}`);
  return jsonDocumentFromOutput<Auth0Api[]>(`${result.stdout}\n${result.stderr}`);
}

async function showAuth0Api(tenant: string, idOrIdentifier: string): Promise<Auth0Api> {
  const result = await runCommand(
    'auth0',
    ['apis', 'show', idOrIdentifier, '--json-compact', '--no-color', '--no-input', '--tenant', tenant],
    { timeoutMs: 30_000 }
  );
  if (result.exitCode !== 0) throw new Error(`Unable to inspect Auth0 API: ${result.stderr.trim()}`);
  return jsonDocumentFromOutput<Auth0Api>(`${result.stdout}\n${result.stderr}`);
}

async function provisionAuth0Api(
  tenant: string,
  resource: string,
  dryRun: boolean
): Promise<{ api: Auth0Api; created: boolean; changed: boolean }> {
  const apis = await listAuth0Apis(tenant);
  const existing = apis.find((api) => api.identifier === resource);
  const desiredScopes = [...DEFAULT_SCOPES];
  if (!existing) {
    if (dryRun) {
      return {
        api: { name: 'FolderForge MCP', identifier: resource, scopes: desiredScopes.map((value) => ({ value })) },
        created: false,
        changed: true,
      };
    }
    const result = await runCommand(
      'auth0',
      [
        'apis',
        'create',
        '--name',
        'FolderForge MCP',
        '--identifier',
        resource,
        '--scopes',
        desiredScopes.join(','),
        '--signing-alg',
        'RS256',
        '--token-dialect',
        'rfc9068_profile',
        '--token-lifetime',
        '3600',
        '--offline-access=false',
        '--json-compact',
        '--no-color',
        '--no-input',
        '--tenant',
        tenant,
      ],
      { timeoutMs: 45_000 }
    );
    if (result.exitCode !== 0) throw new Error(`Unable to create Auth0 API: ${result.stderr.trim()}`);
    return { api: jsonDocumentFromOutput<Auth0Api>(`${result.stdout}\n${result.stderr}`), created: true, changed: true };
  }

  const current = await showAuth0Api(tenant, existing.id ?? resource);
  const apiId = current.id ?? existing.id;
  if (!apiId) throw new Error('Auth0 API lookup returned no resource-server id');
  const scopeDescriptions: Record<(typeof DEFAULT_SCOPES)[number], string> = {
    'folderforge:read': 'Read FolderForge MCP tools',
    'folderforge:write': 'Use mutating FolderForge MCP tools',
  };
  const mergedScopes = (current.scopes ?? [])
    .filter((scope): scope is { value: string; description?: string } =>
      typeof scope.value === 'string' && scope.value.length > 0
    )
    .map((scope) => ({
      value: scope.value,
      ...(typeof scope.description === 'string' ? { description: scope.description } : {}),
    }));
  const existingScopeValues = new Set(mergedScopes.map((scope) => scope.value));
  for (const scope of desiredScopes) {
    if (existingScopeValues.has(scope)) continue;
    mergedScopes.push({ value: scope, description: scopeDescriptions[scope] });
  }
  const needsUpdate =
    desiredScopes.some((scope) => !existingScopeValues.has(scope)) ||
    current.signing_alg !== 'RS256' ||
    current.token_dialect !== 'rfc9068_profile' ||
    current.token_lifetime !== 3600 ||
    current.allow_offline_access !== false;
  if (!needsUpdate || dryRun) return { api: current, created: false, changed: needsUpdate };

  const result = await runCommand(
    'auth0',
    [
      'api',
      'patch',
      `resource-servers/${encodeURIComponent(apiId)}`,
      '--data',
      JSON.stringify({
        scopes: mergedScopes,
        signing_alg: 'RS256',
        token_dialect: 'rfc9068_profile',
        token_lifetime: 3600,
        allow_offline_access: false,
      }),
      '--no-color',
      '--no-input',
      '--tenant',
      tenant,
    ],
    { timeoutMs: 45_000 }
  );
  if (result.exitCode !== 0) throw new Error(`Unable to update Auth0 API: ${result.stderr.trim()}`);
  return { api: await showAuth0Api(tenant, apiId), created: false, changed: true };
}

function isPidAlive(pid?: number): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopPid(pid?: number): boolean {
  if (!isPidAlive(pid)) return false;
  try {
    process.kill(pid!, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

function startDetached(command: string, args: string[], cwd: string, logPath: string): number {
  mkdirSync(dirname(logPath), { recursive: true });
  const outputFd = openSync(logPath, 'a', 0o600);
  try {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', outputFd, outputFd],
    });
    if (!child.pid) throw new Error(`Unable to start ${basename(command)}`);
    child.unref();
    return child.pid;
  } finally {
    closeSync(outputFd);
  }
}

async function startQuickTunnel(projectRoot: string, port: number, logPath: string): Promise<{ pid: number; mcpUrl: string }> {
  writeFileSync(logPath, '', { mode: 0o600 });
  const pid = startDetached(
    'cloudflared',
    ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
    projectRoot,
    logPath
  );
  const deadline = Date.now() + 25_000;
  const pattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) break;
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    const match = log.match(pattern);
    if (match?.[0]) return { pid, mcpUrl: normalizeMcpUrl(match[0]) };
    await sleep(250);
  }
  stopPid(pid);
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-4_000) : '';
  throw new Error(`Cloudflare quick tunnel did not become ready. ${log}`.trim());
}

function generatedConfig(receipt: Pick<ChatGptConnectionReceipt, 'resource' | 'issuer' | 'scopes' | 'registration'>, host: string, port: number): string {
  return YAML.stringify({
    server: {
      transport: 'http',
      http: {
        host,
        port,
        auth: {
          mode: 'oauth',
          oauth: {
            resource: receipt.resource,
            issuer: receipt.issuer,
            scopes: receipt.scopes,
            readScope: DEFAULT_SCOPES[0],
            writeScope: DEFAULT_SCOPES[1],
            clientRegistration: receipt.registration,
            algorithms: ['RS256'],
            requestTimeoutMs: 5000,
          },
        },
      },
    },
  });
}

function secretSafeReceipt(receipt: ChatGptConnectionReceipt): void {
  const serialized = JSON.stringify(receipt);
  const normalizeKey = (key: string): string => key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const forbiddenKeys = new Set([
    'accesstoken',
    'refreshtoken',
    'authorizationcode',
    'clientsecret',
    'managementapitoken',
    'pkceverifier',
    'bearertoken',
    'apikey',
    'password',
    'cookie',
    'privatekey',
  ]);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(normalizeKey(key))) {
        throw new Error(`Connection receipt contains forbidden secret field: ${key}`);
      }
      visit(child);
    }
  };
  visit(receipt);
  if (/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(serialized)) {
    throw new Error('Connection receipt appears to contain a JWT');
  }
}

export function writeConnectionReceipt(path: string, receipt: ChatGptConnectionReceipt): void {
  secretSafeReceipt(receipt);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readConnectionReceipt(path: string): ChatGptConnectionReceipt {
  const value = JSON.parse(readFileSync(path, 'utf8')) as ChatGptConnectionReceipt;
  if (value.version !== RECEIPT_VERSION || value.provider !== 'auth0') {
    throw new Error(`Unsupported ChatGPT connection receipt at ${path}`);
  }
  secretSafeReceipt(value);
  return value;
}

function acquireLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  const attempt = (): number => {
    try {
      return openSync(path, 'wx', 0o600);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      let stale = true;
      try {
        const pid = Number(readFileSync(path, 'utf8').trim());
        stale = !isPidAlive(pid);
      } catch {
        stale = true;
      }
      if (!stale) throw new Error('Another FolderForge ChatGPT operation is already running');
      unlinkSync(path);
      return openSync(path, 'wx', 0o600);
    }
  };
  const fd = attempt();
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  return () => {
    try {
      unlinkSync(path);
    } catch {
      // Best-effort cleanup; a stale lock is detected on the next invocation.
    }
  };
}

async function waitForUrl(url: string, predicate: (response: Response) => boolean, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
      if (predicate(response)) return response;
      lastError = new Error(`${url} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(400);
  }
  throw new Error(lastError instanceof Error ? lastError.message : `Timed out waiting for ${url}`);
}

async function verifyJwks(metadata: AuthorizationMetadata): Promise<void> {
  const jwks = await fetchJson(metadata.jwks_uri);
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) throw new Error('Auth0 JWKS contains no signing keys');
}

async function verifyEndpoint(receipt: ChatGptConnectionReceipt, timeoutMs = 35_000): Promise<void> {
  const metadataResponse = await waitForUrl(receipt.metadataUrl, (response) => response.status === 200, timeoutMs);
  const metadata = (await metadataResponse.json()) as Record<string, unknown>;
  if (metadata.resource !== receipt.resource) throw new Error('Protected-resource metadata resource does not match the receipt');
  if (!Array.isArray(metadata.authorization_servers) || !metadata.authorization_servers.includes(receipt.issuer.replace(/\/$/, ''))) {
    throw new Error('Protected-resource metadata does not advertise the configured issuer');
  }
  const response = await fetch(receipt.mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 401) throw new Error(`Unauthenticated MCP request returned HTTP ${response.status}, expected 401`);
  const challenge = response.headers.get('www-authenticate') ?? '';
  if (!challenge.includes(`resource_metadata="${receipt.metadataUrl}"`) || !challenge.includes(DEFAULT_SCOPES[0])) {
    throw new Error('WWW-Authenticate is missing the resource metadata URL or read scope');
  }
}

function startServer(receipt: ChatGptConnectionReceipt, host: string, port: number): number {
  if (isPidAlive(receipt.processes.serverPid)) return receipt.processes.serverPid!;
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(`Built FolderForge CLI not found at ${CLI_ENTRY}. Run \`npm run build\` and retry.`);
  }
  return startDetached(
    process.execPath,
    [
      CLI_ENTRY,
      '--project',
      receipt.projectRoot,
      '--config',
      receipt.configPath,
      '--http',
      '--host',
      host,
      '--port',
      String(port),
      '--no-dashboard',
    ],
    receipt.projectRoot,
    receipt.processes.serverLog
  );
}

async function chooseMode(nonInteractive: boolean): Promise<ChatGptMode> {
  if (nonInteractive || !input.isTTY || !output.isTTY) return 'quick';
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      'How will you use FolderForge?\n\n1. Personal testing — easiest\n2. Team or production — stable URL and predefined client\n\nChoose 1 or 2: '
    );
    return answer.trim() === '2' ? 'secure' : 'quick';
  } finally {
    rl.close();
  }
}

function existingReceipt(projectRoot: string): ChatGptConnectionReceipt | undefined {
  const path = receiptPaths(projectRoot).receipt;
  if (!existsSync(path)) return undefined;
  try {
    return readConnectionReceipt(path);
  } catch {
    return undefined;
  }
}

async function connect(options: ParsedOptions, sink: ProgressSink): Promise<ChatGptConnectionReceipt> {
  const paths = receiptPaths(options.projectRoot);
  if (!existsSync(options.projectRoot)) throw new Error(`Project does not exist: ${options.projectRoot}`);
  if (!options.dryRun) mkdirSync(paths.stateDir, { recursive: true });
  const releaseLock = options.dryRun ? () => undefined : acquireLock(paths.lock);
  const startedPids: number[] = [];
  try {
    const mode = options.mode ?? (await chooseMode(options.json));
    const registration: RegistrationStrategy = mode === 'quick' ? 'dcr' : 'predefined';
    if (mode === 'secure' && !options.publicUrl) {
      throw new Error('Secure mode requires --public-url https://your-stable-host.example/mcp');
    }

    const auth0Version = await requireCommand('auth0');
    sink.line(`✓ Auth0 CLI detected (${auth0Version})`);
    if (mode === 'quick' && !options.publicUrl && options.tunnel === 'cloudflared') {
      const cloudflaredVersion = await requireCommand('cloudflared');
      sink.line(`✓ Cloudflare Tunnel detected (${cloudflaredVersion})`);
    }

    const tenant = await activeAuth0Tenant(options.tenant);
    sink.line(`✓ Auth0 tenant selected (${tenant})`);
    const discovery = await discoverAuth0(tenant, registration);
    sink.line('✓ Auth0 issuer and PKCE S256 metadata verified');
    await verifyJwks(discovery);
    sink.line('✓ Auth0 JWKS verified');

    const previous = existingReceipt(options.projectRoot);
    let mcpUrl: string;
    let tunnelPid: number | undefined;
    let connectivityKind: ChatGptConnectionReceipt['connectivity']['kind'];
    const warnings: string[] = [];

    if (options.publicUrl) {
      mcpUrl = normalizeMcpUrl(options.publicUrl);
      connectivityKind = 'stable-url';
    } else if (
      previous?.mode === 'quick' &&
      previous.connectivity.kind === 'cloudflared-quick' &&
      isPidAlive(previous.processes.tunnelPid)
    ) {
      mcpUrl = previous.mcpUrl;
      tunnelPid = previous.processes.tunnelPid;
      connectivityKind = 'cloudflared-quick';
      warnings.push('Quick tunnel URLs are temporary. Use --secure with a stable public URL for team or production use.');
      sink.line('✓ Existing Cloudflare quick tunnel reused');
    } else if (mode === 'quick' && options.tunnel === 'cloudflared') {
      if (options.dryRun) {
        throw new Error('Dry-run quick mode needs --public-url because a temporary tunnel URL cannot be predicted safely');
      }
      const tunnel = await startQuickTunnel(options.projectRoot, options.port, paths.tunnelLog);
      tunnelPid = tunnel.pid;
      startedPids.push(tunnel.pid);
      mcpUrl = tunnel.mcpUrl;
      connectivityKind = 'cloudflared-quick';
      warnings.push('Quick mode uses an open DCR-compatible flow and a temporary tunnel URL. Do not use it for production.');
      sink.line(`✓ Temporary secure tunnel ready (${new URL(mcpUrl).origin})`);
    } else {
      throw new Error('No public connectivity is configured. Provide --public-url or use --quick --tunnel cloudflared.');
    }

    const resource = mcpUrl;
    const metadataUrl = metadataUrlFor(resource);
    const provisioned = await provisionAuth0Api(tenant, resource, options.dryRun);
    sink.line(
      provisioned.created
        ? '✓ FolderForge API created in Auth0'
        : provisioned.changed
          ? options.dryRun
            ? '• FolderForge Auth0 API would be created or updated'
            : '✓ FolderForge API updated in Auth0'
          : '✓ Existing FolderForge API reused without changes'
    );
    sink.line('✓ OAuth scopes configured');

    const now = new Date().toISOString();
    const receipt: ChatGptConnectionReceipt = {
      version: RECEIPT_VERSION,
      status: options.start ? 'configured' : mode === 'secure' && !options.clientId ? 'action_required' : 'configured',
      provider: 'auth0',
      mode,
      registration,
      tenant,
      issuer: discovery.issuer,
      resource,
      mcpUrl,
      metadataUrl,
      scopes: [...DEFAULT_SCOPES],
      projectRoot: options.projectRoot,
      configPath: paths.config,
      ...(options.clientId ? { clientId: options.clientId } : {}),
      auth0: {
        ...(provisioned.api.id ? { apiId: provisioned.api.id } : {}),
        apiName: provisioned.api.name ?? 'FolderForge MCP',
        createdByFolderForge: provisioned.created || previous?.auth0.createdByFolderForge === true,
      },
      connectivity: {
        kind: connectivityKind,
        publicUrl: new URL(mcpUrl).origin,
        localUrl: `${localUrl(options.host, options.port)}/mcp`,
        ...(connectivityKind === 'cloudflared-quick'
          ? { warning: 'Temporary URL: if the tunnel stops, run `folderforge chatgpt repair --quick` and reconnect ChatGPT.' }
          : {}),
      },
      processes: {
        ...(previous?.processes.serverPid && isPidAlive(previous.processes.serverPid)
          ? { serverPid: previous.processes.serverPid }
          : {}),
        ...(tunnelPid ? { tunnelPid } : {}),
        serverLog: paths.serverLog,
        ...(connectivityKind === 'cloudflared-quick' ? { tunnelLog: paths.tunnelLog } : {}),
      },
      checks: {
        dependencies: 'pass',
        tenant: 'pass',
        issuerDiscovery: 'pass',
        auth0Api: options.dryRun ? 'pending' : 'pass',
        resourceMetadata: options.start ? 'pending' : 'not_run',
        unauthorizedChallenge: options.start ? 'pending' : 'not_run',
        jwks: 'pass',
        tokenValidation: 'pending_user_login',
        mcpInitialize: 'pending_user_login',
      },
      warnings,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };

    if (!options.dryRun) {
      writeFileSync(paths.config, generatedConfig(receipt, options.host, options.port), { mode: 0o600 });
      chmodSync(paths.config, 0o600);
      sink.line(`✓ FolderForge OAuth config written (${paths.config})`);
    }

    if (options.start && !options.dryRun) {
      const serverPid = startServer(receipt, options.host, options.port);
      if (!receipt.processes.serverPid) startedPids.push(serverPid);
      receipt.processes.serverPid = serverPid;
      await waitForUrl(`${localUrl(options.host, options.port)}/healthz`, (response) => response.status === 200, 20_000);
      sink.line('✓ FolderForge HTTP MCP started');
      await verifyEndpoint(receipt);
      receipt.checks.resourceMetadata = 'pass';
      receipt.checks.unauthorizedChallenge = 'pass';
      sink.line('✓ MCP resource metadata verified');
      sink.line('✓ 401 WWW-Authenticate challenge verified');
      receipt.status = mode === 'secure' && !options.clientId ? 'action_required' : 'ready';
    }

    if (options.dryRun) {
      receipt.status = mode === 'secure' && !options.clientId ? 'action_required' : 'configured';
      sink.line('• Dry run complete; no Auth0 or local files were changed');
      return receipt;
    }

    writeConnectionReceipt(paths.receipt, receipt);
    sink.line(`✓ Secret-free connection receipt written (${paths.receipt})`);
    return receipt;
  } catch (error) {
    for (const pid of startedPids.reverse()) stopPid(pid);
    throw error;
  } finally {
    releaseLock();
  }
}

async function status(options: ParsedOptions, sink: ProgressSink): Promise<ChatGptConnectionReceipt> {
  const paths = receiptPaths(options.projectRoot);
  if (!existsSync(paths.receipt)) throw new Error('No ChatGPT connection receipt found. Run `folderforge connect chatgpt`.');
  const receipt = readConnectionReceipt(paths.receipt);
  const serverAlive = isPidAlive(receipt.processes.serverPid);
  const tunnelAlive = receipt.connectivity.kind !== 'cloudflared-quick' || isPidAlive(receipt.processes.tunnelPid);
  sink.line(`${serverAlive ? '✓' : '✗'} FolderForge server ${serverAlive ? 'is running' : 'is stopped'}`);
  if (receipt.connectivity.kind === 'cloudflared-quick') {
    sink.line(`${tunnelAlive ? '✓' : '✗'} Cloudflare quick tunnel ${tunnelAlive ? 'is running' : 'is stopped'}`);
  }
  try {
    await verifyEndpoint(receipt, 10_000);
    receipt.checks.resourceMetadata = 'pass';
    receipt.checks.unauthorizedChallenge = 'pass';
    sink.line('✓ Public OAuth metadata and 401 challenge are reachable');
  } catch (error) {
    receipt.checks.resourceMetadata = 'fail';
    receipt.checks.unauthorizedChallenge = 'fail';
    sink.line(`✗ Public endpoint verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  receipt.status =
    serverAlive && tunnelAlive && receipt.checks.resourceMetadata === 'pass'
      ? receipt.mode === 'secure' && !receipt.clientId
        ? 'action_required'
        : 'ready'
      : 'stopped';
  receipt.updatedAt = new Date().toISOString();
  writeConnectionReceipt(paths.receipt, receipt);
  return receipt;
}

async function doctor(options: ParsedOptions, sink: ProgressSink): Promise<ChatGptConnectionReceipt | undefined> {
  const auth0Version = await requireCommand('auth0');
  sink.line(`✓ Auth0 CLI detected (${auth0Version})`);
  const tenant = await activeAuth0Tenant(options.tenant);
  sink.line(`✓ Active Auth0 tenant detected (${tenant})`);
  const discovery = await discoverAuth0(tenant, options.mode === 'secure' ? 'predefined' : 'dcr');
  sink.line('✓ Auth0 discovery, issuer and PKCE S256 verified');
  await verifyJwks(discovery);
  sink.line('✓ Auth0 JWKS verified');
  const existing = existingReceipt(options.projectRoot);
  if (!existing) {
    sink.line('• No connection receipt exists yet');
    return undefined;
  }
  sink.line('✓ Connection receipt is readable and contains no known secret fields');
  return await status(options, sink);
}

async function startFromReceipt(options: ParsedOptions, sink: ProgressSink): Promise<ChatGptConnectionReceipt> {
  const paths = receiptPaths(options.projectRoot);
  const releaseLock = acquireLock(paths.lock);
  try {
    const receipt = readConnectionReceipt(paths.receipt);
    if (receipt.connectivity.kind === 'cloudflared-quick' && !isPidAlive(receipt.processes.tunnelPid)) {
      throw new Error('The temporary tunnel URL cannot be reclaimed. Run `folderforge chatgpt repair --quick`.');
    }
    const config = YAML.parse(readFileSync(receipt.configPath, 'utf8')) as {
      server?: { http?: { host?: string; port?: number } };
    };
    const host = config.server?.http?.host ?? DEFAULT_HOST;
    const port = config.server?.http?.port ?? DEFAULT_PORT;
    const pid = startServer(receipt, host, port);
    receipt.processes.serverPid = pid;
    await waitForUrl(`${localUrl(host, port)}/healthz`, (response) => response.status === 200, 20_000);
    await verifyEndpoint(receipt);
    receipt.checks.resourceMetadata = 'pass';
    receipt.checks.unauthorizedChallenge = 'pass';
    receipt.status = receipt.mode === 'secure' && !receipt.clientId ? 'action_required' : 'ready';
    receipt.updatedAt = new Date().toISOString();
    writeConnectionReceipt(paths.receipt, receipt);
    sink.line('✓ FolderForge server started and public OAuth metadata verified');
    return receipt;
  } finally {
    releaseLock();
  }
}

async function stopConnection(options: ParsedOptions, sink: ProgressSink): Promise<ChatGptConnectionReceipt> {
  const paths = receiptPaths(options.projectRoot);
  const releaseLock = acquireLock(paths.lock);
  try {
    const receipt = readConnectionReceipt(paths.receipt);
    const serverStopped = stopPid(receipt.processes.serverPid);
    const tunnelStopped = stopPid(receipt.processes.tunnelPid);
    sink.line(serverStopped ? '✓ FolderForge server stop signal sent' : '• FolderForge server was not running');
    if (receipt.connectivity.kind === 'cloudflared-quick') {
      sink.line(tunnelStopped ? '✓ Cloudflare tunnel stop signal sent' : '• Cloudflare tunnel was not running');
    }
    delete receipt.processes.serverPid;
    delete receipt.processes.tunnelPid;
    receipt.status = 'stopped';
    receipt.updatedAt = new Date().toISOString();
    writeConnectionReceipt(paths.receipt, receipt);
    return receipt;
  } finally {
    releaseLock();
  }
}

async function disconnect(options: ParsedOptions, sink: ProgressSink): Promise<ChatGptConnectionReceipt> {
  if (options.purgeLocal && !options.yes) {
    throw new Error('--purge-local requires --yes to avoid accidental data loss');
  }
  const receipt = await stopConnection(options, sink);
  const paths = receiptPaths(options.projectRoot);
  receipt.status = 'disconnected';
  receipt.updatedAt = new Date().toISOString();
  sink.line('✓ Local ChatGPT connection marked disconnected');
  sink.line('• Auth0 resources were preserved. FolderForge never deletes remote Auth0 resources automatically.');
  if (options.purgeLocal) {
    for (const path of [paths.config, paths.serverLog, paths.tunnelLog]) {
      rmSync(path, { force: true });
    }
    sink.line('✓ Generated local config and log files removed');
  }
  writeConnectionReceipt(paths.receipt, receipt);
  return receipt;
}

async function repair(options: ParsedOptions, sink: ProgressSink): Promise<ChatGptConnectionReceipt> {
  const previous = existingReceipt(options.projectRoot);
  if (!previous) throw new Error('No previous connection exists. Run `folderforge connect chatgpt`.');
  sink.line('• Rechecking dependencies, Auth0 configuration, local config and endpoint health');
  const stablePublicUrl =
    options.publicUrl ?? (previous.connectivity.kind === 'stable-url' ? previous.mcpUrl : undefined);
  const clientId = options.clientId ?? previous.clientId;
  return await connect(
    {
      ...options,
      action: 'connect',
      mode: options.mode ?? previous.mode,
      tenant: options.tenant ?? previous.tenant,
      ...(stablePublicUrl ? { publicUrl: stablePublicUrl } : {}),
      ...(clientId ? { clientId } : {}),
    },
    sink
  );
}

function finalHumanOutput(receipt: ChatGptConnectionReceipt): string[] {
  const statusLabel =
    receipt.status === 'ready'
      ? 'READY TO CONNECT'
      : receipt.status === 'action_required'
        ? 'ACTION REQUIRED'
        : receipt.status.toUpperCase().replace(/_/g, ' ');
  const lines = [
    '',
    'MCP URL:',
    receipt.mcpUrl,
    '',
    'Authentication:',
    'OAuth',
    '',
    'Registration:',
    receipt.registration === 'dcr' ? 'Dynamic Client Registration (quick mode)' : 'Predefined OAuth client',
    '',
    'Status:',
    statusLabel,
  ];
  if (receipt.status === 'action_required') {
    lines.push(
      '',
      'Minimum user action:',
      'Create/select a predefined Auth0 OAuth client using the exact ChatGPT redirect URI shown in ChatGPT,',
      'then run `folderforge chatgpt repair --secure --client-id <client-id>`.'
    );
  }
  if (receipt.status === 'ready') {
    lines.push(
      '',
      'ChatGPT:',
      'Open Settings → Security and login → enable Developer mode, then Settings → Plugins → + and enter the MCP URL above.'
    );
  }
  if (receipt.warnings.length > 0) {
    lines.push('', 'Warnings:', ...receipt.warnings.map((warning) => `- ${warning}`));
  }
  return lines;
}

export async function executeChatGptCli(
  argv: string[],
  options: { cwd?: string; onLine?: (line: string) => void } = {}
): Promise<ChatGptCliResult> {
  const sink = progressSink(options.onLine);
  try {
    const parsed = parseChatGptArgs(argv, options.cwd);
    let receipt: ChatGptConnectionReceipt | undefined;
    switch (parsed.action) {
      case 'connect':
        receipt = await connect(parsed, sink);
        break;
      case 'status':
        receipt = await status(parsed, sink);
        break;
      case 'doctor':
        receipt = await doctor(parsed, sink);
        break;
      case 'repair':
        receipt = await repair(parsed, sink);
        break;
      case 'start':
        receipt = await startFromReceipt(parsed, sink);
        break;
      case 'stop':
        receipt = await stopConnection(parsed, sink);
        break;
      case 'disconnect':
        receipt = await disconnect(parsed, sink);
        break;
    }
    if (parsed.json) {
      return {
        exitCode: receipt?.status === 'error' ? 1 : 0,
        output: receipt ? `${JSON.stringify(receipt, null, 2)}\n` : `${JSON.stringify({ ok: true }, null, 2)}\n`,
        ...(receipt ? { receipt } : {}),
      };
    }
    if (receipt) for (const line of finalHumanOutput(receipt)) sink.line(line);
    return { exitCode: 0, output: sink.output(), ...(receipt ? { receipt } : {}) };
  } catch (error) {
    if (error instanceof Error && error.message === 'HELP') {
      return { exitCode: 0, output: chatGptHelp() };
    }
    const message = error instanceof Error ? error.message : String(error);
    sink.line(`✗ ${message}`);
    return { exitCode: 1, output: sink.output() };
  }
}
