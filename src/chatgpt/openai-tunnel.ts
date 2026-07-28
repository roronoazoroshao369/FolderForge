import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
  sep,
} from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { redactSensitiveText } from "./lifecycle.js";

const RELEASE_API =
  "https://api.github.com/repos/openai/tunnel-client/releases/latest";
const TUNNELS_URL = "https://platform.openai.com/settings/organization/tunnels";
const RUNTIME_KEYS_URL =
  "https://platform.openai.com/settings/organization/api-keys";
const CHATGPT_CONNECTORS_URL = "https://chatgpt.com/#settings/Connectors";
const DEFAULT_MCP_PORT = 7331;
const DEFAULT_DASHBOARD_PORT = 7332;
const MAX_RELEASE_ARCHIVE_BYTES = 100 * 1024 * 1024;
const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REQUIRED_TUNNEL_CLIENT_FLAGS = [
  "--control-plane.tunnel-id",
  "--control-plane.api-key",
  "--mcp.server-url",
  "--mcp.extra-headers",
  "--mcp.discovery-extra-headers",
  "--health.listen-addr",
  "--health.url-file",
  "--log.level",
  "--log.format",
] as const;
const CLI_ENTRY = fileURLToPath(new URL("../main.js", import.meta.url));

export type OpenAiTunnelPolicyMode = "readonly" | "safe" | "dev" | "danger";
export type OpenAiTunnelToolsPreset =
  | "vibe"
  | "vibe-lite"
  | "readonly"
  | "full"
  | "godot";
export type OpenAiTunnelProfile = "safe" | "developer" | "full";

export interface OpenAiTunnelOptions {
  projectRoot: string;
  tunnelId?: string;
  apiKeyEnv?: string;
  apiKeyFile?: string;
  tunnelClientPath?: string;
  profile: OpenAiTunnelProfile;
  policyMode?: OpenAiTunnelPolicyMode;
  toolsPreset?: OpenAiTunnelToolsPreset;
  port?: number;
  dashboard: boolean;
  dashboardPort?: number;
  autoInstall: boolean;
  installOnly: boolean;
  openBrowser?: boolean;
  dryRun: boolean;
}

export interface OpenAiTunnelReceipt {
  version: 1;
  provider: "openai-secure-mcp-tunnel";
  projectRoot: string;
  tunnelId: string;
  apiKeyRef: string;
  profile: OpenAiTunnelProfile;
  policyMode: OpenAiTunnelPolicyMode;
  toolsPreset: OpenAiTunnelToolsPreset;
  dashboard: boolean;
  tunnelClient: {
    path: string;
    version: string;
  };
  lastRuntime?: {
    mcpPort: number;
    dashboardPort?: number;
    localMcpUrl: string;
    tunnelUiUrl?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface OpenAiTunnelCliResult {
  exitCode: number;
  output: string;
  receipt?: OpenAiTunnelReceipt;
}

interface ProgressSink {
  line(message: string): void;
  output(): string;
}

interface GithubReleaseAsset {
  name?: unknown;
  size?: unknown;
  browser_download_url?: unknown;
  digest?: unknown;
}

interface GithubRelease {
  tag_name?: unknown;
  assets?: unknown;
}

interface SelectedReleaseAsset {
  tag: string;
  version: string;
  name: string;
  size: number;
  url: string;
  sha256: string;
}

interface ResolvedRuntime {
  tunnelId: string;
  apiKeyRef: string;
  policyMode: OpenAiTunnelPolicyMode;
  toolsPreset: OpenAiTunnelToolsPreset;
  tunnelClientPath: string;
  tunnelClientVersion: string;
  mcpPort: number;
  dashboardPort?: number;
  localMcpUrl: string;
  healthUrlFile: string;
  serverLog: string;
}

export interface OpenAiTunnelCliHooks {
  onLine?: (line: string) => void;
  fetchImpl?: typeof fetch;
  cliEntry?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  stdoutIsTty?: boolean;
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
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePort(value: string, flag: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${flag} must be an integer from 1 to 65535`);
  }
  return port;
}

function parseEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  flag: string,
): T {
  if (!allowed.includes(value as T)) {
    throw new Error(`${flag} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

export function parseOpenAiTunnelArgs(
  argv: string[],
  cwd = process.cwd(),
): OpenAiTunnelOptions {
  const options: OpenAiTunnelOptions = {
    projectRoot: resolve(cwd),
    profile: "developer",
    dashboard: true,
    autoInstall: true,
    installOnly: false,
    dryRun: false,
  };

  const startIndex = argv[0] === "connect" ? 1 : 0;
  for (let index = startIndex; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case "--openai-tunnel":
        break;
      case "--project":
      case "-p":
        options.projectRoot = resolve(valueAfter(argv, index, arg));
        index += 1;
        break;
      case "--tunnel-id":
        options.tunnelId = valueAfter(argv, index, arg);
        index += 1;
        break;
      case "--api-key-env":
        options.apiKeyEnv = valueAfter(argv, index, arg);
        index += 1;
        break;
      case "--api-key-file":
        options.apiKeyFile = resolve(valueAfter(argv, index, arg));
        index += 1;
        break;
      case "--tunnel-client":
        options.tunnelClientPath = resolve(valueAfter(argv, index, arg));
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
      case "--port":
        options.port = parsePort(valueAfter(argv, index, arg), arg);
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
      case "--no-install":
        options.autoInstall = false;
        break;
      case "--install-only":
        options.installOnly = true;
        break;
      case "--open":
        options.openBrowser = true;
        break;
      case "--no-open":
        options.openBrowser = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        throw new Error("HELP");
      default:
        throw new Error(`Unknown OpenAI tunnel option: ${arg}`);
    }
  }

  if (options.apiKeyEnv && options.apiKeyFile) {
    throw new Error("Choose only one of --api-key-env or --api-key-file");
  }
  return options;
}

export function openAiTunnelHelp(): string {
  return [
    "FolderForge + OpenAI Secure MCP Tunnel",
    "",
    "Usage:",
    "  folderforge connect chatgpt --openai-tunnel [options]",
    "",
    "First run:",
    "  export CONTROL_PLANE_API_KEY='sk-...'",
    "  folderforge connect chatgpt --openai-tunnel --tunnel-id tunnel_<32-hex>",
    "",
    "Later runs:",
    "  folderforge connect chatgpt --openai-tunnel",
    "",
    "The command installs the official openai/tunnel-client when needed, starts a",
    "loopback-only authenticated FolderForge MCP server, verifies tunnel readiness,",
    "opens the local tunnel UI and ChatGPT connector settings, and supervises both",
    "processes until Ctrl+C. API key values are never written to disk or argv.",
    "",
    "Options:",
    "  -p, --project <dir>       Project to expose (default current directory)",
    "      --tunnel-id <id>      OpenAI tunnel ID; otherwise env/previous receipt",
    "      --api-key-env <name>  Runtime API key environment variable",
    "      --api-key-file <path> Runtime API key file (must not be group/world-readable)",
    "      --tunnel-client <path> Use an existing tunnel-client binary",
    "      --no-install          Do not auto-install the official client when missing",
    "      --install-only        Install/verify tunnel-client, then exit",
    "      --profile <id>        safe|developer|full (default developer)",
    "      --full-access         Shortcut for --profile full; CRITICAL bypass stays off",
    "      --policy <mode>       readonly|safe|dev|danger",
    "      --tools-preset <id>   vibe|vibe-lite|readonly|full|godot",
    "      --port <n>            Preferred local MCP port (default 7331 or free port)",
    "      --dashboard/--no-dashboard  Local approval dashboard (default enabled)",
    "      --dashboard-port <n>  Preferred dashboard port (default 7332 or free port)",
    "      --open/--no-open      Open tunnel UI and ChatGPT settings (default on TTY)",
    "      --dry-run             Validate and print the launch plan without starting",
    "",
    `Create or inspect a tunnel: ${TUNNELS_URL}`,
    `Create a runtime API key:   ${RUNTIME_KEYS_URL}`,
    `ChatGPT connector settings: ${CHATGPT_CONNECTORS_URL}`,
    "",
  ].join("\n");
}

export function validateTunnelId(value: string): string {
  const normalized = value.trim();
  if (!TUNNEL_ID_PATTERN.test(normalized)) {
    throw new Error(
      "Tunnel ID must be tunnel_ followed by 32 lowercase hexadecimal characters",
    );
  }
  return normalized;
}

function ensureSafeDirectory(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing unsafe local state directory: ${path}`);
  }
}

function ensureSafeRegularFile(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing unsafe local state file: ${path}`);
  }
}

function statePaths(projectRoot: string): {
  stateDir: string;
  receipt: string;
  healthUrl: string;
  serverLog: string;
} {
  const stateDir = join(projectRoot, ".folderforge");
  return {
    stateDir,
    receipt: join(stateDir, "openai-tunnel.json"),
    healthUrl: join(stateDir, `openai-tunnel-health-${process.pid}.url`),
    serverLog: join(stateDir, "openai-tunnel-server.log"),
  };
}

export function readOpenAiTunnelReceipt(
  path: string,
): OpenAiTunnelReceipt | undefined {
  if (!existsSync(path)) return undefined;
  ensureSafeDirectory(dirname(path));
  ensureSafeRegularFile(path);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as OpenAiTunnelReceipt;
  if (
    parsed.version !== 1 ||
    parsed.provider !== "openai-secure-mcp-tunnel" ||
    !TUNNEL_ID_PATTERN.test(parsed.tunnelId) ||
    typeof parsed.apiKeyRef !== "string"
  ) {
    throw new Error(`Unsupported OpenAI tunnel receipt at ${path}`);
  }
  assertSecretSafeReceipt(parsed);
  return parsed;
}

function assertSecretSafeReceipt(receipt: OpenAiTunnelReceipt): void {
  const serialized = JSON.stringify(receipt);
  if (/\bsk-[A-Za-z0-9_-]{12,}/.test(serialized)) {
    throw new Error("OpenAI tunnel receipt must not contain an API key value");
  }
  const envRef = receipt.apiKeyRef.startsWith("env:")
    ? receipt.apiKeyRef.slice(4)
    : undefined;
  const fileRef = receipt.apiKeyRef.startsWith("file:")
    ? receipt.apiKeyRef.slice(5)
    : undefined;
  if (
    !(
      (envRef !== undefined && ENV_NAME_PATTERN.test(envRef)) ||
      (fileRef !== undefined && isAbsolute(fileRef))
    )
  ) {
    throw new Error("OpenAI tunnel receipt contains an unsafe API key reference");
  }
}

export function writeOpenAiTunnelReceipt(
  path: string,
  receipt: OpenAiTunnelReceipt,
): void {
  assertSecretSafeReceipt(receipt);
  ensureSafeDirectory(dirname(path));
  ensureSafeRegularFile(path);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function profileDefaults(profile: OpenAiTunnelProfile): {
  policyMode: OpenAiTunnelPolicyMode;
  toolsPreset: OpenAiTunnelToolsPreset;
} {
  switch (profile) {
    case "safe":
      return { policyMode: "safe", toolsPreset: "vibe-lite" };
    case "full":
      return { policyMode: "danger", toolsPreset: "full" };
    default:
      return { policyMode: "dev", toolsPreset: "full" };
  }
}

function resolveApiKeyRef(
  options: OpenAiTunnelOptions,
  previous: OpenAiTunnelReceipt | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  if (options.apiKeyEnv) {
    if (!ENV_NAME_PATTERN.test(options.apiKeyEnv)) {
      throw new Error("--api-key-env must be a valid environment variable name");
    }
    if (!env[options.apiKeyEnv]?.trim()) {
      throw new Error(`Environment variable ${options.apiKeyEnv} is empty or unset`);
    }
    return `env:${options.apiKeyEnv}`;
  }
  if (options.apiKeyFile) {
    const path = realpathSync(options.apiKeyFile);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size === 0) {
      throw new Error("--api-key-file must point to a non-empty regular file");
    }
    if (platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error(
        `API key file permissions are too broad; run chmod 600 ${path}`,
      );
    }
    return `file:${path}`;
  }

  if (previous?.apiKeyRef) {
    if (previous.apiKeyRef.startsWith("env:")) {
      const name = previous.apiKeyRef.slice(4);
      if (ENV_NAME_PATTERN.test(name) && env[name]?.trim()) return previous.apiKeyRef;
    } else if (previous.apiKeyRef.startsWith("file:")) {
      const path = previous.apiKeyRef.slice(5);
      if (existsSync(path)) {
        const stat = lstatSync(path);
        if (stat.isFile() && stat.size > 0 && (platform === "win32" || (stat.mode & 0o077) === 0)) {
          return previous.apiKeyRef;
        }
      }
    }
  }

  if (env.CONTROL_PLANE_API_KEY?.trim()) return "env:CONTROL_PLANE_API_KEY";
  if (env.OPENAI_API_KEY?.trim()) return "env:OPENAI_API_KEY";
  throw new Error(
    `No runtime API key found. Export CONTROL_PLANE_API_KEY or use --api-key-file. Create one at ${RUNTIME_KEYS_URL}`,
  );
}

function executableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "tunnel-client.exe" : "tunnel-client";
}

function platformTarget(platform: NodeJS.Platform, arch: string): string {
  const platformName =
    platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : undefined;
  const archName = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : undefined;
  if (!platformName || !archName) {
    throw new Error(`Unsupported tunnel-client platform: ${platform}/${arch}`);
  }
  return `${platformName}_${archName}`;
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  try {
    const real = realpathSync(path);
    const stat = lstatSync(real);
    if (!stat.isFile()) return false;
    if (platform !== "win32") accessSync(real, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  const pathValue = env.PATH;
  if (!pathValue) return undefined;
  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (isExecutable(candidate, platform)) return realpathSync(candidate);
    }
  }
  return undefined;
}

function managedBinaryPath(home: string, platform: NodeJS.Platform): string {
  return join(home, ".folderforge", "bin", executableName(platform));
}

export function selectTunnelClientReleaseAsset(
  release: GithubRelease,
): SelectedReleaseAsset {
  if (typeof release.tag_name !== "string" || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) {
    throw new Error("GitHub returned an invalid tunnel-client release tag");
  }
  if (!Array.isArray(release.assets)) {
    throw new Error("GitHub tunnel-client release has no assets");
  }
  const expectedName = `tunnel-client-${release.tag_name}-all.tar.gz`;
  const asset = (release.assets as GithubReleaseAsset[]).find(
    (candidate) => candidate.name === expectedName,
  );
  if (!asset) throw new Error(`Official release asset ${expectedName} was not found`);
  if (
    typeof asset.size !== "number" ||
    asset.size <= 0 ||
    asset.size > MAX_RELEASE_ARCHIVE_BYTES
  ) {
    throw new Error("Official tunnel-client archive has an invalid size");
  }
  if (typeof asset.browser_download_url !== "string") {
    throw new Error("Official tunnel-client archive URL is missing");
  }
  const url = new URL(asset.browser_download_url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    !url.pathname.startsWith(`/openai/tunnel-client/releases/download/${release.tag_name}/`)
  ) {
    throw new Error("Refusing a non-official tunnel-client release URL");
  }
  if (typeof asset.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(asset.digest)) {
    throw new Error("Official tunnel-client archive is missing a SHA-256 digest");
  }
  return {
    tag: release.tag_name,
    version: release.tag_name.slice(1),
    name: expectedName,
    size: asset.size,
    url: asset.browser_download_url,
    sha256: asset.digest.slice("sha256:".length),
  };
}

function findExtractedBinary(
  root: string,
  target: string,
  name: string,
  depth = 0,
): string | undefined {
  if (depth > 5) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findExtractedBinary(path, target, name, depth + 1);
      if (nested) return nested;
    } else if (
      entry.isFile() &&
      entry.name === name &&
      path.split(sep).slice(-3, -1).join("/") === `bin/${target}`
    ) {
      return path;
    }
  }
  return undefined;
}

async function installOfficialTunnelClient(
  destination: string,
  fetchImpl: typeof fetch,
  platform: NodeJS.Platform,
  arch: string,
  sink: ProgressSink,
): Promise<{ path: string; version: string }> {
  sink.line("• Downloading official OpenAI tunnel-client release metadata...");
  const releaseResponse = await fetchImpl(RELEASE_API, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "folderforge-openai-tunnel-installer",
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!releaseResponse.ok) {
    throw new Error(`GitHub release lookup returned HTTP ${releaseResponse.status}`);
  }
  const asset = selectTunnelClientReleaseAsset(
    (await releaseResponse.json()) as GithubRelease,
  );
  const target = platformTarget(platform, arch);
  const binaryName = executableName(platform);
  const destinationDir = dirname(destination);
  ensureSafeDirectory(dirname(destinationDir));
  ensureSafeDirectory(destinationDir);
  ensureSafeRegularFile(destination);
  const staging = join(destinationDir, `.install-${randomUUID()}`);
  const archivePath = join(staging, asset.name);
  mkdirSync(staging, { recursive: true, mode: 0o700 });

  try {
    sink.line(`• Downloading tunnel-client ${asset.tag} for ${target}...`);
    const archiveResponse = await fetchImpl(asset.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    if (!archiveResponse.ok) {
      throw new Error(`Tunnel-client download returned HTTP ${archiveResponse.status}`);
    }
    const contentLength = Number(archiveResponse.headers.get("content-length") ?? "0");
    if (contentLength > MAX_RELEASE_ARCHIVE_BYTES) {
      throw new Error("Tunnel-client archive exceeds the maximum allowed size");
    }
    const archive = Buffer.from(await archiveResponse.arrayBuffer());
    if (archive.length === 0 || archive.length > MAX_RELEASE_ARCHIVE_BYTES) {
      throw new Error("Tunnel-client archive has an invalid downloaded size");
    }
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest !== asset.sha256) {
      throw new Error("Tunnel-client SHA-256 verification failed");
    }
    writeFileSync(archivePath, archive, { mode: 0o600 });

    const suffix = `/bin/${target}/${binaryName}`;
    await tar.x({
      cwd: staging,
      file: archivePath,
      strict: true,
      filter: (path) => path.endsWith(suffix),
    });
    const extracted = findExtractedBinary(staging, target, binaryName);
    if (!extracted) {
      throw new Error(`Release archive does not contain ${target}/${binaryName}`);
    }
    const extractedReal = realpathSync(extracted);
    const stagingReal = `${realpathSync(staging)}${sep}`;
    if (!extractedReal.startsWith(stagingReal) || !lstatSync(extractedReal).isFile()) {
      throw new Error("Refusing an unsafe tunnel-client archive entry");
    }

    mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
    const temporaryDestination = join(
      destinationDir,
      `.${basename(destination)}-${randomUUID()}.tmp`,
    );
    copyFileSync(extractedReal, temporaryDestination, constants.COPYFILE_EXCL);
    if (platform !== "win32") chmodSync(temporaryDestination, 0o755);
    renameSync(temporaryDestination, destination);
    sink.line(`✓ Installed verified tunnel-client ${asset.tag}`);
    return { path: destination, version: asset.version };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function inspectTunnelClient(path: string): { path: string; version: string } {
  const real = realpathSync(path);
  const versionResult = spawnSync(real, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (versionResult.error || versionResult.status !== 0) {
    throw new Error(
      `Unable to execute tunnel-client at ${real}: ${versionResult.error?.message ?? versionResult.stderr?.trim() ?? `exit ${versionResult.status}`}`,
    );
  }
  const output = `${versionResult.stdout ?? ""}\n${versionResult.stderr ?? ""}`.trim();
  const match = output.match(/v?(\d+\.\d+\.\d+)/);

  const helpResult = spawnSync(real, ["run", "--help"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (helpResult.error || helpResult.status !== 0) {
    throw new Error(
      `Unable to inspect tunnel-client run options at ${real}: ${helpResult.error?.message ?? helpResult.stderr?.trim() ?? `exit ${helpResult.status}`}`,
    );
  }
  const help = `${helpResult.stdout ?? ""}\n${helpResult.stderr ?? ""}`;
  const missing = REQUIRED_TUNNEL_CLIENT_FLAGS.filter(
    (flag) => !help.includes(flag),
  );
  if (missing.length > 0) {
    throw new Error(
      `Incompatible tunnel-client at ${real}; missing required options: ${missing.join(", ")}`,
    );
  }

  return {
    path: real,
    version: match?.[1] ?? (output || "unknown"),
  };
}

async function resolveTunnelClient(
  options: OpenAiTunnelOptions,
  hooks: Required<Pick<OpenAiTunnelCliHooks, "fetchImpl" | "homeDir" | "platform" | "arch" | "env">>,
  previous: OpenAiTunnelReceipt | undefined,
  sink: ProgressSink,
): Promise<{ path: string; version: string }> {
  const requested =
    options.tunnelClientPath ??
    hooks.env.FOLDERFORGE_TUNNEL_CLIENT ??
    findOnPath("tunnel-client", hooks.env, hooks.platform) ??
    (previous?.tunnelClient.path && isExecutable(previous.tunnelClient.path, hooks.platform)
      ? previous.tunnelClient.path
      : undefined);
  if (requested) {
    if (!isExecutable(requested, hooks.platform)) {
      throw new Error(`Tunnel-client is not executable: ${requested}`);
    }
    const inspected = inspectTunnelClient(requested);
    sink.line(`✓ tunnel-client detected (${inspected.version})`);
    return inspected;
  }

  const managed = managedBinaryPath(hooks.homeDir, hooks.platform);
  if (isExecutable(managed, hooks.platform)) {
    const inspected = inspectTunnelClient(managed);
    sink.line(`✓ Managed tunnel-client detected (${inspected.version})`);
    return inspected;
  }
  if (!options.autoInstall) {
    throw new Error(
      `tunnel-client is not installed. Download it from ${TUNNELS_URL} or remove --no-install`,
    );
  }
  const installed = await installOfficialTunnelClient(
    managed,
    hooks.fetchImpl,
    hooks.platform,
    hooks.arch,
    sink,
  );
  return inspectTunnelClient(installed.path);
}

async function canBind(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolveResult) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolveResult(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolveResult(true));
    });
  });
}

async function findFreePort(preferred: number, explicit: boolean): Promise<number> {
  if (await canBind(preferred)) return preferred;
  if (explicit) throw new Error(`Port ${preferred} is already in use`);
  return await new Promise<number>((resolveResult, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a local port"));
        return;
      }
      const port = address.port;
      server.close(() => resolveResult(port));
    });
  });
}

export function buildFolderForgeServerArgs(
  cliEntry: string,
  options: Pick<
    ResolvedRuntime,
    "mcpPort" | "dashboardPort" | "policyMode" | "toolsPreset"
  > & { projectRoot: string; dashboard: boolean },
): string[] {
  return [
    cliEntry,
    "--project",
    options.projectRoot,
    "--http",
    "--host",
    "127.0.0.1",
    "--port",
    String(options.mcpPort),
    "--auth",
    "token",
    "--require-auth",
    "--policy",
    options.policyMode,
    "--tools-preset",
    options.toolsPreset,
    ...(options.dashboard && options.dashboardPort
      ? ["--dashboard-port", String(options.dashboardPort)]
      : ["--no-dashboard"]),
  ];
}

export function buildTunnelClientArgs(runtime: ResolvedRuntime): string[] {
  return [
    "run",
    "--control-plane.tunnel-id",
    runtime.tunnelId,
    "--control-plane.api-key",
    runtime.apiKeyRef,
    "--mcp.server-url",
    runtime.localMcpUrl,
    "--mcp.extra-headers",
    "X-API-Key: env:FOLDERFORGE_OPENAI_TUNNEL_LOCAL_TOKEN",
    "--mcp.discovery-extra-headers",
    "X-API-Key: env:FOLDERFORGE_OPENAI_TUNNEL_LOCAL_TOKEN",
    "--health.listen-addr",
    "127.0.0.1:0",
    "--health.url-file",
    runtime.healthUrlFile,
    "--log.level",
    "info",
    "--log.format",
    "struct-text",
  ];
}

export function buildOpenAiTunnelChildEnvironments(
  baseEnv: NodeJS.ProcessEnv,
  apiKeyRef: string,
  localToken: string,
): { serverEnv: NodeJS.ProcessEnv; tunnelEnv: NodeJS.ProcessEnv } {
  const serverEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    FOLDERFORGE_HTTP_TOKEN: localToken,
  };
  const tunnelEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    FOLDERFORGE_OPENAI_TUNNEL_LOCAL_TOKEN: localToken,
  };

  // The workspace-facing FolderForge child must never inherit the control-plane
  // credential selected for tunnel-client. This prevents governed shell commands
  // from reading or forwarding the tunnel credential from their environment.
  const selectedApiKeyEnv = apiKeyRef.startsWith("env:")
    ? apiKeyRef.slice(4)
    : undefined;
  delete serverEnv.CONTROL_PLANE_API_KEY;
  delete serverEnv.OPENAI_API_KEY;
  if (selectedApiKeyEnv) delete serverEnv[selectedApiKeyEnv];
  for (const name of ["CONTROL_PLANE_API_KEY", "OPENAI_API_KEY"]) {
    if (name !== selectedApiKeyEnv) delete tunnelEnv[name];
  }
  delete serverEnv.FOLDERFORGE_OPENAI_TUNNEL_LOCAL_TOKEN;
  delete tunnelEnv.FOLDERFORGE_HTTP_TOKEN;

  return { serverEnv, tunnelEnv };
}

function tailFile(path: string, max = 6_000): string {
  if (!existsSync(path)) return "";
  const value = readFileSync(path, "utf8");
  return value.length <= max ? value : value.slice(-max);
}

async function waitForFolderForge(
  url: string,
  child: ChildProcess,
  logPath: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `FolderForge exited before becoming healthy.\n${tailFile(logPath)}`.trim(),
      );
    }
    try {
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
      const body = (await response.json()) as { ok?: unknown };
      if (response.ok && body.ok === true) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }
  throw new Error(
    `FolderForge health check timed out (${lastError}).\n${tailFile(logPath)}`.trim(),
  );
}

function normalizeLocalHealthBase(raw: string): string {
  const url = new URL(raw.trim());
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)
  ) {
    throw new Error("Tunnel-client health URL must remain on loopback HTTP");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function waitForTunnelReady(
  healthUrlFile: string,
  child: ChildProcess,
  timeoutMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let baseUrl: string | undefined;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`tunnel-client exited before readiness (exit ${child.exitCode})`);
    }
    if (!baseUrl && existsSync(healthUrlFile)) {
      const value = readFileSync(healthUrlFile, "utf8").trim();
      if (value) baseUrl = normalizeLocalHealthBase(value);
    }
    if (baseUrl) {
      try {
        const response = await fetch(`${baseUrl}/readyz`, {
          redirect: "error",
          signal: AbortSignal.timeout(3_000),
        });
        if (response.ok) return baseUrl;
        lastError = `readyz returned HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 300));
  }
  throw new Error(`Secure MCP Tunnel readiness timed out${lastError ? `: ${lastError}` : ""}`);
}

function startLoggedProcess(
  command: string,
  args: string[],
  cwd: string,
  logPath: string,
  env: NodeJS.ProcessEnv,
): ChildProcess {
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  writeFileSync(logPath, "", { mode: 0o600 });
  const fd = openSync(logPath, "a", 0o600);
  try {
    return spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    closeSync(fd);
  }
}

async function terminateChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function openUrl(url: string, platform: NodeJS.Platform): void {
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args =
    platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    // Opening a convenience URL is best-effort and must not crash the supervisor.
  });
  child.unref();
}

async function resolveRuntime(
  options: OpenAiTunnelOptions,
  hooks: Required<
    Pick<
      OpenAiTunnelCliHooks,
      "fetchImpl" | "homeDir" | "platform" | "arch" | "env"
    >
  >,
  previous: OpenAiTunnelReceipt | undefined,
  sink: ProgressSink,
): Promise<ResolvedRuntime> {
  const defaults = profileDefaults(options.profile);
  const tunnelId = validateTunnelId(
    options.tunnelId ?? hooks.env.CONTROL_PLANE_TUNNEL_ID ?? previous?.tunnelId ?? "",
  );
  const apiKeyRef = resolveApiKeyRef(options, previous, hooks.env, hooks.platform);
  const tunnelClient = await resolveTunnelClient(options, hooks, previous, sink);
  const mcpPort = await findFreePort(options.port ?? DEFAULT_MCP_PORT, options.port !== undefined);
  const dashboardPort = options.dashboard
    ? await findFreePort(
        options.dashboardPort ?? DEFAULT_DASHBOARD_PORT,
        options.dashboardPort !== undefined,
      )
    : undefined;
  const paths = statePaths(options.projectRoot);
  return {
    tunnelId,
    apiKeyRef,
    policyMode: options.policyMode ?? defaults.policyMode,
    toolsPreset: options.toolsPreset ?? defaults.toolsPreset,
    tunnelClientPath: tunnelClient.path,
    tunnelClientVersion: tunnelClient.version,
    mcpPort,
    ...(dashboardPort !== undefined ? { dashboardPort } : {}),
    localMcpUrl: `http://127.0.0.1:${mcpPort}/mcp`,
    healthUrlFile: paths.healthUrl,
    serverLog: paths.serverLog,
  };
}

export async function executeOpenAiTunnelCli(
  argv: string[],
  hooks: OpenAiTunnelCliHooks = {},
): Promise<OpenAiTunnelCliResult> {
  const sink = progressSink(hooks.onLine);
  let options: OpenAiTunnelOptions;
  try {
    options = parseOpenAiTunnelArgs(argv);
  } catch (error) {
    if (error instanceof Error && error.message === "HELP") {
      return { exitCode: 0, output: openAiTunnelHelp() };
    }
    return {
      exitCode: 1,
      output: `${error instanceof Error ? error.message : String(error)}\n\n${openAiTunnelHelp()}`,
    };
  }

  const resolvedHooks = {
    fetchImpl: hooks.fetchImpl ?? fetch,
    cliEntry: hooks.cliEntry ?? CLI_ENTRY,
    homeDir: hooks.homeDir ?? homedir(),
    platform: hooks.platform ?? process.platform,
    arch: hooks.arch ?? process.arch,
    env: hooks.env ?? process.env,
    stdoutIsTty: hooks.stdoutIsTty ?? Boolean(process.stdout.isTTY),
  };

  let server: ChildProcess | undefined;
  let tunnel: ChildProcess | undefined;
  let stopping = false;
  let signalHandler: (() => void) | undefined;
  let paths = statePaths(options.projectRoot);
  try {
    const projectStat = statSync(options.projectRoot);
    if (!projectStat.isDirectory()) throw new Error("--project must be a directory");
    options.projectRoot = realpathSync(options.projectRoot);
    paths = statePaths(options.projectRoot);
    ensureSafeDirectory(paths.stateDir);
    ensureSafeRegularFile(paths.healthUrl);
    ensureSafeRegularFile(paths.serverLog);
    const previous = readOpenAiTunnelReceipt(paths.receipt);

    if (options.installOnly) {
      const tunnelClient = await resolveTunnelClient(
        options,
        resolvedHooks,
        previous,
        sink,
      );
      sink.line(
        `✓ tunnel-client ${tunnelClient.version} ready at ${tunnelClient.path}`,
      );
      return { exitCode: 0, output: sink.output() };
    }

    const runtime = await resolveRuntime(options, resolvedHooks, previous, sink);

    const serverArgs = buildFolderForgeServerArgs(resolvedHooks.cliEntry, {
      projectRoot: options.projectRoot,
      dashboard: options.dashboard,
      mcpPort: runtime.mcpPort,
      ...(runtime.dashboardPort !== undefined
        ? { dashboardPort: runtime.dashboardPort }
        : {}),
      policyMode: runtime.policyMode,
      toolsPreset: runtime.toolsPreset,
    });
    const tunnelArgs = buildTunnelClientArgs(runtime);
    if (options.dryRun) {
      sink.line("✓ OpenAI Secure MCP Tunnel launch plan is valid");
      sink.line(`  project: ${options.projectRoot}`);
      sink.line(`  tunnel: ${runtime.tunnelId}`);
      sink.line(`  API key: ${runtime.apiKeyRef}`);
      sink.line(`  local MCP: ${runtime.localMcpUrl} (token-authenticated)`);
      sink.line(`  policy/tools: ${runtime.policyMode}/${runtime.toolsPreset}`);
      sink.line(`  tunnel-client: ${runtime.tunnelClientPath} (${runtime.tunnelClientVersion})`);
      sink.line(`  FolderForge argv: ${process.execPath} ${serverArgs.join(" ")}`);
      sink.line(`  tunnel-client argv: ${runtime.tunnelClientPath} ${tunnelArgs.join(" ")}`);
      return { exitCode: 0, output: sink.output() };
    }

    if (!existsSync(resolvedHooks.cliEntry)) {
      throw new Error(
        `Built FolderForge CLI not found at ${resolvedHooks.cliEntry}. Run npm run build and retry.`,
      );
    }
    try {
      unlinkSync(runtime.healthUrlFile);
    } catch {
      // No stale health file.
    }

    const localToken = randomBytes(32).toString("hex");
    const { serverEnv, tunnelEnv } = buildOpenAiTunnelChildEnvironments(
      resolvedHooks.env,
      runtime.apiKeyRef,
      localToken,
    );

    sink.line(`• Starting FolderForge for ${options.projectRoot}...`);
    server = startLoggedProcess(
      process.execPath,
      serverArgs,
      options.projectRoot,
      runtime.serverLog,
      serverEnv,
    );
    await waitForFolderForge(
      `http://127.0.0.1:${runtime.mcpPort}/healthz`,
      server,
      runtime.serverLog,
    );
    sink.line(`✓ Local authenticated MCP ready at ${runtime.localMcpUrl}`);
    if (options.dashboard && runtime.dashboardPort) {
      sink.line(`✓ Approval dashboard: http://127.0.0.1:${runtime.dashboardPort}`);
    }

    sink.line(`• Connecting OpenAI Secure MCP Tunnel ${runtime.tunnelId}...`);
    tunnel = spawn(runtime.tunnelClientPath, tunnelArgs, {
      cwd: options.projectRoot,
      env: tunnelEnv,
      shell: false,
      windowsHide: true,
      stdio: "inherit",
    });

    signalHandler = (): void => {
      if (stopping) return;
      stopping = true;
      if (tunnel && tunnel.exitCode === null) tunnel.kill("SIGTERM");
      if (server && server.exitCode === null) server.kill("SIGTERM");
    };
    process.once("SIGINT", signalHandler);
    process.once("SIGTERM", signalHandler);

    const healthBase = await waitForTunnelReady(runtime.healthUrlFile, tunnel);
    const now = new Date().toISOString();
    const receipt: OpenAiTunnelReceipt = {
      version: 1,
      provider: "openai-secure-mcp-tunnel",
      projectRoot: options.projectRoot,
      tunnelId: runtime.tunnelId,
      apiKeyRef: runtime.apiKeyRef,
      profile: options.profile,
      policyMode: runtime.policyMode,
      toolsPreset: runtime.toolsPreset,
      dashboard: options.dashboard,
      tunnelClient: {
        path: runtime.tunnelClientPath,
        version: runtime.tunnelClientVersion,
      },
      lastRuntime: {
        mcpPort: runtime.mcpPort,
        ...(runtime.dashboardPort !== undefined
          ? { dashboardPort: runtime.dashboardPort }
          : {}),
        localMcpUrl: runtime.localMcpUrl,
        tunnelUiUrl: `${healthBase}/ui`,
      },
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    writeOpenAiTunnelReceipt(paths.receipt, receipt);

    sink.line("✓ OpenAI Secure MCP Tunnel is healthy and ready");
    sink.line(`  Tunnel UI: ${healthBase}/ui`);
    sink.line(`  ChatGPT settings: ${CHATGPT_CONNECTORS_URL}`);
    sink.line(`  Select or paste tunnel ID: ${runtime.tunnelId}`);
    sink.line("  Press Ctrl+C to stop FolderForge and the tunnel.");

    const shouldOpen = options.openBrowser ?? resolvedHooks.stdoutIsTty;
    if (shouldOpen) {
      openUrl(`${healthBase}/ui`, resolvedHooks.platform);
      openUrl(CHATGPT_CONNECTORS_URL, resolvedHooks.platform);
    }

    const exit = await waitForExit(tunnel);
    if (stopping || exit.signal === "SIGINT" || exit.signal === "SIGTERM") {
      return { exitCode: 0, output: sink.output(), receipt };
    }
    if (exit.code !== 0) {
      throw new Error(`tunnel-client exited unexpectedly with code ${exit.code}`);
    }
    return { exitCode: 0, output: sink.output(), receipt };
  } catch (error) {
    sink.line(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return { exitCode: 1, output: sink.output() };
  } finally {
    if (signalHandler) {
      process.removeListener("SIGINT", signalHandler);
      process.removeListener("SIGTERM", signalHandler);
    }
    await terminateChild(tunnel);
    await terminateChild(server);
    try {
      unlinkSync(paths.healthUrl);
    } catch {
      // Best-effort per-run cleanup.
    }
  }
}
