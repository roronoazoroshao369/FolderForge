import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { createServer as createNetServer } from "node:net";
import { stdin as input, stdout as output } from "node:process";
import YAML from "yaml";
import {
  ChatGptAuth0Error,
  countAuth0Applications,
  deleteChatGptDcrClient,
  ensureDefaultThirdPartyUserGrant,
  ensureLoginConnections,
  ensureUserClientGrant,
  getAuth0Client,
  isChatGptDcrClient,
  listAuth0Clients,
  planChatGptDcrPrune,
  validateChatGptClientForResource,
  verifyAuthorizeEndpoint,
  waitForChatGptClient,
} from "./auth0-management.js";
import {
  CHATGPT_LIFECYCLE_STAGES,
  classifyChatGptError,
  deriveChatGptLifecycle,
  redactSensitiveText,
  type ChatGptDiagnostic,
  type ChatGptDiagnosticStatus,
  type ChatGptErrorState,
  type ChatGptLifecycleRecord,
  type ChatGptLifecycleSnapshot,
  type ChatGptLifecycleStage,
} from "./lifecycle.js";

const DEFAULT_PORT = 7331;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_SCOPES = ["folderforge:read", "folderforge:write"] as const;
const RECEIPT_VERSION = 2;
const MAX_COMMAND_OUTPUT = 1024 * 1024;
const CLI_ENTRY = fileURLToPath(new URL("../main.js", import.meta.url));

export type ChatGptMode = "quick" | "secure";
export type RegistrationStrategy = "dcr" | "predefined";
export type CheckState =
  "pass" | "pending" | "pending_user_login" | "fail" | "not_run";
export type ChatGptPolicyMode = "readonly" | "safe" | "dev" | "danger";
export type ChatGptToolsPreset =
  "vibe" | "vibe-lite" | "readonly" | "full" | "godot";
export type ChatGptProfile = "safe" | "developer" | "full";
export type DcrClientPolicy = "allow-all" | "require-grant";
export type ChatGptAdapter =
  "playwright" | "serena" | "desktop-commander" | "godot";

export interface ChatGptRuntimeSettings {
  profile: ChatGptProfile;
  policyMode: ChatGptPolicyMode;
  toolsPreset: ChatGptToolsPreset;
  adapters: ChatGptAdapter[];
  dashboard: boolean;
  dashboardPort: number;
  offlineAccess: boolean;
  dcrClientPolicy: DcrClientPolicy;
  autoEnableDcr: boolean;
  loginConnections: string[];
}

export interface ChatGptConnectionReceipt {
  version: number;
  status:
    | "configured"
    | "waiting"
    | "ready"
    | "connected"
    | "needs_attention"
    | "action_required"
    | "stopped"
    | "disconnected"
    | "error";
  provider: "auth0";
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
    kind: "stable-url" | "cloudflared-quick";
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
    dcr: CheckState;
    auth0Api: CheckState;
    localServer: CheckState;
    publicEndpoint: CheckState;
    resourceMetadata: CheckState;
    unauthorizedChallenge: CheckState;
    jwks: CheckState;
    chatgptClient: CheckState;
    loginConnections: CheckState;
    userGrant: CheckState;
    authorize: CheckState;
    tokenValidation: CheckState;
    mcpInitialize: CheckState;
  };
  lifecycle?: ChatGptLifecycleRecord;
  lifecycleSnapshot?: ChatGptLifecycleSnapshot;
  warnings: string[];
  runtime?: ChatGptRuntimeSettings;
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
  enforce_policies?: boolean;
  scopes?: Array<{ value?: string; description?: string }>;
  subject_type_authorization?: {
    user?: { policy?: "allow_all" | "require_client_grant" };
    client?: { policy?: "deny_all" | "require_client_grant" };
  };
}

interface ExistingChatGptConfig {
  profile?: ChatGptProfile;
  host?: string;
  port?: number;
  policyMode?: ChatGptPolicyMode;
  toolsPreset?: ChatGptToolsPreset;
  adapters?: ChatGptAdapter[];
  dashboard?: boolean;
  dashboardPort?: number;
}

interface ResolvedChatGptSettings extends ChatGptRuntimeSettings {
  host: string;
  port: number;
}

interface ParsedOptions {
  action:
    | "connect"
    | "status"
    | "doctor"
    | "repair"
    | "start"
    | "stop"
    | "disconnect"
    | "prune-dcr";
  mode?: ChatGptMode;
  projectRoot: string;
  publicUrl?: string;
  tunnel: "cloudflared" | "none";
  tenant?: string;
  clientId?: string;
  loginConnections: string[];
  waitForClient: boolean;
  waitTimeoutMs: number;
  pollIntervalMs: number;
  host?: string;
  port?: number;
  profile?: ChatGptProfile;
  policyMode?: ChatGptPolicyMode;
  toolsPreset?: ChatGptToolsPreset;
  adapters?: ChatGptAdapter[];
  dashboard?: boolean;
  dashboardPort?: number;
  offlineAccess?: boolean;
  dcrClientPolicy?: DcrClientPolicy;
  autoEnableDcr?: boolean;
  forceConfig: boolean;
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
      const safe = redactSensitiveText(message);
      lines.push(safe);
      onLine?.(safe);
    },
    output(): string {
      return `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
    },
  };
}

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return value;
}

function parseEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  flag: string,
): T {
  if (!allowed.includes(value as T))
    throw new Error(`${flag} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function parsePort(value: string, flag: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${flag} must be an integer from 1 to 65535`);
  }
  return port;
}

function parseAdapters(value: string): ChatGptAdapter[] {
  const normalized = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (normalized.length === 0 || normalized.includes("none")) return [];
  const expanded = normalized.includes("all")
    ? ["playwright", "serena", "desktop-commander", "godot"]
    : normalized;
  const aliases: Record<string, ChatGptAdapter> = {
    playwright: "playwright",
    serena: "serena",
    "desktop-commander": "desktop-commander",
    desktopcommander: "desktop-commander",
    godot: "godot",
  };
  const result: ChatGptAdapter[] = [];
  for (const item of expanded) {
    const adapter = aliases[item];
    if (!adapter)
      throw new Error(
        "--adapters accepts playwright, serena, desktop-commander, godot, all, or none",
      );
    if (!result.includes(adapter)) result.push(adapter);
  }
  return result;
}

export function parseChatGptArgs(
  argv: string[],
  cwd = process.cwd(),
): ParsedOptions {
  const actionRaw = argv[0] ?? "connect";
  const allowedActions = new Set([
    "connect",
    "status",
    "doctor",
    "repair",
    "start",
    "stop",
    "disconnect",
    "prune-dcr",
  ]);
  if (!allowedActions.has(actionRaw))
    throw new Error(`Unknown ChatGPT command: ${actionRaw}`);

  const options: ParsedOptions = {
    action: actionRaw as ParsedOptions["action"],
    projectRoot: resolve(cwd),
    tunnel: "cloudflared",
    loginConnections: [],
    waitForClient: true,
    waitTimeoutMs: 5 * 60_000,
    pollIntervalMs: 3_000,
    forceConfig: false,
    start: true,
    json: false,
    dryRun: false,
    purgeLocal: false,
    yes: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case "--quick":
        if (options.mode === "secure")
          throw new Error("Choose only one of --quick or --secure");
        options.mode = "quick";
        break;
      case "--secure":
        if (options.mode === "quick")
          throw new Error("Choose only one of --quick or --secure");
        options.mode = "secure";
        break;
      case "--project":
      case "-p":
        options.projectRoot = resolve(valueAfter(argv, index, arg));
        index += 1;
        break;
      case "--public-url":
        options.publicUrl = valueAfter(argv, index, arg);
        index += 1;
        break;
      case "--tunnel": {
        const value = valueAfter(argv, index, arg);
        if (value !== "cloudflared" && value !== "none") {
          throw new Error("--tunnel must be cloudflared or none");
        }
        options.tunnel = value;
        index += 1;
        break;
      }
      case "--tenant":
        options.tenant = valueAfter(argv, index, arg);
        index += 1;
        break;
      case "--client-id":
        options.clientId = valueAfter(argv, index, arg);
        index += 1;
        break;
      case "--login-connection":
        options.loginConnections.push(
          ...valueAfter(argv, index, arg)
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        );
        index += 1;
        break;
      case "--wait":
        options.waitForClient = true;
        break;
      case "--no-wait":
        options.waitForClient = false;
        break;
      case "--wait-timeout": {
        const seconds = Number(valueAfter(argv, index, arg));
        if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600)
          throw new Error("--wait-timeout must be 1-3600 seconds");
        options.waitTimeoutMs = Math.round(seconds * 1000);
        index += 1;
        break;
      }
      case "--poll-interval": {
        const seconds = Number(valueAfter(argv, index, arg));
        if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 60)
          throw new Error("--poll-interval must be 0.1-60 seconds");
        options.pollIntervalMs = Math.round(seconds * 1000);
        index += 1;
        break;
      }
      case "--host":
        options.host = valueAfter(argv, index, arg);
        index += 1;
        break;
      case "--port":
        options.port = parsePort(valueAfter(argv, index, arg), arg);
        index += 1;
        break;
      case "--profile":
        options.profile = parseEnum(
          valueAfter(argv, index, arg),
          ["safe", "developer", "full"] as const,
          arg,
        );
        index += 1;
        break;
      case "--full-access":
        options.profile = "full";
        break;
      case "--policy":
      case "--policy-mode":
        options.policyMode = parseEnum(
          valueAfter(argv, index, arg),
          ["readonly", "safe", "dev", "danger"] as const,
          arg,
        );
        index += 1;
        break;
      case "--tools-preset":
        options.toolsPreset = parseEnum(
          valueAfter(argv, index, arg),
          ["vibe", "vibe-lite", "readonly", "full", "godot"] as const,
          arg,
        );
        index += 1;
        break;
      case "--adapters":
        options.adapters = parseAdapters(valueAfter(argv, index, arg));
        index += 1;
        break;
      case "--dashboard":
        options.dashboard = true;
        break;
      case "--no-dashboard":
        options.dashboard = false;
        break;
      case "--dashboard-port":
        options.dashboardPort = parsePort(valueAfter(argv, index, arg), arg);
        index += 1;
        break;
      case "--offline-access":
        options.offlineAccess = true;
        break;
      case "--no-offline-access":
        options.offlineAccess = false;
        break;
      case "--dcr-client-policy":
        options.dcrClientPolicy = parseEnum(
          valueAfter(argv, index, arg),
          ["allow-all", "require-grant"] as const,
          arg,
        );
        index += 1;
        break;
      case "--auto-enable-dcr":
        options.autoEnableDcr = true;
        break;
      case "--no-auto-enable-dcr":
        options.autoEnableDcr = false;
        break;
      case "--force":
      case "--force-config":
        options.forceConfig = true;
        break;
      case "--no-start":
        options.start = false;
        break;
      case "--json":
        options.json = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        options.start = false;
        break;
      case "--purge-local":
        options.purgeLocal = true;
        break;
      case "--yes":
        options.yes = true;
        break;
      case "--help":
      case "-h":
        throw new Error("HELP");
      default:
        throw new Error(`Unknown ChatGPT option: ${arg}`);
    }
  }

  return options;
}

export function chatGptHelp(): string {
  return [
    "FolderForge ChatGPT OAuth connection",
    "",
    "Usage:",
    "  folderforge connect chatgpt [--quick|--secure] [options]",
    "  folderforge chatgpt <status|doctor|repair|start|stop|disconnect|prune-dcr> [options]",
    "",
    "Modes:",
    "  --quick                 Personal testing. Uses Auth0 DCR and, by default, a temporary Cloudflare quick tunnel.",
    "  --secure                Team/production. Requires a stable --public-url and normally a predefined OAuth client.",
    "",
    "Options:",
    "  -p, --project <dir>     Project to expose (default: current directory)",
    "      --public-url <url>  Stable public HTTPS MCP URL; /mcp is appended to an origin URL",
    "      --tunnel <kind>     cloudflared|none (default cloudflared in quick mode)",
    "      --tenant <domain>   Auth0 tenant override; otherwise uses the active Auth0 CLI tenant",
    "      --client-id <id>    Explicit existing ChatGPT DCR client for repair, predefined client in secure mode, or client to protect during prune-dcr",
    "      --login-connection <name> Auth0 connection to enable; repeat or comma-separate names",
    "      --wait/--no-wait     Wait for ChatGPT DCR registration after printing the MCP URL (default wait)",
    "      --wait-timeout <sec> DCR wait timeout, 1-3600 seconds (default 300)",
    "      --poll-interval <sec> DCR polling interval, 0.1-60 seconds (default 3)",
    "      --host <addr>       Local FolderForge bind host (default 127.0.0.1)",
    "      --port <n>          Local FolderForge port (default 7331)",
    "      --profile <id>      safe|developer|full (default developer)",
    "      --full-access       Shortcut for --profile full (danger policy + full built-in tools)",
    "      --policy <mode>     readonly|safe|dev|danger; persisted to YAML",
    "      --tools-preset <id> vibe|vibe-lite|readonly|full|godot; persisted to YAML",
    "      --adapters <list>   playwright,serena,desktop-commander,godot,all,none",
    "      --dashboard         Enable the local dashboard (disabled by default for ChatGPT)",
    "      --no-dashboard      Persistently disable the local dashboard",
    "      --dashboard-port <n> Local dashboard port (default 7332)",
    "      --offline-access    Allow refresh tokens (default for ChatGPT)",
    "      --no-offline-access Disable refresh-token issuance",
    "      --dcr-client-policy <id> allow-all|require-grant; quick default provisions a scoped third-party DCR user grant",
    "      --auto-enable-dcr   Enable Auth0 DCR automatically in quick mode (default)",
    "      --no-auto-enable-dcr Fail instead of changing the Auth0 DCR tenant flag",
    "      --force-config      Ignore prior runtime settings and rebuild generated YAML from CLI/defaults",
    "      --no-start          Configure Auth0 and generate local files without starting processes",
    "      --dry-run           Discover and validate only; do not change Auth0 or local files",
    "      --json              Machine-readable receipt/status output",
    "      --purge-local       With disconnect, remove generated config/log files after stopping",
    "      --yes               Confirm irreversible prune-dcr deletion or --purge-local without an interactive prompt",
    "",
    "FolderForge never stores Auth0 Management API tokens, OAuth access/refresh tokens, authorization codes,",
    "PKCE verifiers, client secrets, cookies, or API keys in the connection receipt.",
    "",
  ].join("\n");
}

function receiptPaths(projectRoot: string): {
  stateDir: string;
  receipt: string;
  config: string;
  lock: string;
  serverLog: string;
  tunnelLog: string;
} {
  const stateDir = join(projectRoot, ".folderforge");
  return {
    stateDir,
    receipt: join(stateDir, "chatgpt-connection.json"),
    config: join(stateDir, "chatgpt-config.yaml"),
    lock: join(stateDir, "chatgpt-connect.lock"),
    serverLog: join(stateDir, "chatgpt-server.log"),
    tunnelLog: join(stateDir, "chatgpt-tunnel.log"),
  };
}

function normalizeTenant(raw: string): string {
  const trimmed = raw.trim();
  const url = trimmed.includes("://")
    ? new URL(trimmed)
    : new URL(`https://${trimmed}`);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Invalid Auth0 tenant domain: ${raw}`);
  }
  return url.hostname.toLowerCase();
}

export function normalizeMcpUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:")
    throw new Error("The public MCP URL must use HTTPS");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "The public MCP URL must not contain userinfo, query parameters, or fragments",
    );
  }
  if (url.pathname === "" || url.pathname === "/") url.pathname = "/mcp";
  url.pathname = url.pathname.replace(/\/$/, "");
  if (!url.pathname.endsWith("/mcp")) {
    throw new Error(
      "The public MCP URL must end in /mcp (or be an origin URL so FolderForge can append it)",
    );
  }
  return url.href.replace(/\/$/, "");
}

function metadataUrlFor(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  const resourcePath =
    url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return new URL(
    `/.well-known/oauth-protected-resource${resourcePath}`,
    url.origin,
  ).href;
}

function localUrl(host: string, port: number): string {
  const normalizedHost =
    host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const bracketed =
    normalizedHost.includes(":") && !normalizedHost.startsWith("[")
      ? `[${normalizedHost}]`
      : normalizedHost;
  return `http://${bracketed}:${port}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return await new Promise<RunResult>((resolveRun, rejectRun) => {
    const auth0TestCli =
      command === "auth0" && process.env.NODE_ENV === "test"
        ? process.env.FOLDERFORGE_AUTH0_CLI_JS
        : undefined;
    const child = spawn(
      auth0TestCli ? process.execPath : command,
      auth0TestCli ? [auth0TestCli, ...args] : args,
      {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      rejectRun(
        new Error(
          `${basename(command)} timed out after ${options.timeoutMs ?? 30_000}ms`,
        ),
      );
    }, options.timeoutMs ?? 30_000);

    const append = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current, "utf8") >= MAX_COMMAND_OUTPUT)
        return current;
      return `${current}${chunk.toString("utf8")}`.slice(0, MAX_COMMAND_OUTPUT);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveRun({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function jsonDocumentFromOutput<T>(raw: string): T {
  const startCandidates = [raw.indexOf("{"), raw.indexOf("[")]
    .filter((value) => value >= 0)
    .sort((a, b) => a - b);
  for (const start of startCandidates) {
    const opening = raw[start];
    const closing = opening === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
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
  throw new Error("Command did not return a JSON document");
}

async function requireCommand(command: string): Promise<string> {
  const result = await runCommand(command, ["--version"], {
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `${command} is installed but unusable: ${result.stderr.trim()}`,
    );
  return (result.stdout || result.stderr).trim().split(/\r?\n/)[0] ?? command;
}

async function activeAuth0Tenant(override?: string): Promise<string> {
  const result = await runCommand(
    "auth0",
    ["tenants", "list", "--json-compact", "--no-color", "--no-input"],
    { timeoutMs: 20_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      "Auth0 CLI is not logged in. Run `auth0 login`, then retry `folderforge connect chatgpt`.",
    );
  }
  const tenants = jsonDocumentFromOutput<
    Array<{ active?: boolean; name?: string }>
  >(`${result.stdout}\n${result.stderr}`);
  const knownTenants = tenants
    .map((tenant) => tenant.name)
    .filter(
      (name): name is string => typeof name === "string" && name.length > 0,
    )
    .map(normalizeTenant);
  if (override) {
    const requested = normalizeTenant(override);
    if (!knownTenants.includes(requested)) {
      throw new Error(
        `Auth0 tenant ${requested} is not present in the authenticated Auth0 CLI tenant list. ` +
          "Run `auth0 login` or `auth0 tenants use <tenant-domain>` before retrying.",
      );
    }
    return requested;
  }
  const active = tenants.find((tenant) => tenant.active && tenant.name);
  if (!active?.name) {
    throw new Error(
      "No active Auth0 tenant. Run `auth0 tenants use <tenant-domain>` and retry.",
    );
  }
  return normalizeTenant(active.name);
}

async function fetchJson(
  url: string,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_COMMAND_OUTPUT) {
    throw new Error(
      `${url} returned metadata larger than ${MAX_COMMAND_OUTPUT} bytes`,
    );
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_COMMAND_OUTPUT) {
    throw new Error(
      `${url} returned metadata larger than ${MAX_COMMAND_OUTPUT} bytes`,
    );
  }
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${url} did not return a JSON object`);
  }
  return value as Record<string, unknown>;
}

function validatedAuth0Endpoint(
  value: unknown,
  field: string,
  expectedOrigin: string,
): string {
  if (typeof value !== "string" || !value)
    throw new Error(`Auth0 discovery is missing ${field}`);
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.origin !== expectedOrigin ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  ) {
    throw new Error(
      `Auth0 discovery ${field} must be an HTTPS URL on ${expectedOrigin}`,
    );
  }
  return endpoint.href;
}

async function discoverAuth0(
  tenant: string,
  registration: RegistrationStrategy,
  timeoutMs = 10_000,
): Promise<AuthorizationMetadata> {
  const url = `https://${tenant}/.well-known/openid-configuration`;
  const raw = await fetchJson(url, timeoutMs);
  const expectedIssuer = `https://${tenant}/`;
  if (
    raw.issuer !== expectedIssuer &&
    raw.issuer !== expectedIssuer.replace(/\/$/, "")
  ) {
    throw new Error(
      `Auth0 issuer mismatch: expected ${expectedIssuer}, got ${String(raw.issuer)}`,
    );
  }
  const expectedOrigin = new URL(expectedIssuer).origin;
  const authorizationEndpoint = validatedAuth0Endpoint(
    raw.authorization_endpoint,
    "authorization_endpoint",
    expectedOrigin,
  );
  const tokenEndpoint = validatedAuth0Endpoint(
    raw.token_endpoint,
    "token_endpoint",
    expectedOrigin,
  );
  const jwksUri = validatedAuth0Endpoint(
    raw.jwks_uri,
    "jwks_uri",
    expectedOrigin,
  );
  const registrationEndpoint =
    raw.registration_endpoint === undefined
      ? undefined
      : validatedAuth0Endpoint(
          raw.registration_endpoint,
          "registration_endpoint",
          expectedOrigin,
        );
  const pkce = Array.isArray(raw.code_challenge_methods_supported)
    ? raw.code_challenge_methods_supported.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  if (!pkce.includes("S256"))
    throw new Error("Auth0 discovery does not advertise PKCE S256");
  if (registration === "dcr" && !registrationEndpoint) {
    throw new Error(
      "Quick mode requires an Auth0 dynamic client registration endpoint",
    );
  }
  const tokenMethods = Array.isArray(raw.token_endpoint_auth_methods_supported)
    ? raw.token_endpoint_auth_methods_supported.filter(
        (item): item is string => typeof item === "string",
      )
    : undefined;
  if (
    tokenMethods &&
    !tokenMethods.some(
      (method) => method === "none" || method === "private_key_jwt",
    )
  ) {
    throw new Error(
      "Auth0 token endpoint does not advertise a ChatGPT-compatible client authentication method",
    );
  }
  return {
    issuer: String(raw.issuer),
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    jwks_uri: jwksUri,
    ...(registrationEndpoint
      ? { registration_endpoint: registrationEndpoint }
      : {}),
    code_challenge_methods_supported: pkce,
    ...(tokenMethods
      ? { token_endpoint_auth_methods_supported: tokenMethods }
      : {}),
  };
}

function apiScopes(api: Auth0Api): string[] {
  return (api.scopes ?? [])
    .map((scope) => scope.value)
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
}

async function listAuth0Apis(tenant: string): Promise<Auth0Api[]> {
  const result = await runCommand(
    "auth0",
    [
      "apis",
      "list",
      "--json-compact",
      "--no-color",
      "--no-input",
      "--tenant",
      tenant,
    ],
    { timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0)
    throw new Error(`Unable to list Auth0 APIs: ${result.stderr.trim()}`);
  return jsonDocumentFromOutput<Auth0Api[]>(
    `${result.stdout}\n${result.stderr}`,
  );
}

async function showAuth0Api(
  tenant: string,
  idOrIdentifier: string,
): Promise<Auth0Api> {
  const result = await runCommand(
    "auth0",
    [
      "apis",
      "show",
      idOrIdentifier,
      "--json-compact",
      "--no-color",
      "--no-input",
      "--tenant",
      tenant,
    ],
    { timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0)
    throw new Error(`Unable to inspect Auth0 API: ${result.stderr.trim()}`);
  return jsonDocumentFromOutput<Auth0Api>(`${result.stdout}\n${result.stderr}`);
}

async function provisionAuth0Api(
  tenant: string,
  resource: string,
  dryRun: boolean,
  offlineAccess: boolean,
  dcrClientPolicy: DcrClientPolicy,
): Promise<{ api: Auth0Api; created: boolean; changed: boolean }> {
  const apis = await listAuth0Apis(tenant);
  const existing = apis.find((api) => api.identifier === resource);
  const desiredScopes = [...DEFAULT_SCOPES];
  const subjectTypeAuthorization = desiredSubjectAuthorization(dcrClientPolicy);
  if (!existing) {
    if (dryRun) {
      return {
        api: {
          name: "FolderForge MCP",
          identifier: resource,
          scopes: desiredScopes.map((value) => ({ value })),
        },
        created: false,
        changed: true,
      };
    }
    const result = await runCommand(
      "auth0",
      [
        "apis",
        "create",
        "--name",
        "FolderForge MCP",
        "--identifier",
        resource,
        "--scopes",
        desiredScopes.join(","),
        "--signing-alg",
        "RS256",
        "--token-dialect",
        "rfc9068_profile",
        "--token-lifetime",
        "3600",
        `--offline-access=${offlineAccess ? "true" : "false"}`,
        "--enforce-policies",
        "--subject-type-authorization",
        JSON.stringify(subjectTypeAuthorization),
        "--json-compact",
        "--no-color",
        "--no-input",
        "--tenant",
        tenant,
      ],
      { timeoutMs: 45_000 },
    );
    if (result.exitCode !== 0)
      throw new Error(`Unable to create Auth0 API: ${result.stderr.trim()}`);
    return {
      api: jsonDocumentFromOutput<Auth0Api>(
        `${result.stdout}\n${result.stderr}`,
      ),
      created: true,
      changed: true,
    };
  }

  const current = await showAuth0Api(tenant, existing.id ?? resource);
  const apiId = current.id ?? existing.id;
  if (!apiId)
    throw new Error("Auth0 API lookup returned no resource-server id");
  const scopeDescriptions: Record<(typeof DEFAULT_SCOPES)[number], string> = {
    "folderforge:read": "Read FolderForge MCP tools",
    "folderforge:write": "Use mutating FolderForge MCP tools",
  };
  const mergedScopes = (current.scopes ?? [])
    .filter(
      (scope): scope is { value: string; description?: string } =>
        typeof scope.value === "string" && scope.value.length > 0,
    )
    .map((scope) => ({
      value: scope.value,
      ...(typeof scope.description === "string"
        ? { description: scope.description }
        : {}),
    }));
  const existingScopeValues = new Set(mergedScopes.map((scope) => scope.value));
  for (const scope of desiredScopes) {
    if (existingScopeValues.has(scope)) continue;
    mergedScopes.push({ value: scope, description: scopeDescriptions[scope] });
  }
  const currentSubject = current.subject_type_authorization;
  const needsUpdate =
    desiredScopes.some((scope) => !existingScopeValues.has(scope)) ||
    current.signing_alg !== "RS256" ||
    current.token_dialect !== "rfc9068_profile" ||
    current.token_lifetime !== 3600 ||
    current.allow_offline_access !== offlineAccess ||
    current.enforce_policies !== true ||
    currentSubject?.user?.policy !== subjectTypeAuthorization.user?.policy ||
    currentSubject?.client?.policy !== subjectTypeAuthorization.client?.policy;
  if (!needsUpdate || dryRun)
    return { api: current, created: false, changed: needsUpdate };

  const result = await runCommand(
    "auth0",
    [
      "api",
      "patch",
      `resource-servers/${encodeURIComponent(apiId)}`,
      "--data",
      JSON.stringify({
        scopes: mergedScopes,
        signing_alg: "RS256",
        token_dialect: "rfc9068_profile",
        token_lifetime: 3600,
        allow_offline_access: offlineAccess,
        enforce_policies: true,
        subject_type_authorization: subjectTypeAuthorization,
      }),
      "--no-color",
      "--no-input",
      "--tenant",
      tenant,
    ],
    { timeoutMs: 45_000 },
  );
  if (result.exitCode !== 0)
    throw new Error(`Unable to update Auth0 API: ${result.stderr.trim()}`);
  return {
    api: await showAuth0Api(tenant, apiId),
    created: false,
    changed: true,
  };
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
    process.kill(pid!, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function startDetached(
  command: string,
  args: string[],
  cwd: string,
  logPath: string,
): number {
  mkdirSync(dirname(logPath), { recursive: true });
  const outputFd = openSync(logPath, "a", 0o600);
  try {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", outputFd, outputFd],
    });
    if (!child.pid) throw new Error(`Unable to start ${basename(command)}`);
    child.unref();
    return child.pid;
  } finally {
    closeSync(outputFd);
  }
}

async function startQuickTunnel(
  projectRoot: string,
  port: number,
  logPath: string,
): Promise<{ pid: number; mcpUrl: string }> {
  writeFileSync(logPath, "", { mode: 0o600 });
  const pid = startDetached(
    "cloudflared",
    ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"],
    projectRoot,
    logPath,
  );
  const deadline = Date.now() + 25_000;
  const pattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) break;
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const match = log.match(pattern);
    if (match?.[0]) return { pid, mcpUrl: normalizeMcpUrl(match[0]) };
    await sleep(250);
  }
  stopPid(pid);
  const log = existsSync(logPath)
    ? readFileSync(logPath, "utf8").slice(-4_000)
    : "";
  throw new Error(
    `Cloudflare quick tunnel did not become ready. ${log}`.trim(),
  );
}

function generatedConfig(
  receipt: Pick<
    ChatGptConnectionReceipt,
    "resource" | "issuer" | "scopes" | "registration"
  >,
  settings: ResolvedChatGptSettings,
): string {
  const enabled = new Set(settings.adapters);
  return YAML.stringify({
    chatgpt: { profile: settings.profile },
    server: {
      transport: "http",
      http: {
        host: settings.host,
        port: settings.port,
        auth: {
          mode: "oauth",
          oauth: {
            resource: receipt.resource,
            issuer: receipt.issuer,
            scopes: receipt.scopes,
            readScope: DEFAULT_SCOPES[0],
            writeScope: DEFAULT_SCOPES[1],
            clientRegistration: receipt.registration,
            algorithms: ["RS256"],
            requestTimeoutMs: 5000,
          },
        },
      },
      dashboard: {
        enabled: settings.dashboard,
        host: "127.0.0.1",
        port: settings.dashboardPort,
      },
    },
    policy: { defaultMode: settings.policyMode },
    tools: { preset: settings.toolsPreset },
    adapters: {
      serena: {
        enabled: enabled.has("serena"),
        command: "serena",
        args: [],
        facade: true,
      },
      playwright: {
        enabled: enabled.has("playwright"),
        command: "npx",
        args: ["-y", "@playwright/mcp@0.0.41", "--isolated"],
        facade: true,
      },
      desktopCommander: {
        enabled: enabled.has("desktop-commander"),
        command: "npx",
        args: ["-y", "@wonderwhy-er/desktop-commander@latest"],
        facade: true,
      },
      godot: {
        enabled: enabled.has("godot"),
        godotPath: "godot",
        editorPort: 6550,
        runtimePort: 9090,
      },
    },
  });
}

function secretSafeReceipt(receipt: ChatGptConnectionReceipt): void {
  const serialized = JSON.stringify(receipt);
  const normalizeKey = (key: string): string =>
    key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const forbiddenKeys = new Set([
    "accesstoken",
    "refreshtoken",
    "authorizationcode",
    "clientsecret",
    "managementapitoken",
    "pkceverifier",
    "bearertoken",
    "apikey",
    "password",
    "cookie",
    "privatekey",
  ]);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(normalizeKey(key))) {
        throw new Error(
          `Connection receipt contains forbidden secret field: ${key}`,
        );
      }
      visit(child);
    }
  };
  visit(receipt);
  if (
    /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(
      serialized,
    )
  ) {
    throw new Error("Connection receipt appears to contain a JWT");
  }
}

export function writeConnectionReceipt(
  path: string,
  receipt: ChatGptConnectionReceipt,
): void {
  secretSafeReceipt(receipt);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function checkpointWaitingForChatGptClient(
  path: string,
  receipt: ChatGptConnectionReceipt,
  tunnelAlive: boolean,
): void {
  receipt.checks.chatgptClient = "pending";
  receipt.lifecycle ??= {
    sessionId: randomUUID(),
    sessionStartedAt: receipt.updatedAt,
    stage: "WAITING_FOR_CHATGPT_CLIENT",
    diagnostics: [],
  };
  receipt.lifecycle.stage = "WAITING_FOR_CHATGPT_CLIENT";
  setLifecycleDiagnostic(
    receipt,
    diagnostic(
      "auth0.chatgpt_client",
      "WAITING_FOR_CHATGPT_CLIENT",
      "pending",
      "FolderForge is waiting for ChatGPT to register an OAuth client for this exact MCP resource.",
      true,
      "wait_for_dcr_client",
    ),
  );
  receipt.updatedAt = new Date().toISOString();
  refreshChatGptLifecycle(receipt, true, tunnelAlive);
  writeConnectionReceipt(path, receipt);
}

export function readConnectionReceipt(path: string): ChatGptConnectionReceipt {
  const raw = JSON.parse(
    readFileSync(path, "utf8"),
  ) as ChatGptConnectionReceipt;
  if (
    (raw.version !== 1 && raw.version !== RECEIPT_VERSION) ||
    raw.provider !== "auth0"
  ) {
    throw new Error(`Unsupported ChatGPT connection receipt at ${path}`);
  }
  const now = raw.updatedAt ?? new Date().toISOString();
  const value: ChatGptConnectionReceipt = {
    ...raw,
    version: RECEIPT_VERSION,
    checks: {
      dependencies: raw.checks.dependencies ?? "not_run",
      tenant: raw.checks.tenant ?? "not_run",
      issuerDiscovery: raw.checks.issuerDiscovery ?? "not_run",
      dcr:
        raw.registration === "dcr"
          ? ((raw.checks as Partial<ChatGptConnectionReceipt["checks"]>).dcr ??
            "pass")
          : "not_run",
      auth0Api: raw.checks.auth0Api ?? "not_run",
      localServer:
        (raw.checks as Partial<ChatGptConnectionReceipt["checks"]>)
          .localServer ?? "not_run",
      publicEndpoint:
        (raw.checks as Partial<ChatGptConnectionReceipt["checks"]>)
          .publicEndpoint ??
        raw.checks.resourceMetadata ??
        "not_run",
      resourceMetadata: raw.checks.resourceMetadata ?? "not_run",
      unauthorizedChallenge: raw.checks.unauthorizedChallenge ?? "not_run",
      jwks: raw.checks.jwks ?? "not_run",
      chatgptClient:
        (raw.checks as Partial<ChatGptConnectionReceipt["checks"]>)
          .chatgptClient ?? (raw.clientId ? "pending" : "not_run"),
      loginConnections:
        (raw.checks as Partial<ChatGptConnectionReceipt["checks"]>)
          .loginConnections ?? "not_run",
      userGrant:
        (raw.checks as Partial<ChatGptConnectionReceipt["checks"]>).userGrant ??
        "not_run",
      authorize:
        (raw.checks as Partial<ChatGptConnectionReceipt["checks"]>).authorize ??
        "not_run",
      tokenValidation: raw.checks.tokenValidation ?? "pending_user_login",
      mcpInitialize: raw.checks.mcpInitialize ?? "pending_user_login",
    },
    ...(raw.runtime
      ? {
          runtime: {
            ...raw.runtime,
            loginConnections: raw.runtime.loginConnections ?? [],
          },
        }
      : {}),
    lifecycle: raw.lifecycle ?? {
      sessionId: randomUUID(),
      sessionStartedAt: raw.createdAt ?? now,
      stage: raw.clientId
        ? "CHATGPT_CLIENT_DETECTED"
        : "WAITING_FOR_CHATGPT_CLIENT",
    },
    updatedAt: now,
  };
  secretSafeReceipt(value);
  return value;
}

function acquireLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  const attempt = (): number => {
    try {
      return openSync(path, "wx", 0o600);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
      let stale = true;
      try {
        const pid = Number(readFileSync(path, "utf8").trim());
        stale = !isPidAlive(pid);
      } catch {
        stale = true;
      }
      if (!stale)
        throw new Error(
          "Another FolderForge ChatGPT operation is already running",
        );
      unlinkSync(path);
      return openSync(path, "wx", 0o600);
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

async function waitForUrl(
  url: string,
  predicate: (response: Response) => boolean,
  timeoutMs: number,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (predicate(response)) return response;
      lastError = new Error(`${url} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(400);
  }
  throw new Error(
    lastError instanceof Error
      ? lastError.message
      : `Timed out waiting for ${url}`,
  );
}

async function verifyJwks(
  metadata: AuthorizationMetadata,
  timeoutMs = 10_000,
): Promise<void> {
  const jwks = await fetchJson(metadata.jwks_uri, timeoutMs);
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0)
    throw new Error("Auth0 JWKS contains no signing keys");
}

async function verifyEndpoint(
  receipt: ChatGptConnectionReceipt,
  timeoutMs = 35_000,
): Promise<void> {
  const metadataResponse = await waitForUrl(
    receipt.metadataUrl,
    (response) => response.status === 200,
    timeoutMs,
  );
  const metadata = (await metadataResponse.json()) as Record<string, unknown>;
  if (metadata.resource !== receipt.resource)
    throw new Error(
      "Protected-resource metadata resource does not match the receipt",
    );
  if (
    !Array.isArray(metadata.authorization_servers) ||
    !metadata.authorization_servers.includes(receipt.issuer.replace(/\/$/, ""))
  ) {
    throw new Error(
      "Protected-resource metadata does not advertise the configured issuer",
    );
  }
  const response = await fetch(receipt.mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 401)
    throw new Error(
      `Unauthenticated MCP request returned HTTP ${response.status}, expected 401`,
    );
  const challenge = response.headers.get("www-authenticate") ?? "";
  if (
    !challenge.includes(`resource_metadata="${receipt.metadataUrl}"`) ||
    !challenge.includes(DEFAULT_SCOPES[0])
  ) {
    throw new Error(
      "WWW-Authenticate is missing the resource metadata URL or read scope",
    );
  }
}

function startServer(
  receipt: ChatGptConnectionReceipt,
  settings: ResolvedChatGptSettings,
): number {
  if (isPidAlive(receipt.processes.serverPid))
    return receipt.processes.serverPid!;
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `Built FolderForge CLI not found at ${CLI_ENTRY}. Run \`npm run build\` and retry.`,
    );
  }
  const args = [
    CLI_ENTRY,
    "--project",
    receipt.projectRoot,
    "--config",
    receipt.configPath,
    "--http",
    "--host",
    settings.host,
    "--port",
    String(settings.port),
    "--dashboard-port",
    String(settings.dashboardPort),
    ...(settings.dashboard ? [] : ["--no-dashboard"]),
  ];
  return startDetached(
    process.execPath,
    args,
    receipt.projectRoot,
    receipt.processes.serverLog,
  );
}

async function chooseMode(nonInteractive: boolean): Promise<ChatGptMode> {
  if (nonInteractive || !input.isTTY || !output.isTTY) return "quick";
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      "How will you use FolderForge?\n\n1. Personal testing — easiest\n2. Team or production — stable URL and predefined client\n\nChoose 1 or 2: ",
    );
    return answer.trim() === "2" ? "secure" : "quick";
  } finally {
    rl.close();
  }
}

function existingReceipt(
  projectRoot: string,
): ChatGptConnectionReceipt | undefined {
  const path = receiptPaths(projectRoot).receipt;
  if (!existsSync(path)) return undefined;
  try {
    return readConnectionReceipt(path);
  } catch {
    return undefined;
  }
}

const PROFILE_DEFAULTS: Record<
  ChatGptProfile,
  Pick<ChatGptRuntimeSettings, "policyMode" | "toolsPreset" | "adapters">
> = {
  safe: { policyMode: "safe", toolsPreset: "vibe-lite", adapters: [] },
  developer: { policyMode: "dev", toolsPreset: "vibe-lite", adapters: [] },
  full: { policyMode: "danger", toolsPreset: "full", adapters: [] },
};

function readExistingChatGptConfig(path: string): ExistingChatGptConfig {
  if (!existsSync(path)) return {};
  try {
    const config = YAML.parse(readFileSync(path, "utf8")) as {
      server?: {
        http?: { host?: string; port?: number };
        dashboard?: { enabled?: boolean; port?: number };
      };
      policy?: { defaultMode?: string };
      tools?: { preset?: string };
      adapters?: Record<string, { enabled?: boolean }>;
      chatgpt?: { profile?: string };
    };
    const policyModes: ChatGptPolicyMode[] = [
      "readonly",
      "safe",
      "dev",
      "danger",
    ];
    const presets: ChatGptToolsPreset[] = [
      "vibe",
      "vibe-lite",
      "readonly",
      "full",
      "godot",
    ];
    const profiles: ChatGptProfile[] = ["safe", "developer", "full"];
    const adapters: ChatGptAdapter[] = [];
    if (config.adapters?.playwright?.enabled) adapters.push("playwright");
    if (config.adapters?.serena?.enabled) adapters.push("serena");
    if (config.adapters?.desktopCommander?.enabled)
      adapters.push("desktop-commander");
    if (config.adapters?.godot?.enabled) adapters.push("godot");
    const profile = profiles.includes(config.chatgpt?.profile as ChatGptProfile)
      ? (config.chatgpt?.profile as ChatGptProfile)
      : undefined;
    const policyMode = policyModes.includes(
      config.policy?.defaultMode as ChatGptPolicyMode,
    )
      ? (config.policy?.defaultMode as ChatGptPolicyMode)
      : undefined;
    const toolsPreset = presets.includes(
      config.tools?.preset as ChatGptToolsPreset,
    )
      ? (config.tools?.preset as ChatGptToolsPreset)
      : undefined;
    const httpPort = config.server?.http?.port;
    const dashboardPort = config.server?.dashboard?.port;
    return {
      ...(profile ? { profile } : {}),
      ...(typeof config.server?.http?.host === "string"
        ? { host: config.server.http.host }
        : {}),
      ...(typeof httpPort === "number" && Number.isInteger(httpPort)
        ? { port: httpPort }
        : {}),
      ...(policyMode ? { policyMode } : {}),
      ...(toolsPreset ? { toolsPreset } : {}),
      ...(config.adapters ? { adapters } : {}),
      ...(typeof config.server?.dashboard?.enabled === "boolean"
        ? { dashboard: config.server.dashboard.enabled }
        : {}),
      ...(typeof dashboardPort === "number" && Number.isInteger(dashboardPort)
        ? { dashboardPort }
        : {}),
    };
  } catch {
    return {};
  }
}

function resolveChatGptSettings(
  options: ParsedOptions,
  mode: ChatGptMode,
  configPath: string,
  previous?: ChatGptConnectionReceipt,
): ResolvedChatGptSettings {
  const existing = options.forceConfig
    ? {}
    : readExistingChatGptConfig(configPath);
  const previousRuntime = options.forceConfig ? undefined : previous?.runtime;
  const profile =
    options.profile ??
    existing.profile ??
    previousRuntime?.profile ??
    "developer";
  const defaults = PROFILE_DEFAULTS[profile];
  return {
    profile,
    host: options.host ?? existing.host ?? DEFAULT_HOST,
    port: options.port ?? existing.port ?? DEFAULT_PORT,
    policyMode:
      options.policyMode ??
      existing.policyMode ??
      previousRuntime?.policyMode ??
      defaults.policyMode,
    toolsPreset:
      options.toolsPreset ??
      existing.toolsPreset ??
      previousRuntime?.toolsPreset ??
      defaults.toolsPreset,
    adapters:
      options.adapters ??
      existing.adapters ??
      previousRuntime?.adapters ??
      defaults.adapters,
    dashboard:
      options.dashboard ??
      existing.dashboard ??
      previousRuntime?.dashboard ??
      false,
    dashboardPort:
      options.dashboardPort ??
      existing.dashboardPort ??
      previousRuntime?.dashboardPort ??
      7332,
    offlineAccess:
      options.offlineAccess ?? previousRuntime?.offlineAccess ?? true,
    dcrClientPolicy:
      options.dcrClientPolicy ??
      previousRuntime?.dcrClientPolicy ??
      "require-grant",
    autoEnableDcr:
      options.autoEnableDcr ??
      previousRuntime?.autoEnableDcr ??
      mode === "quick",
    loginConnections:
      options.loginConnections.length > 0
        ? [...new Set(options.loginConnections)]
        : (previousRuntime?.loginConnections ?? []),
  };
}

function desiredSubjectAuthorization(
  policy: DcrClientPolicy,
): NonNullable<Auth0Api["subject_type_authorization"]> {
  // ChatGPT DCR uses the user authorization-code flow. Auth0 permits `allow_all`
  // for user subjects, but client subjects only accept `deny_all` or
  // `require_client_grant`. Denying client-credentials here does not block DCR.
  if (policy === "allow-all") {
    return {
      user: { policy: "allow_all" },
      client: { policy: "deny_all" },
    };
  }
  return {
    user: { policy: "require_client_grant" },
    client: { policy: "deny_all" },
  };
}

async function ensureDynamicClientRegistration(
  tenant: string,
  autoEnable: boolean,
  dryRun: boolean,
  sink: ProgressSink,
): Promise<void> {
  const show = await runCommand(
    "auth0",
    [
      "tenant-settings",
      "show",
      "--json-compact",
      "--no-color",
      "--no-input",
      "--tenant",
      tenant,
    ],
    { timeoutMs: 30_000 },
  );
  if (show.exitCode !== 0)
    throw new Error(
      `Unable to inspect Auth0 tenant settings: ${show.stderr.trim()}`,
    );
  const settings = jsonDocumentFromOutput<{
    flags?: { enable_dynamic_client_registration?: boolean };
  }>(
    `${show.stdout}
${show.stderr}`,
  );
  if (settings.flags?.enable_dynamic_client_registration === true) {
    sink.line("✓ Auth0 Dynamic Client Registration is enabled");
    return;
  }
  if (!autoEnable) {
    throw new Error(
      "Auth0 Dynamic Client Registration is disabled. Re-run without --no-auto-enable-dcr or enable " +
        "flags.enable_dynamic_client_registration in the tenant.",
    );
  }
  if (dryRun) {
    sink.line("• Auth0 Dynamic Client Registration would be enabled");
    return;
  }
  const update = await runCommand(
    "auth0",
    [
      "tenant-settings",
      "update",
      "set",
      "flags.enable_dynamic_client_registration",
      "--no-color",
      "--no-input",
      "--tenant",
      tenant,
    ],
    { timeoutMs: 45_000 },
  );
  if (update.exitCode !== 0)
    throw new Error(
      `Unable to enable Auth0 Dynamic Client Registration: ${update.stderr.trim()}`,
    );
  sink.line("✓ Auth0 Dynamic Client Registration enabled");
}

async function waitForPidExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await sleep(100);
  }
}

async function assertPortAvailable(
  host: string,
  port: number,
  label = "Local port",
  option = "--port",
): Promise<void> {
  await new Promise<void>((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        rejectPort(
          new Error(
            `${label} ${host}:${port} is already in use. Stop the existing service or pass a different ${option}.`,
          ),
        );
        return;
      }
      rejectPort(error);
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => (error ? rejectPort(error) : resolvePort()));
    });
  });
}

export async function assertChatGptRuntimePortsAvailable(settings: {
  host: string;
  port: number;
  dashboard: boolean;
  dashboardPort: number;
}): Promise<void> {
  await assertPortAvailable(settings.host, settings.port);
  if (!settings.dashboard) return;
  if (settings.dashboardPort === settings.port) {
    throw new Error(
      `Dashboard port 127.0.0.1:${settings.dashboardPort} conflicts with the local MCP port. Pass a different --dashboard-port.`,
    );
  }
  await assertPortAvailable(
    "127.0.0.1",
    settings.dashboardPort,
    "Dashboard port",
    "--dashboard-port",
  );
}

function lifecycleCheckState(
  state: CheckState,
): "pass" | "pending" | "fail" | "not_run" {
  return state === "pending_user_login" ? "pending" : state;
}

function diagnostic(
  id: string,
  stage: ChatGptDiagnostic["stage"],
  status: ChatGptDiagnostic["status"],
  evidence: string,
  autoRepair: boolean,
  repairAction?: string,
  errorState?: ChatGptDiagnostic["errorState"],
): ChatGptDiagnostic {
  return {
    id,
    stage,
    status,
    checkedAt: new Date().toISOString(),
    evidence,
    autoRepair,
    ...(repairAction ? { repairAction } : {}),
    ...(errorState ? { errorState } : {}),
  };
}

function setLifecycleDiagnostic(
  receipt: ChatGptConnectionReceipt,
  entry: ChatGptDiagnostic,
): void {
  receipt.lifecycle ??= {
    sessionId: randomUUID(),
    sessionStartedAt: new Date().toISOString(),
    stage: entry.stage,
  };
  receipt.lifecycle.diagnostics = [
    ...(receipt.lifecycle.diagnostics ?? []).filter(
      (current) => current.id !== entry.id,
    ),
    entry,
  ];
}

function hasAuthenticatedChatGptActivity(
  receipt: ChatGptConnectionReceipt,
): boolean {
  const clientId =
    receipt.lifecycle?.detectedClient?.clientId ?? receipt.clientId;
  if (!clientId) return false;
  const auditPath = join(
    receipt.projectRoot,
    ".folderforge",
    "audit",
    "audit.jsonl",
  );
  if (!existsSync(auditPath)) return false;
  try {
    const size = statSync(auditPath).size;
    const bytesToRead = Math.min(size, 512 * 1024);
    const buffer = Buffer.alloc(bytesToRead);
    const fd = openSync(auditPath, "r");
    try {
      readSync(fd, buffer, 0, bytesToRead, Math.max(0, size - bytesToRead));
    } finally {
      closeSync(fd);
    }
    const sessionStartedAt = Date.parse(
      receipt.lifecycle?.sessionStartedAt ?? receipt.createdAt,
    );
    const lines = buffer.toString("utf8").split("\n");
    for (const line of lines.slice(size > bytesToRead ? 1 : 0)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as {
          ts?: string;
          type?: string;
          detail?: { authMode?: string; oauthClientId?: string };
        };
        if (
          event.type === "tool_call" &&
          event.detail?.authMode === "oauth" &&
          event.detail.oauthClientId === clientId &&
          Date.parse(event.ts ?? "") >= sessionStartedAt
        ) {
          return true;
        }
      } catch {
        // Ignore a truncated first line or unrelated malformed historical entry.
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function refreshChatGptLifecycle(
  receipt: ChatGptConnectionReceipt,
  serverAlive = isPidAlive(receipt.processes.serverPid),
  tunnelAlive = receipt.connectivity.kind !== "cloudflared-quick" ||
    isPidAlive(receipt.processes.tunnelPid),
): ChatGptLifecycleSnapshot {
  if (hasAuthenticatedChatGptActivity(receipt)) {
    receipt.checks.tokenValidation = "pass";
    receipt.checks.mcpInitialize = "pass";
    setLifecycleDiagnostic(
      receipt,
      diagnostic(
        "mcp.authenticated_activity",
        "CONNECTED",
        "pass",
        "An authenticated MCP tool call from the verified ChatGPT OAuth client was recorded.",
        false,
      ),
    );
  }
  const snapshot = deriveChatGptLifecycle({
    receiptExists: true,
    serverAlive,
    tunnelRequired: receipt.connectivity.kind === "cloudflared-quick",
    tunnelAlive,
    checks: {
      dependencies: lifecycleCheckState(receipt.checks.dependencies),
      tenant: lifecycleCheckState(receipt.checks.tenant),
      dcr: lifecycleCheckState(receipt.checks.dcr),
      auth0Api: lifecycleCheckState(receipt.checks.auth0Api),
      localServer: lifecycleCheckState(receipt.checks.localServer),
      publicEndpoint: lifecycleCheckState(receipt.checks.publicEndpoint),
      resourceMetadata: lifecycleCheckState(receipt.checks.resourceMetadata),
      unauthorizedChallenge: lifecycleCheckState(
        receipt.checks.unauthorizedChallenge,
      ),
      chatgptClient: lifecycleCheckState(receipt.checks.chatgptClient),
      loginConnections: lifecycleCheckState(receipt.checks.loginConnections),
      userGrant: lifecycleCheckState(receipt.checks.userGrant),
      authorize: lifecycleCheckState(receipt.checks.authorize),
      tokenValidation: lifecycleCheckState(receipt.checks.tokenValidation),
      mcpInitialize: lifecycleCheckState(receipt.checks.mcpInitialize),
    },
    diagnostics: receipt.lifecycle?.diagnostics ?? [],
    updatedAt: receipt.updatedAt,
  });
  receipt.lifecycleSnapshot = snapshot;
  if (
    receipt.lifecycle &&
    !receipt.lifecycle.lastError &&
    CHATGPT_LIFECYCLE_STAGES.includes(
      snapshot.state as (typeof CHATGPT_LIFECYCLE_STAGES)[number],
    )
  ) {
    receipt.lifecycle.stage =
      snapshot.state as (typeof CHATGPT_LIFECYCLE_STAGES)[number];
  }
  receipt.status =
    snapshot.overall === "connected"
      ? "connected"
      : snapshot.overall === "waiting_for_chatgpt"
        ? snapshot.state === "READY_TO_COMPLETE_LOGIN"
          ? "ready"
          : "waiting"
        : snapshot.overall === "needs_attention"
          ? "needs_attention"
          : "stopped";
  return snapshot;
}

function recordLifecycleFailure(
  receipt: ChatGptConnectionReceipt,
  error: unknown,
  diagnosticId: string,
  stage: ChatGptDiagnostic["stage"],
  repairAction: string,
  fallbackErrorState?: ChatGptErrorState,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const classifiedCode =
    error instanceof ChatGptAuth0Error
      ? error.code
      : classifyChatGptError(message);
  const code =
    classifiedCode === "UNKNOWN" && fallbackErrorState
      ? fallbackErrorState
      : classifiedCode;
  const evidence =
    error instanceof ChatGptAuth0Error ? error.evidence : undefined;
  receipt.lifecycle ??= {
    sessionId: randomUUID(),
    sessionStartedAt: new Date().toISOString(),
    stage,
  };
  receipt.lifecycle.lastError = {
    code,
    message,
    ...(evidence ? { evidence } : {}),
    at: new Date().toISOString(),
  };
  receipt.lifecycle.diagnostics = [
    ...(receipt.lifecycle.diagnostics ?? []).filter(
      (entry) => entry.id !== diagnosticId,
    ),
    diagnostic(
      diagnosticId,
      stage,
      "fail",
      evidence ?? message,
      true,
      repairAction,
      code,
    ),
  ];
}

async function connect(
  options: ParsedOptions,
  sink: ProgressSink,
): Promise<ChatGptConnectionReceipt> {
  const paths = receiptPaths(options.projectRoot);
  if (!existsSync(options.projectRoot))
    throw new Error(`Project does not exist: ${options.projectRoot}`);
  if (!options.dryRun) mkdirSync(paths.stateDir, { recursive: true });
  const releaseLock = options.dryRun
    ? () => undefined
    : acquireLock(paths.lock);
  const startedPids: number[] = [];
  try {
    const mode = options.mode ?? (await chooseMode(options.json));
    const registration: RegistrationStrategy =
      mode === "quick" ? "dcr" : "predefined";
    const previous = existingReceipt(options.projectRoot);
    const settings = resolveChatGptSettings(
      options,
      mode,
      paths.config,
      previous,
    );
    if (mode === "secure" && !options.publicUrl) {
      throw new Error(
        "Secure mode requires --public-url https://your-stable-host.example/mcp",
      );
    }

    const auth0Version = await requireCommand("auth0");
    sink.line(`✓ Auth0 CLI detected (${auth0Version})`);
    if (
      mode === "quick" &&
      !options.publicUrl &&
      options.tunnel === "cloudflared"
    ) {
      const cloudflaredVersion = await requireCommand("cloudflared");
      sink.line(`✓ Cloudflare Tunnel detected (${cloudflaredVersion})`);
    }

    const tenant = await activeAuth0Tenant(options.tenant);
    sink.line(`✓ Auth0 tenant selected (${tenant})`);
    if (registration === "dcr") {
      await ensureDynamicClientRegistration(
        tenant,
        settings.autoEnableDcr,
        options.dryRun,
        sink,
      );
    }
    const discovery = await discoverAuth0(tenant, registration);
    sink.line("✓ Auth0 issuer and PKCE S256 metadata verified");
    await verifyJwks(discovery);
    sink.line("✓ Auth0 JWKS verified");
    const shouldCaptureDcrBaseline =
      registration === "dcr" && options.start && !options.dryRun;
    const baselineClients = shouldCaptureDcrBaseline
      ? await listAuth0Clients(tenant)
      : [];
    const baselineClientIds = new Set(
      baselineClients.map((client) => client.client_id),
    );
    const baselineApplicationCount = countAuth0Applications(baselineClients);
    const baselineChatGptDcrCount =
      baselineClients.filter(isChatGptDcrClient).length;
    if (shouldCaptureDcrBaseline) {
      sink.line(
        `✓ DCR client baseline captured (${baselineClientIds.size} existing clients)`,
      );
      if (baselineApplicationCount >= 10) {
        sink.line(
          `⚠ Auth0 has ${baselineApplicationCount} counted applications, including ${baselineChatGptDcrCount} ChatGPT DCR clients. A Free tenant may reject another registration at its 10-application limit.`,
        );
        sink.line(
          `  Review safe cleanup candidates with: folderforge chatgpt prune-dcr --tenant ${tenant} --project ${JSON.stringify(options.projectRoot)}`,
        );
      }
    }

    if (options.start && !options.dryRun) {
      if (
        previous?.processes.serverPid &&
        isPidAlive(previous.processes.serverPid)
      ) {
        stopPid(previous.processes.serverPid);
        await waitForPidExit(previous.processes.serverPid);
        sink.line(
          "✓ Previous FolderForge server stopped before applying the new configuration",
        );
      }
      await assertChatGptRuntimePortsAvailable(settings);
      sink.line(`✓ Local port ${settings.host}:${settings.port} is available`);
      if (settings.dashboard) {
        sink.line(
          `✓ Dashboard port 127.0.0.1:${settings.dashboardPort} is available`,
        );
      }
    }

    let mcpUrl: string;
    let tunnelPid: number | undefined;
    let connectivityKind: ChatGptConnectionReceipt["connectivity"]["kind"];
    const warnings: string[] = [];

    if (options.publicUrl) {
      mcpUrl = normalizeMcpUrl(options.publicUrl);
      connectivityKind = "stable-url";
    } else if (
      previous?.mode === "quick" &&
      previous.connectivity.kind === "cloudflared-quick" &&
      previous.connectivity.localUrl ===
        `${localUrl(settings.host, settings.port)}/mcp` &&
      isPidAlive(previous.processes.tunnelPid)
    ) {
      mcpUrl = previous.mcpUrl;
      tunnelPid = previous.processes.tunnelPid;
      connectivityKind = "cloudflared-quick";
      warnings.push(
        "Quick tunnel URLs are temporary. Use --secure with a stable public URL for team or production use.",
      );
      sink.line("✓ Existing Cloudflare quick tunnel reused");
    } else if (mode === "quick" && options.tunnel === "cloudflared") {
      if (options.dryRun) {
        throw new Error(
          "Dry-run quick mode needs --public-url because a temporary tunnel URL cannot be predicted safely",
        );
      }
      const tunnel = await startQuickTunnel(
        options.projectRoot,
        settings.port,
        paths.tunnelLog,
      );
      tunnelPid = tunnel.pid;
      startedPids.push(tunnel.pid);
      mcpUrl = tunnel.mcpUrl;
      connectivityKind = "cloudflared-quick";
      warnings.push(
        "Quick mode uses an open DCR-compatible flow and a temporary tunnel URL. Do not use it for production.",
      );
      sink.line(`✓ Temporary secure tunnel ready (${new URL(mcpUrl).origin})`);
    } else {
      throw new Error(
        "No public connectivity is configured. Provide --public-url or use --quick --tunnel cloudflared.",
      );
    }

    const resource = mcpUrl;
    const metadataUrl = metadataUrlFor(resource);
    const provisioned = await provisionAuth0Api(
      tenant,
      resource,
      options.dryRun,
      settings.offlineAccess,
      settings.dcrClientPolicy,
    );
    sink.line(
      provisioned.created
        ? "✓ FolderForge API created in Auth0"
        : provisioned.changed
          ? options.dryRun
            ? "• FolderForge Auth0 API would be created or updated"
            : "✓ FolderForge API updated in Auth0"
          : "✓ Existing FolderForge API reused without changes",
    );
    if (registration === "dcr") {
      if (options.dryRun) {
        sink.line(
          "• Default third-party Auth0 user grant would be created or updated",
        );
      } else {
        await ensureDefaultThirdPartyUserGrant(
          tenant,
          resource,
          [...DEFAULT_SCOPES],
          true,
        );
        sink.line("✓ Default third-party Auth0 user grant created or verified");
      }
    }
    sink.line("✓ OAuth scopes and ChatGPT client access configured");
    sink.line(
      `✓ Runtime profile ${settings.profile}: policy=${settings.policyMode}, tools=${settings.toolsPreset}`,
    );
    if (settings.adapters.length > 0)
      sink.line(`✓ Adapters enabled: ${settings.adapters.join(", ")}`);
    if (settings.toolsPreset === "full") {
      warnings.push(
        "The full tool preset may advertise more tools than some MCP clients accept. Use --tools-preset vibe-lite if ChatGPT rejects the tool list.",
      );
    }
    if (settings.policyMode === "danger") {
      warnings.push(
        "Danger policy allows non-critical mutating tools without approval. Workspace boundaries and hard command blocks still apply.",
      );
    }

    const now = new Date().toISOString();
    const receipt: ChatGptConnectionReceipt = {
      version: RECEIPT_VERSION,
      status: options.start
        ? "configured"
        : mode === "secure" && !options.clientId
          ? "action_required"
          : "configured",
      provider: "auth0",
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
        apiName: provisioned.api.name ?? "FolderForge MCP",
        createdByFolderForge:
          provisioned.created || previous?.auth0.createdByFolderForge === true,
      },
      connectivity: {
        kind: connectivityKind,
        publicUrl: new URL(mcpUrl).origin,
        localUrl: `${localUrl(settings.host, settings.port)}/mcp`,
        ...(connectivityKind === "cloudflared-quick"
          ? {
              warning:
                "Temporary URL: if the tunnel stops, run `folderforge chatgpt repair --quick` and reconnect ChatGPT.",
            }
          : {}),
      },
      processes: {
        ...(tunnelPid ? { tunnelPid } : {}),
        serverLog: paths.serverLog,
        ...(connectivityKind === "cloudflared-quick"
          ? { tunnelLog: paths.tunnelLog }
          : {}),
      },
      checks: {
        dependencies: "pass",
        tenant: "pass",
        issuerDiscovery: "pass",
        dcr: registration === "dcr" ? "pass" : "not_run",
        auth0Api: options.dryRun ? "pending" : "pass",
        localServer: options.start ? "pending" : "not_run",
        publicEndpoint: options.start ? "pending" : "not_run",
        resourceMetadata: options.start ? "pending" : "not_run",
        unauthorizedChallenge: options.start ? "pending" : "not_run",
        jwks: "pass",
        chatgptClient:
          registration === "dcr"
            ? "pending"
            : options.clientId
              ? "pass"
              : "not_run",
        loginConnections: registration === "dcr" ? "pending" : "not_run",
        userGrant:
          registration === "dcr"
            ? options.dryRun
              ? "pending"
              : "pass"
            : "not_run",
        authorize: options.start ? "pending" : "not_run",
        tokenValidation: "pending_user_login",
        mcpInitialize: "pending_user_login",
      },
      lifecycle: {
        sessionId: randomUUID(),
        sessionStartedAt: now,
        stage: options.start ? "OAUTH_METADATA_READY" : "RESOURCE_SERVER_READY",
        diagnostics: [],
      },
      warnings,
      runtime: {
        profile: settings.profile,
        policyMode: settings.policyMode,
        toolsPreset: settings.toolsPreset,
        adapters: [...settings.adapters],
        dashboard: settings.dashboard,
        dashboardPort: settings.dashboardPort,
        offlineAccess: settings.offlineAccess,
        dcrClientPolicy: settings.dcrClientPolicy,
        autoEnableDcr: settings.autoEnableDcr,
        loginConnections: [...settings.loginConnections],
      },
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };

    if (!options.dryRun) {
      writeFileSync(paths.config, generatedConfig(receipt, settings), {
        mode: 0o600,
      });
      chmodSync(paths.config, 0o600);
      sink.line(`✓ FolderForge OAuth config written (${paths.config})`);
    }

    if (options.start && !options.dryRun) {
      const serverPid = startServer(receipt, settings);
      if (!receipt.processes.serverPid) startedPids.push(serverPid);
      receipt.processes.serverPid = serverPid;
      await waitForUrl(
        `${localUrl(settings.host, settings.port)}/healthz`,
        (response) => response.status === 200,
        20_000,
      );
      receipt.checks.localServer = "pass";
      sink.line("✓ FolderForge HTTP MCP started");
      await verifyEndpoint(receipt);
      receipt.checks.publicEndpoint = "pass";
      receipt.checks.resourceMetadata = "pass";
      receipt.checks.unauthorizedChallenge = "pass";
      setLifecycleDiagnostic(
        receipt,
        diagnostic(
          "oauth.metadata",
          "OAUTH_METADATA_READY",
          "pass",
          "Protected-resource metadata and the unauthenticated 401 challenge match this MCP resource.",
          true,
          "rerun_verification",
        ),
      );
      sink.line("✓ MCP resource metadata verified");
      sink.line("✓ 401 WWW-Authenticate challenge verified");
      sink.line(`MCP URL: ${receipt.mcpUrl}`);

      if (registration === "dcr") {
        const reusableClientId =
          options.clientId ??
          (previous?.resource === resource
            ? previous.lifecycle?.detectedClient?.clientId
            : undefined);
        if (options.waitForClient || reusableClientId) {
          checkpointWaitingForChatGptClient(
            paths.receipt,
            receipt,
            tunnelPid ? isPidAlive(tunnelPid) : true,
          );
          sink.line(
            "✓ Current connection state saved before waiting for ChatGPT",
          );
          sink.line("Waiting for ChatGPT to register an OAuth client...");
          try {
            const detected = await waitForChatGptClient({
              tenant,
              resource,
              baselineClientIds,
              timeoutMs: reusableClientId
                ? Math.min(options.waitTimeoutMs, 30_000)
                : options.waitTimeoutMs,
              pollIntervalMs: options.pollIntervalMs,
              ...(reusableClientId
                ? { explicitClientId: reusableClientId }
                : {}),
              onProgress: (message) => sink.line(message),
            });
            if (!detected) {
              receipt.checks.chatgptClient = "pending";
              receipt.lifecycle!.stage = "WAITING_FOR_CHATGPT_CLIENT";
              const capacityWarning =
                baselineApplicationCount >= 10
                  ? ` Auth0 had ${baselineApplicationCount} counted applications at baseline, so DCR may have been rejected by the tenant entity limit. Review cleanup candidates with \`folderforge chatgpt prune-dcr --tenant ${tenant} --project ${JSON.stringify(options.projectRoot)}\`.`
                  : "";
              receipt.warnings.push(
                `Timed out after ${Math.round(options.waitTimeoutMs / 1000)} seconds waiting for ChatGPT.${capacityWarning || " Re-run `folderforge connect chatgpt --wait` while clicking Connect."}`,
              );
              setLifecycleDiagnostic(
                receipt,
                diagnostic(
                  "auth0.chatgpt_client",
                  "WAITING_FOR_CHATGPT_CLIENT",
                  "pending",
                  baselineApplicationCount >= 10
                    ? `No new ChatGPT DCR client appeared; the tenant already had ${baselineApplicationCount} counted applications and may be at its application limit.`
                    : "No new session-scoped ChatGPT DCR client requested this exact resource before the timeout.",
                  true,
                  baselineApplicationCount >= 10
                    ? "prune_stale_dcr_clients"
                    : "wait_for_dcr_client",
                ),
              );
              sink.line(
                "• No matching ChatGPT client detected yet; the server remains ready and repairable",
              );
            } else {
              receipt.clientId = detected.clientId;
              receipt.lifecycle!.detectedClient = detected;
              receipt.lifecycle!.stage = "CHATGPT_CLIENT_DETECTED";
              receipt.checks.chatgptClient = "pass";
              setLifecycleDiagnostic(
                receipt,
                diagnostic(
                  "auth0.chatgpt_client",
                  "CHATGPT_CLIENT_DETECTED",
                  "pass",
                  "Client name, DCR markers, ChatGPT callback, session boundary, and Auth0 resource log all match.",
                  false,
                ),
              );

              const connections = await ensureLoginConnections(
                tenant,
                detected.clientId,
                settings.loginConnections,
                true,
              );
              receipt.lifecycle!.loginConnections = connections;
              receipt.checks.loginConnections = "pass";
              setLifecycleDiagnostic(
                receipt,
                diagnostic(
                  "auth0.login_connections",
                  "LOGIN_CONNECTIONS_READY",
                  "pass",
                  `${connections.map((entry) => entry.name).join(", ")} promoted to Auth0 domain level for third-party DCR clients.`,
                  true,
                  "enable_login_connection",
                ),
              );
              sink.line(
                `✓ Domain-level login connection ready (${connections.map((entry) => entry.name).join(", ")})`,
              );

              const grant = await ensureUserClientGrant(
                tenant,
                detected.clientId,
                resource,
                [...DEFAULT_SCOPES],
                true,
              );
              receipt.lifecycle!.userGrant = grant;
              receipt.checks.userGrant = "pass";
              setLifecycleDiagnostic(
                receipt,
                diagnostic(
                  "auth0.user_grant",
                  "USER_GRANT_READY",
                  "pass",
                  "A user grant covers this third-party client, audience and scopes.",
                  true,
                  "repair_user_grant",
                ),
              );
              sink.line("✓ User-type Auth0 grant created or verified");

              const authorize = await verifyAuthorizeEndpoint({
                authorizationEndpoint: discovery.authorization_endpoint,
                client: detected,
                resource,
                scopes: [...DEFAULT_SCOPES],
              });
              receipt.lifecycle!.authorize = authorize;
              delete receipt.lifecycle!.lastError;
              receipt.checks.authorize = "pass";
              setLifecycleDiagnostic(
                receipt,
                diagnostic(
                  "oauth.authorize",
                  "AUTHORIZE_READY",
                  "pass",
                  "The authorize endpoint accepts the client, callback, PKCE request, scopes, and resource.",
                  true,
                  "rerun_verification",
                ),
              );
              sink.line(
                "OAuth is ready. Return to ChatGPT and complete sign-in.",
              );
            }
          } catch (error) {
            const code =
              error instanceof ChatGptAuth0Error
                ? error.code
                : classifyChatGptError(
                    error instanceof Error ? error.message : String(error),
                  );
            if (code === "NO_CONNECTIONS_ENABLED")
              receipt.checks.loginConnections = "fail";
            else if (code === "CLIENT_NOT_AUTHORIZED")
              receipt.checks.userGrant = "fail";
            else if (code === "CALLBACK_MISMATCH")
              receipt.checks.chatgptClient = "fail";
            else receipt.checks.authorize = "fail";
            recordLifecycleFailure(
              receipt,
              error,
              "auth0.lifecycle",
              "AUTHORIZE_READY",
              "repair_auth0",
            );
            sink.line(
              `✗ ChatGPT OAuth lifecycle needs attention: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      } else {
        receipt.status = options.clientId ? "ready" : "action_required";
      }
      refreshChatGptLifecycle(
        receipt,
        true,
        tunnelPid ? isPidAlive(tunnelPid) : true,
      );
    }

    if (options.dryRun) {
      receipt.status =
        mode === "secure" && !options.clientId
          ? "action_required"
          : "configured";
      sink.line("• Dry run complete; no Auth0 or local files were changed");
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

async function verifyManagedDcrLifecycle(
  receipt: ChatGptConnectionReceipt,
  options: ParsedOptions,
  discovery: AuthorizationMetadata,
  repairMode: boolean,
  sink: ProgressSink,
): Promise<void> {
  if (receipt.registration !== "dcr") return;
  const clientId =
    options.clientId ??
    receipt.lifecycle?.detectedClient?.clientId ??
    receipt.clientId;
  if (!clientId) {
    receipt.checks.chatgptClient = "pending";
    setLifecycleDiagnostic(
      receipt,
      diagnostic(
        "auth0.chatgpt_client",
        "WAITING_FOR_CHATGPT_CLIENT",
        "pending",
        "No verified ChatGPT DCR client is stored for this resource.",
        true,
        "wait_for_dcr_client",
      ),
    );
    return;
  }

  try {
    const candidate = await getAuth0Client(receipt.tenant, clientId);
    const detected = await validateChatGptClientForResource(
      receipt.tenant,
      candidate,
      receipt.resource,
    );
    receipt.clientId = detected.clientId;
    receipt.lifecycle ??= {
      sessionId: randomUUID(),
      sessionStartedAt: new Date().toISOString(),
      stage: "CHATGPT_CLIENT_DETECTED",
    };
    receipt.lifecycle.detectedClient = detected;
    receipt.checks.chatgptClient = "pass";
    setLifecycleDiagnostic(
      receipt,
      diagnostic(
        "auth0.chatgpt_client",
        "CHATGPT_CLIENT_DETECTED",
        "pass",
        "Stored client still matches ChatGPT DCR boundaries and this exact resource.",
        false,
      ),
    );

    const requestedConnections =
      options.loginConnections.length > 0
        ? options.loginConnections
        : (receipt.runtime?.loginConnections?.length ?? 0) > 0
          ? receipt.runtime!.loginConnections
          : (receipt.lifecycle.loginConnections?.map((entry) => entry.name) ??
            []);
    const connections = await ensureLoginConnections(
      receipt.tenant,
      detected.clientId,
      requestedConnections,
      repairMode,
    );
    receipt.lifecycle.loginConnections = connections;
    receipt.checks.loginConnections = "pass";
    setLifecycleDiagnostic(
      receipt,
      diagnostic(
        "auth0.login_connections",
        "LOGIN_CONNECTIONS_READY",
        "pass",
        `${connections.map((entry) => entry.name).join(", ")} is available at Auth0 domain level for third-party DCR clients.`,
        true,
        "enable_login_connection",
      ),
    );

    const grant = await ensureUserClientGrant(
      receipt.tenant,
      detected.clientId,
      receipt.resource,
      receipt.scopes,
      repairMode,
    );
    receipt.lifecycle.userGrant = grant;
    receipt.checks.userGrant = "pass";
    setLifecycleDiagnostic(
      receipt,
      diagnostic(
        "auth0.user_grant",
        "USER_GRANT_READY",
        "pass",
        "A user grant covers the current third-party client, audience and scopes.",
        true,
        "repair_user_grant",
      ),
    );

    const authorize = await verifyAuthorizeEndpoint({
      authorizationEndpoint: discovery.authorization_endpoint,
      client: detected,
      resource: receipt.resource,
      scopes: receipt.scopes,
    });
    receipt.lifecycle.authorize = authorize;
    receipt.checks.authorize = "pass";
    delete receipt.lifecycle.lastError;
    setLifecycleDiagnostic(
      receipt,
      diagnostic(
        "oauth.authorize",
        "AUTHORIZE_READY",
        "pass",
        "Authorize endpoint accepts this client, callback, PKCE request, resource, and scopes.",
        true,
        "rerun_verification",
      ),
    );
    receipt.lifecycle.diagnostics = (
      receipt.lifecycle.diagnostics ?? []
    ).filter(
      (entry) =>
        entry.id !== "auth0.lifecycle" && entry.id !== "auth0.discovery",
    );
    delete receipt.lifecycle.lastError;
    sink.line(
      repairMode
        ? "✓ ChatGPT client, login connection, user grant and authorize flow repaired or verified"
        : "✓ ChatGPT client, login connection, user grant and authorize flow verified",
    );
  } catch (error) {
    const code =
      error instanceof ChatGptAuth0Error
        ? error.code
        : classifyChatGptError(
            error instanceof Error ? error.message : String(error),
          );
    if (code === "CALLBACK_MISMATCH") receipt.checks.chatgptClient = "fail";
    else if (code === "NO_CONNECTIONS_ENABLED")
      receipt.checks.loginConnections = "fail";
    else if (code === "CLIENT_NOT_AUTHORIZED")
      receipt.checks.userGrant = "fail";
    else receipt.checks.authorize = "fail";
    recordLifecycleFailure(
      receipt,
      error,
      "auth0.lifecycle",
      code === "CALLBACK_MISMATCH"
        ? "CHATGPT_CLIENT_DETECTED"
        : code === "NO_CONNECTIONS_ENABLED"
          ? "LOGIN_CONNECTIONS_READY"
          : code === "CLIENT_NOT_AUTHORIZED"
            ? "USER_GRANT_READY"
            : "AUTHORIZE_READY",
      repairMode ? "repair_auth0" : "run_chatgpt_repair",
    );
    sink.line(
      `✗ Auth0 lifecycle verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function status(
  options: ParsedOptions,
  sink: ProgressSink,
): Promise<ChatGptConnectionReceipt> {
  const paths = receiptPaths(options.projectRoot);
  if (!existsSync(paths.receipt))
    throw new Error(
      "No ChatGPT connection receipt found. Run `folderforge connect chatgpt`.",
    );
  const receipt = readConnectionReceipt(paths.receipt);
  const serverAlive = isPidAlive(receipt.processes.serverPid);
  const tunnelAlive =
    receipt.connectivity.kind !== "cloudflared-quick" ||
    isPidAlive(receipt.processes.tunnelPid);

  receipt.checks.localServer = serverAlive ? "pass" : "fail";
  setLifecycleDiagnostic(
    receipt,
    diagnostic(
      "runtime.local_server",
      "LOCAL_SERVER_READY",
      serverAlive ? "pass" : "fail",
      serverAlive
        ? `Managed FolderForge process ${receipt.processes.serverPid ?? "unknown"} is alive.`
        : "The managed local MCP server process is not running.",
      true,
      "start_server",
      serverAlive ? undefined : "LOCAL_SERVER_STOPPED",
    ),
  );
  sink.line(
    `${serverAlive ? "✓" : "✗"} FolderForge server ${serverAlive ? "is running" : "is stopped"}`,
  );

  if (receipt.connectivity.kind === "cloudflared-quick") {
    setLifecycleDiagnostic(
      receipt,
      diagnostic(
        "runtime.tunnel",
        "PUBLIC_ENDPOINT_READY",
        tunnelAlive ? "pass" : "fail",
        tunnelAlive
          ? `Managed Cloudflare Tunnel process ${receipt.processes.tunnelPid ?? "unknown"} is alive.`
          : "The temporary Cloudflare Tunnel process is not running.",
        true,
        "restart_tunnel",
        tunnelAlive ? undefined : "TUNNEL_STOPPED",
      ),
    );
    sink.line(
      `${tunnelAlive ? "✓" : "✗"} Cloudflare quick tunnel ${tunnelAlive ? "is running" : "is stopped"}`,
    );
  }

  sink.line("• Checking public OAuth endpoint and 401 challenge...");
  try {
    await verifyEndpoint(receipt, 3_000);
    receipt.checks.publicEndpoint = "pass";
    receipt.checks.resourceMetadata = "pass";
    receipt.checks.unauthorizedChallenge = "pass";
    setLifecycleDiagnostic(
      receipt,
      diagnostic(
        "oauth.metadata",
        "OAUTH_METADATA_READY",
        "pass",
        "Public protected-resource metadata and the 401 WWW-Authenticate challenge are valid.",
        true,
        "rerun_verification",
      ),
    );
    if (
      receipt.lifecycle?.lastError?.code === "PUBLIC_ENDPOINT_502" ||
      receipt.lifecycle?.lastError?.code === "METADATA_INVALID"
    ) {
      delete receipt.lifecycle.lastError;
    }
    sink.line("✓ Public OAuth metadata and 401 challenge are reachable");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = classifyChatGptError(message);
    receipt.checks.publicEndpoint = "fail";
    receipt.checks.resourceMetadata = "fail";
    receipt.checks.unauthorizedChallenge = "fail";
    recordLifecycleFailure(
      receipt,
      error,
      "oauth.metadata",
      code === "PUBLIC_ENDPOINT_502"
        ? "PUBLIC_ENDPOINT_READY"
        : "OAUTH_METADATA_READY",
      receipt.connectivity.kind === "cloudflared-quick"
        ? "restart_tunnel"
        : "rerun_verification",
      "PUBLIC_ENDPOINT_UNREACHABLE",
    );
    sink.line(`✗ Public endpoint verification failed: ${message}`);
  }

  sink.line("• Checking Auth0 discovery and client authorization...");
  try {
    const discovery = await discoverAuth0(
      receipt.tenant,
      receipt.registration,
      3_000,
    );
    receipt.checks.tenant = "pass";
    receipt.checks.issuerDiscovery = "pass";
    receipt.checks.dcr = receipt.registration === "dcr" ? "pass" : "not_run";
    await verifyJwks(discovery, 3_000);
    receipt.checks.jwks = "pass";
    await verifyManagedDcrLifecycle(receipt, options, discovery, false, sink);
  } catch (error) {
    receipt.checks.tenant = "fail";
    receipt.checks.issuerDiscovery = "fail";
    recordLifecycleFailure(
      receipt,
      error,
      "auth0.discovery",
      "AUTH0_READY",
      "repair_auth0",
      "AUTH0_UNREACHABLE",
    );
    sink.line(
      `✗ Auth0 verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  receipt.updatedAt = new Date().toISOString();
  refreshChatGptLifecycle(receipt, serverAlive, tunnelAlive);
  writeConnectionReceipt(paths.receipt, receipt);
  return receipt;
}

async function doctor(
  options: ParsedOptions,
  sink: ProgressSink,
): Promise<ChatGptConnectionReceipt | undefined> {
  const auth0Version = await requireCommand("auth0");
  sink.line(`✓ Auth0 CLI detected (${auth0Version})`);
  const tenant = await activeAuth0Tenant(options.tenant);
  sink.line(`✓ Active Auth0 tenant detected (${tenant})`);
  const discovery = await discoverAuth0(
    tenant,
    options.mode === "secure" ? "predefined" : "dcr",
  );
  sink.line("✓ Auth0 discovery, issuer and PKCE S256 verified");
  await verifyJwks(discovery);
  sink.line("✓ Auth0 JWKS verified");
  const existing = existingReceipt(options.projectRoot);
  if (!existing) {
    sink.line("• No connection receipt exists yet");
    return undefined;
  }
  sink.line(
    "✓ Connection receipt is readable and contains no known secret fields",
  );
  return await status(options, sink);
}

async function startFromReceipt(
  options: ParsedOptions,
  sink: ProgressSink,
): Promise<ChatGptConnectionReceipt> {
  const paths = receiptPaths(options.projectRoot);
  const releaseLock = acquireLock(paths.lock);
  try {
    const receipt = readConnectionReceipt(paths.receipt);
    if (
      receipt.connectivity.kind === "cloudflared-quick" &&
      !isPidAlive(receipt.processes.tunnelPid)
    ) {
      throw new Error(
        "The temporary tunnel URL cannot be reclaimed. Run `folderforge chatgpt repair --quick`.",
      );
    }
    const settings = resolveChatGptSettings(
      options,
      receipt.mode,
      receipt.configPath,
      receipt,
    );
    const hasRuntimeOverrides =
      options.forceConfig ||
      options.host !== undefined ||
      options.port !== undefined ||
      options.profile !== undefined ||
      options.policyMode !== undefined ||
      options.toolsPreset !== undefined ||
      options.adapters !== undefined ||
      options.dashboard !== undefined ||
      options.dashboardPort !== undefined ||
      options.offlineAccess !== undefined ||
      options.dcrClientPolicy !== undefined ||
      options.autoEnableDcr !== undefined ||
      options.loginConnections.length > 0;
    if (hasRuntimeOverrides) {
      writeFileSync(receipt.configPath, generatedConfig(receipt, settings), {
        mode: 0o600,
      });
      chmodSync(receipt.configPath, 0o600);
      if (isPidAlive(receipt.processes.serverPid)) {
        stopPid(receipt.processes.serverPid);
        await waitForPidExit(receipt.processes.serverPid!);
      }
      delete receipt.processes.serverPid;
      sink.line(`✓ CLI overrides persisted to ${receipt.configPath}`);
    }
    if (!isPidAlive(receipt.processes.serverPid))
      await assertPortAvailable(settings.host, settings.port);
    const pid = startServer(receipt, settings);
    receipt.processes.serverPid = pid;
    receipt.runtime = {
      profile: settings.profile,
      policyMode: settings.policyMode,
      toolsPreset: settings.toolsPreset,
      adapters: [...settings.adapters],
      dashboard: settings.dashboard,
      dashboardPort: settings.dashboardPort,
      offlineAccess: settings.offlineAccess,
      dcrClientPolicy: settings.dcrClientPolicy,
      autoEnableDcr: settings.autoEnableDcr,
      loginConnections: [...settings.loginConnections],
    };
    await waitForUrl(
      `${localUrl(settings.host, settings.port)}/healthz`,
      (response) => response.status === 200,
      20_000,
    );
    receipt.checks.localServer = "pass";
    await verifyEndpoint(receipt);
    receipt.checks.publicEndpoint = "pass";
    receipt.checks.resourceMetadata = "pass";
    receipt.checks.unauthorizedChallenge = "pass";
    try {
      const discovery = await discoverAuth0(
        receipt.tenant,
        receipt.registration,
      );
      await verifyManagedDcrLifecycle(receipt, options, discovery, false, sink);
    } catch (error) {
      recordLifecycleFailure(
        receipt,
        error,
        "auth0.discovery",
        "AUTH0_READY",
        "repair_auth0",
      );
    }
    receipt.updatedAt = new Date().toISOString();
    refreshChatGptLifecycle(
      receipt,
      true,
      receipt.connectivity.kind !== "cloudflared-quick" ||
        isPidAlive(receipt.processes.tunnelPid),
    );
    writeConnectionReceipt(paths.receipt, receipt);
    sink.line(
      "✓ FolderForge server started and public OAuth metadata verified",
    );
    return receipt;
  } finally {
    releaseLock();
  }
}

async function stopConnection(
  options: ParsedOptions,
  sink: ProgressSink,
): Promise<ChatGptConnectionReceipt> {
  const paths = receiptPaths(options.projectRoot);
  const releaseLock = acquireLock(paths.lock);
  try {
    const receipt = readConnectionReceipt(paths.receipt);
    const serverStopped = stopPid(receipt.processes.serverPid);
    const tunnelStopped = stopPid(receipt.processes.tunnelPid);
    sink.line(
      serverStopped
        ? "✓ FolderForge server stop signal sent"
        : "• FolderForge server was not running",
    );
    if (receipt.connectivity.kind === "cloudflared-quick") {
      sink.line(
        tunnelStopped
          ? "✓ Cloudflare tunnel stop signal sent"
          : "• Cloudflare tunnel was not running",
      );
    }
    delete receipt.processes.serverPid;
    delete receipt.processes.tunnelPid;
    receipt.checks.localServer = "fail";
    receipt.checks.publicEndpoint =
      receipt.connectivity.kind === "cloudflared-quick"
        ? "fail"
        : receipt.checks.publicEndpoint;
    setLifecycleDiagnostic(
      receipt,
      diagnostic(
        "runtime.local_server",
        "LOCAL_SERVER_READY",
        "fail",
        "The local MCP server was stopped by the user.",
        true,
        "start_server",
        "LOCAL_SERVER_STOPPED",
      ),
    );
    receipt.updatedAt = new Date().toISOString();
    refreshChatGptLifecycle(receipt, false, false);
    receipt.status = "stopped";
    writeConnectionReceipt(paths.receipt, receipt);
    return receipt;
  } finally {
    releaseLock();
  }
}

async function disconnect(
  options: ParsedOptions,
  sink: ProgressSink,
): Promise<ChatGptConnectionReceipt> {
  if (options.purgeLocal && !options.yes) {
    throw new Error(
      "--purge-local requires --yes to avoid accidental data loss",
    );
  }
  const receipt = await stopConnection(options, sink);
  const paths = receiptPaths(options.projectRoot);
  receipt.status = "disconnected";
  receipt.updatedAt = new Date().toISOString();
  sink.line("✓ Local ChatGPT connection marked disconnected");
  sink.line(
    "• Auth0 resources were preserved. FolderForge never deletes remote Auth0 resources automatically.",
  );
  if (options.purgeLocal) {
    for (const path of [paths.config, paths.serverLog, paths.tunnelLog]) {
      rmSync(path, { force: true });
    }
    sink.line("✓ Generated local config and log files removed");
  }
  writeConnectionReceipt(paths.receipt, receipt);
  return receipt;
}

function describeDcrClient(
  activity: Awaited<ReturnType<typeof planChatGptDcrPrune>>["keep"][number],
): string {
  const callback = activity.callbacks[0] ?? "no callback";
  const resource = activity.latestResource ?? "no resource log";
  const latest = activity.latestEventAt ?? "no event timestamp";
  return `${activity.clientId} | ${callback} | ${resource} | latest=${latest}`;
}

async function pruneDcrClients(
  options: ParsedOptions,
  sink: ProgressSink,
): Promise<void> {
  const previous = existingReceipt(options.projectRoot);
  const tenant = await activeAuth0Tenant(options.tenant ?? previous?.tenant);
  const protectedClientIds = new Set<string>();
  for (const clientId of [
    options.clientId,
    previous?.clientId,
    previous?.lifecycle?.detectedClient?.clientId,
  ]) {
    if (clientId) protectedClientIds.add(clientId);
  }

  sink.line(`✓ Auth0 tenant selected (${tenant})`);
  sink.line("• Inspecting ChatGPT DCR clients and recent Auth0 activity...");
  const plan = await planChatGptDcrPrune(tenant, protectedClientIds);
  sink.line(
    `Auth0 inventory: ${plan.countedApplications} counted applications, ${plan.chatGptDcrClients} ChatGPT DCR clients.`,
  );

  sink.line("");
  sink.line(`Protected clients (${plan.keep.length}):`);
  if (plan.keep.length === 0) {
    sink.line("- none");
  } else {
    for (const activity of plan.keep) {
      sink.line(
        `- ${describeDcrClient(activity)} | keep=${activity.protectionReasons.join(",")}`,
      );
    }
  }

  sink.line("");
  sink.line(`Safe deletion candidates (${plan.remove.length}):`);
  if (plan.remove.length === 0) {
    sink.line("- none");
    sink.line("✓ No safely removable duplicate ChatGPT DCR clients were found");
    return;
  }
  for (const activity of plan.remove) {
    sink.line(`- ${describeDcrClient(activity)}`);
  }

  if (!options.yes || options.dryRun) {
    sink.line("");
    sink.line("• No Auth0 clients were deleted.");
    sink.line(
      `  Review the list, then apply the irreversible cleanup with: folderforge chatgpt prune-dcr --tenant ${tenant} --project ${JSON.stringify(options.projectRoot)} --yes`,
    );
    return;
  }

  for (const activity of plan.remove) {
    await deleteChatGptDcrClient(tenant, activity.clientId);
    sink.line(`✓ Deleted stale ChatGPT DCR client ${activity.clientId}`);
  }
  const remaining = await listAuth0Clients(tenant);
  sink.line(
    `✓ Cleanup verified: ${countAuth0Applications(remaining)} counted applications remain; ${plan.remove.length} slot(s) freed.`,
  );
}

async function repairWithoutRestart(
  options: ParsedOptions,
  sink: ProgressSink,
): Promise<ChatGptConnectionReceipt> {
  const paths = receiptPaths(options.projectRoot);
  const releaseLock = acquireLock(paths.lock);
  try {
    const receipt = readConnectionReceipt(paths.receipt);
    const tenant = await activeAuth0Tenant(options.tenant ?? receipt.tenant);
    if (tenant !== receipt.tenant) {
      throw new Error(
        `Refusing to repair tenant ${tenant}; this project receipt belongs to ${receipt.tenant}.`,
      );
    }
    const discovery = await discoverAuth0(tenant, receipt.registration);
    receipt.checks.dependencies = "pass";
    receipt.checks.tenant = "pass";
    receipt.checks.issuerDiscovery = "pass";
    await verifyJwks(discovery);
    receipt.checks.jwks = "pass";

    if (receipt.registration === "dcr") {
      await ensureDynamicClientRegistration(
        tenant,
        receipt.runtime?.autoEnableDcr ?? true,
        false,
        sink,
      );
      receipt.checks.dcr = "pass";
    }

    const provisioned = await provisionAuth0Api(
      tenant,
      receipt.resource,
      false,
      receipt.runtime?.offlineAccess ?? true,
      receipt.runtime?.dcrClientPolicy ?? "require-grant",
    );
    const repairedApiId = provisioned.api.id ?? receipt.auth0.apiId;
    receipt.auth0 = {
      ...(repairedApiId ? { apiId: repairedApiId } : {}),
      apiName: provisioned.api.name ?? receipt.auth0.apiName,
      createdByFolderForge:
        receipt.auth0.createdByFolderForge || provisioned.created,
    };
    receipt.checks.auth0Api = "pass";
    sink.line(
      provisioned.changed
        ? "✓ Auth0 resource server repaired"
        : "✓ Auth0 resource server already matches FolderForge policy",
    );
    if (receipt.registration === "dcr") {
      await ensureDefaultThirdPartyUserGrant(
        tenant,
        receipt.resource,
        receipt.scopes,
        true,
      );
      receipt.checks.userGrant = "pass";
      sink.line("✓ Default third-party Auth0 user grant created or verified");
    }

    const hasStoredClient = Boolean(
      options.clientId ??
      receipt.lifecycle?.detectedClient?.clientId ??
      receipt.clientId,
    );
    if (
      receipt.registration === "dcr" &&
      !hasStoredClient &&
      options.waitForClient
    ) {
      const baselineClientIds = new Set(
        (await listAuth0Clients(tenant)).map((client) => client.client_id),
      );
      sink.line("Waiting for ChatGPT to register an OAuth client...");
      const detected = await waitForChatGptClient({
        tenant,
        resource: receipt.resource,
        baselineClientIds,
        timeoutMs: options.waitTimeoutMs,
        pollIntervalMs: options.pollIntervalMs,
        onProgress: (message) => sink.line(message),
      });
      if (detected) {
        receipt.clientId = detected.clientId;
        receipt.lifecycle ??= {
          sessionId: randomUUID(),
          sessionStartedAt: new Date().toISOString(),
          stage: "CHATGPT_CLIENT_DETECTED",
        };
        receipt.lifecycle.detectedClient = detected;
        receipt.checks.chatgptClient = "pass";
      } else {
        receipt.checks.chatgptClient = "pending";
        setLifecycleDiagnostic(
          receipt,
          diagnostic(
            "auth0.chatgpt_client",
            "WAITING_FOR_CHATGPT_CLIENT",
            "pending",
            "No new session-scoped ChatGPT DCR client requested this resource before the timeout.",
            true,
            "wait_for_dcr_client",
          ),
        );
      }
    }

    await verifyManagedDcrLifecycle(receipt, options, discovery, true, sink);

    try {
      await verifyEndpoint(receipt, 10_000);
      receipt.checks.publicEndpoint = "pass";
      receipt.checks.resourceMetadata = "pass";
      receipt.checks.unauthorizedChallenge = "pass";
      setLifecycleDiagnostic(
        receipt,
        diagnostic(
          "oauth.metadata",
          "OAUTH_METADATA_READY",
          "pass",
          "Public protected-resource metadata and 401 challenge remain valid.",
          true,
          "rerun_verification",
        ),
      );
    } catch (error) {
      receipt.checks.publicEndpoint = "fail";
      receipt.checks.resourceMetadata = "fail";
      receipt.checks.unauthorizedChallenge = "fail";
      recordLifecycleFailure(
        receipt,
        error,
        "oauth.metadata",
        classifyChatGptError(
          error instanceof Error ? error.message : String(error),
        ) === "PUBLIC_ENDPOINT_502"
          ? "PUBLIC_ENDPOINT_READY"
          : "OAUTH_METADATA_READY",
        "restart_tunnel",
      );
    }

    receipt.updatedAt = new Date().toISOString();
    refreshChatGptLifecycle(
      receipt,
      isPidAlive(receipt.processes.serverPid),
      receipt.connectivity.kind !== "cloudflared-quick" ||
        isPidAlive(receipt.processes.tunnelPid),
    );
    writeConnectionReceipt(paths.receipt, receipt);
    return receipt;
  } finally {
    releaseLock();
  }
}

async function repair(
  options: ParsedOptions,
  sink: ProgressSink,
): Promise<ChatGptConnectionReceipt> {
  const previous = existingReceipt(options.projectRoot);
  if (!previous)
    throw new Error(
      "No previous connection exists. Run `folderforge connect chatgpt`.",
    );
  if (!options.start) return await repairWithoutRestart(options, sink);
  sink.line(
    "• Rechecking dependencies, Auth0 configuration, local config and endpoint health",
  );
  const stablePublicUrl =
    options.publicUrl ??
    (previous.connectivity.kind === "stable-url" ? previous.mcpUrl : undefined);
  const quickTunnelReusable =
    previous.connectivity.kind === "cloudflared-quick" &&
    isPidAlive(previous.processes.tunnelPid);
  const storedClientId =
    previous.lifecycle?.detectedClient?.clientId ?? previous.clientId;
  const clientId =
    options.clientId ??
    (stablePublicUrl || quickTunnelReusable ? storedClientId : undefined);
  if (
    !quickTunnelReusable &&
    previous.connectivity.kind === "cloudflared-quick" &&
    storedClientId &&
    !options.clientId
  ) {
    sink.line(
      "• The temporary public URL changed, so the old ChatGPT client will not be granted access to the new resource.",
    );
  }
  return await connect(
    {
      ...options,
      action: "connect",
      mode: options.mode ?? previous.mode,
      tenant: options.tenant ?? previous.tenant,
      ...(stablePublicUrl ? { publicUrl: stablePublicUrl } : {}),
      ...(clientId ? { clientId } : {}),
    },
    sink,
  );
}

function finalHumanOutput(receipt: ChatGptConnectionReceipt): string[] {
  const statusLabels: Record<ChatGptConnectionReceipt["status"], string> = {
    configured: "CONFIGURED",
    waiting: "WAITING FOR CHATGPT",
    ready: "READY TO COMPLETE LOGIN",
    connected: "CONNECTED",
    needs_attention: "NEEDS ATTENTION",
    action_required: "ACTION REQUIRED",
    stopped: "STOPPED",
    disconnected: "DISCONNECTED",
    error: "ERROR",
  };
  const lines = [
    "",
    "MCP URL:",
    receipt.mcpUrl,
    "",
    "Authentication:",
    "OAuth",
    "",
    "Lifecycle:",
    receipt.lifecycleSnapshot?.state ??
      receipt.lifecycle?.stage ??
      "UNCONFIGURED",
    "",
    "Status:",
    statusLabels[receipt.status],
  ];
  if (receipt.status === "waiting") {
    lines.push(
      "",
      "ChatGPT:",
      "Create the connector with the MCP URL above and click Connect. FolderForge will detect the new DCR client automatically.",
      "To resume waiting later, run `folderforge connect chatgpt --wait`.",
    );
  } else if (receipt.status === "ready") {
    lines.push("", "OAuth is ready. Return to ChatGPT and complete sign-in.");
  } else if (receipt.status === "connected") {
    lines.push("", "Authenticated MCP activity has been verified.");
  } else if (receipt.status === "needs_attention") {
    const failed =
      receipt.lifecycleSnapshot?.diagnostics.filter(
        (entry) => entry.status === "fail",
      ) ?? [];
    lines.push(
      "",
      "Diagnostics:",
      ...(failed.length > 0
        ? failed.map(
            (entry) =>
              `- ${(entry.errorState ?? entry.stage).replaceAll("_", " ")}: ${entry.evidence}`,
          )
        : ["- Run `folderforge chatgpt doctor` for details."]),
      "",
      "Repair:",
      "`folderforge chatgpt repair`",
    );
  } else if (receipt.status === "action_required") {
    lines.push(
      "",
      "Predefined-client mode requires an OAuth client configured outside the DCR lifecycle.",
      "Quick mode (`folderforge connect chatgpt --quick`) provides the one-command ChatGPT flow.",
    );
  }
  if (receipt.warnings.length > 0) {
    lines.push(
      "",
      "Warnings:",
      ...receipt.warnings.map((warning) => `- ${warning}`),
    );
  }
  return lines;
}

export async function executeChatGptCli(
  argv: string[],
  options: { cwd?: string; onLine?: (line: string) => void } = {},
): Promise<ChatGptCliResult> {
  const sink = progressSink(options.onLine);
  try {
    const parsed = parseChatGptArgs(argv, options.cwd);
    let receipt: ChatGptConnectionReceipt | undefined;
    switch (parsed.action) {
      case "connect":
        receipt = await connect(parsed, sink);
        break;
      case "status":
        receipt = await status(parsed, sink);
        break;
      case "doctor":
        receipt = await doctor(parsed, sink);
        break;
      case "repair":
        receipt = await repair(parsed, sink);
        break;
      case "start":
        receipt = await startFromReceipt(parsed, sink);
        break;
      case "stop":
        receipt = await stopConnection(parsed, sink);
        break;
      case "disconnect":
        receipt = await disconnect(parsed, sink);
        break;
      case "prune-dcr":
        await pruneDcrClients(parsed, sink);
        break;
    }
    const statusOnly = parsed.action === "status" || parsed.action === "doctor";
    const exitCode =
      !statusOnly &&
      receipt &&
      ["error", "needs_attention", "action_required", "stopped"].includes(
        receipt.status,
      )
        ? 1
        : 0;
    if (parsed.json) {
      return {
        exitCode,
        output: receipt
          ? `${JSON.stringify(receipt, null, 2)}\n`
          : `${JSON.stringify({ ok: true }, null, 2)}\n`,
        ...(receipt ? { receipt } : {}),
      };
    }
    if (receipt) for (const line of finalHumanOutput(receipt)) sink.line(line);
    return { exitCode, output: sink.output(), ...(receipt ? { receipt } : {}) };
  } catch (error) {
    if (error instanceof Error && error.message === "HELP") {
      return { exitCode: 0, output: chatGptHelp() };
    }
    const message = error instanceof Error ? error.message : String(error);
    sink.line(`✗ ${message}`);
    return { exitCode: 1, output: sink.output() };
  }
}
