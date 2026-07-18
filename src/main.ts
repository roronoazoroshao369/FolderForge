#!/usr/bin/env node
import {
  loadConfig,
  ensureConfigFile,
  applyHttpAuthDefaults,
  validateConfig,
} from "./core/config.js";
import { Container } from "./core/container.js";
import {
  buildRegistry,
  registerAdapterTools,
  resolveActiveTools,
} from "./tools/index.js";
import { createMcpServer } from "./server/mcp-server.js";
import { startStdioTransport } from "./server/transports/stdio.js";
import { startHttpTransport } from "./server/transports/http.js";
import { startDashboard, isLoopbackHost } from "./dashboard/server.js";
import { logger } from "./core/logger.js";
import { readFolderForgeVersion } from "./core/version.js";
import { executeDoctorCli } from "./doctor/index.js";
import { executeBrowserSetupCli } from "./setup/browser.js";
import { executeChatGptCli } from "./chatgpt/cli.js";
import type { OAuthHttpAuthConfig, ToolPrincipal } from "./core/types.js";
import { STDIO_AGENT_PRINCIPAL } from "./core/principal.js";

const VERSION = readFolderForgeVersion();

interface CliArgs {
  project?: string;
  config?: string;
  stdio: boolean;
  http: boolean;
  port?: number;
  host?: string;
  dashboard: boolean;
  dashboardPort?: number;
  toolsPreset?: string;
  toolsGroups?: string[];
  toolsEnable?: string[];
  toolsDisable?: string[];
  policyMode?: string;
  token?: string;
  apiKeys?: string[];
  requireAuth?: boolean;
  authMode?: "none" | "token" | "oauth";
  oauthResource?: string;
  oauthIssuer?: string;
  oauthScopes?: string[];
  oauthReadScope?: string;
  oauthWriteScope?: string;
  oauthClientRegistration?: "cimd" | "dcr" | "predefined";
  oauthJwksUri?: string;
  oauthTrustedJwksHosts?: string[];
  oauthAlgorithms?: string[];
  oauthResourceDocumentation?: string;
  unsafeOauthHttp?: boolean;
  allowCriticalInDanger?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { stdio: false, http: false, dashboard: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--project":
      case "-p": {
        const v = next();
        if (v !== undefined) args.project = v;
        break;
      }
      case "--config":
      case "-c": {
        const v = next();
        if (v !== undefined) args.config = v;
        break;
      }
      case "--stdio":
        args.stdio = true;
        break;
      case "--http":
        args.http = true;
        break;
      case "--port":
        args.port = Number(next());
        break;
      case "--host": {
        const v = next();
        if (v !== undefined) args.host = v;
        break;
      }
      case "--dashboard-port":
        args.dashboardPort = Number(next());
        break;
      case "--no-dashboard":
        args.dashboard = false;
        break;
      case "--tools-preset": {
        const v = next();
        if (v !== undefined) args.toolsPreset = v;
        break;
      }
      case "--tools-groups": {
        const v = next();
        if (v !== undefined)
          args.toolsGroups = v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        break;
      }
      case "--tools-enable": {
        const v = next();
        if (v !== undefined)
          args.toolsEnable = v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        break;
      }
      case "--tools-disable": {
        const v = next();
        if (v !== undefined)
          args.toolsDisable = v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        break;
      }
      case "--policy":
      case "--policy-mode": {
        const v = next();
        if (v !== undefined) args.policyMode = v;
        break;
      }
      case "--token": {
        const v = next();
        if (v !== undefined) args.token = v;
        break;
      }
      case "--api-key": {
        const v = next();
        if (v !== undefined) {
          (args.apiKeys ??= []).push(
            ...v
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          );
        }
        break;
      }
      case "--require-auth":
        args.requireAuth = true;
        break;
      case "--auth": {
        const v = next();
        if (v !== undefined)
          args.authMode = v as NonNullable<CliArgs["authMode"]>;
        break;
      }
      case "--oauth-resource": {
        const v = next();
        if (v !== undefined) args.oauthResource = v;
        break;
      }
      case "--oauth-issuer": {
        const v = next();
        if (v !== undefined) args.oauthIssuer = v;
        break;
      }
      case "--oauth-scopes": {
        const v = next();
        if (v !== undefined)
          args.oauthScopes = v
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
        break;
      }
      case "--oauth-read-scope": {
        const v = next();
        if (v !== undefined) args.oauthReadScope = v;
        break;
      }
      case "--oauth-write-scope": {
        const v = next();
        if (v !== undefined) args.oauthWriteScope = v;
        break;
      }
      case "--oauth-client-registration": {
        const v = next();
        if (v !== undefined) {
          args.oauthClientRegistration = v as NonNullable<
            CliArgs["oauthClientRegistration"]
          >;
        }
        break;
      }
      case "--oauth-jwks-uri": {
        const v = next();
        if (v !== undefined) args.oauthJwksUri = v;
        break;
      }
      case "--oauth-trusted-jwks-hosts": {
        const v = next();
        if (v !== undefined)
          args.oauthTrustedJwksHosts = v
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
        break;
      }
      case "--oauth-algorithms": {
        const v = next();
        if (v !== undefined)
          args.oauthAlgorithms = v
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
        break;
      }
      case "--oauth-resource-documentation": {
        const v = next();
        if (v !== undefined) args.oauthResourceDocumentation = v;
        break;
      }
      case "--unsafe-oauth-http":
        args.unsafeOauthHttp = true;
        break;
      case "--dangerously-allow-critical":
        args.allowCriticalInDanger = true;
        break;
      case "--version":
      case "-v":
        process.stdout.write(`folderforge ${VERSION}\n`);
        process.exit(0);
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        if (a && a.startsWith("-")) {
          logger.warn({ arg: a }, "Unknown argument ignored");
        }
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    [
      "FolderForge - local development control plane for AI coding agents",
      "",
      "Usage: folderforge [command] [options]",
      "",
      "Commands:",
      "  doctor                 Run read-only installation and workspace diagnostics",
      "  setup browser          Install package-compatible Playwright Chromium (explicit opt-in)",
      "  connect chatgpt        Configure Auth0 OAuth and connect FolderForge to ChatGPT",
      "  chatgpt <command>      status|doctor|repair|start|stop|disconnect",
      "",
      "Options:",
      "  -p, --project <dir>      Project root to activate (default: cwd)",
      "  -c, --config <file>      Path to a YAML config file",
      "      --stdio              Serve MCP over stdio (default for agent clients)",
      "      --http               Serve MCP over Streamable HTTP",
      "      --port <n>           HTTP MCP port (default 7331)",
      "      --host <addr>        Bind address (default 127.0.0.1)",
      "      --dashboard-port <n> Dashboard port (default 7332)",
      "      --no-dashboard       Disable the local dashboard",
      "      --token <secret>     Bearer/API token required on the HTTP MCP endpoint",
      "      --api-key <csv>      Additional accepted API keys (repeatable / comma-separated)",
      "      --require-auth       Enforce auth even on a loopback (localhost) bind",
      "      --auth <mode>        HTTP auth mode (none|token|oauth)",
      "      --oauth-resource <url> Canonical public MCP resource URL",
      "      --oauth-issuer <url> External authorization-server issuer",
      "      --oauth-scopes <csv> OAuth scopes advertised by FolderForge",
      "      --oauth-read-scope <s> Scope required for read-only MCP access",
      "      --oauth-write-scope <s> Scope required for mutating tools",
      "      --oauth-client-registration <mode> cimd|dcr|predefined (default cimd)",
      "      --oauth-jwks-uri <url> Trusted JWKS URI override",
      "      --oauth-trusted-jwks-hosts <csv> Exact allowlisted JWKS host[:port] values",
      "      --oauth-algorithms <csv> Accepted asymmetric JWT algorithms",
      "      --oauth-resource-documentation <url> Public OAuth resource documentation URL",
      "      --unsafe-oauth-http Development only: allow loopback HTTP issuer/resource",
      "      --tools-preset <id>  Limit advertised tools to a preset (vibe|vibe-lite|readonly|full)",
      "      --tools-groups <csv> Limit advertised tools to these groups (e.g. file,search,git)",
      "      --tools-enable <csv> Always-keep tool names (added back on top of the filter)",
      "      --tools-disable <csv> Drop these tool names from the advertised list",
      "      --policy <mode>      Policy mode at startup (readonly|safe|dev|danger)",
      "      --dangerously-allow-critical  Allow CRITICAL actions without approval in danger mode",
      "  -v, --version            Print version and exit",
      "  -h, --help               Show this help",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "doctor") {
    const result = await executeDoctorCli(argv.slice(1));
    process.stdout.write(result.output);
    process.exitCode = result.exitCode;
    return;
  }
  if (argv[0] === "setup") {
    const result = executeBrowserSetupCli(argv.slice(1));
    process.stdout.write(result.output);
    process.exitCode = result.exitCode;
    return;
  }
  if (argv[0] === "connect" && argv[1] === "chatgpt") {
    const chatGptArgv = ["connect", ...argv.slice(2)];
    const json = chatGptArgv.includes("--json");
    let streamed = false;
    const result = await executeChatGptCli(chatGptArgv, {
      ...(json
        ? {}
        : {
            onLine: (line: string) => {
              streamed = true;
              process.stdout.write(`${line}\n`);
            },
          }),
    });
    if (json || !streamed) process.stdout.write(result.output);
    process.exitCode = result.exitCode;
    return;
  }
  if (argv[0] === "chatgpt") {
    const chatGptArgv = argv.slice(1);
    const json = chatGptArgv.includes("--json");
    let streamed = false;
    const result = await executeChatGptCli(chatGptArgv, {
      ...(json
        ? {}
        : {
            onLine: (line: string) => {
              streamed = true;
              process.stdout.write(`${line}\n`);
            },
          }),
    });
    if (json || !streamed) process.stdout.write(result.output);
    process.exitCode = result.exitCode;
    return;
  }

  const args = parseArgs(argv);

  // First-run convenience: if the user did not point at an explicit --config and
  // the project has no config file yet, write a full batteries-included config
  // (vibe-lite + Playwright enabled) so browser/UI tools work out of the box.
  // Never overwrites an existing file; failures are non-fatal.
  if (args.config === undefined) {
    ensureConfigFile(args.project ?? process.cwd());
  }

  const config = loadConfig({
    ...(args.config !== undefined ? { configPath: args.config } : {}),
    ...(args.project !== undefined ? { projectRoot: args.project } : {}),
  });

  // CLI overrides for transport/ports.
  if (args.http) config.server.transport = "http";
  if (args.stdio) config.server.transport = "stdio";
  if (args.host !== undefined) config.server.http.host = args.host;
  if (args.port !== undefined) config.server.http.port = args.port;
  if (args.dashboardPort !== undefined)
    config.server.dashboard.port = args.dashboardPort;
  // CLI override for the policy mode (CLI wins over the config file).
  if (args.policyMode !== undefined) {
    const validModes = ["readonly", "safe", "dev", "danger"];
    if (validModes.includes(args.policyMode)) {
      config.policy.defaultMode =
        args.policyMode as typeof config.policy.defaultMode;
    } else {
      logger.warn(
        { policyMode: args.policyMode, validModes },
        "Invalid --policy value ignored; using configured policy mode",
      );
    }
  }
  if (args.allowCriticalInDanger) {
    config.policy.allowCriticalInDanger = true;
  }
  if (config.policy.allowCriticalInDanger && config.policy.defaultMode !== "danger") {
    throw new Error("--dangerously-allow-critical requires --policy danger (or policy.defaultMode=danger)");
  }
  if (!args.dashboard && config.policy.defaultMode !== "readonly" && !config.policy.allowCriticalInDanger) {
    logger.warn(
      { mode: config.policy.defaultMode },
      "Dashboard disabled: approval-gated actions cannot be resolved. Enable the dashboard or use --policy danger --dangerously-allow-critical in an isolated environment.",
    );
  }
  // CLI auth overrides for the HTTP transport. CLI wins over env/YAML.
  if (args.token !== undefined) config.server.http.token = args.token;
  if (args.apiKeys && args.apiKeys.length > 0) {
    config.server.http.apiKeys = [
      ...(config.server.http.apiKeys ?? []),
      ...args.apiKeys,
    ];
  }
  if (args.requireAuth) config.server.http.requireAuth = true;
  if (args.authMode !== undefined) {
    config.server.http.auth = {
      ...(config.server.http.auth ?? {}),
      mode: args.authMode,
    };
  }
  const hasOauthCli = Boolean(
    args.oauthResource ||
    args.oauthIssuer ||
    args.oauthScopes ||
    args.oauthReadScope ||
    args.oauthWriteScope ||
    args.oauthClientRegistration ||
    args.oauthJwksUri ||
    args.oauthTrustedJwksHosts ||
    args.oauthAlgorithms ||
    args.oauthResourceDocumentation ||
    args.unsafeOauthHttp,
  );
  if (hasOauthCli) {
    const existing = config.server.http.auth?.oauth as
      Partial<OAuthHttpAuthConfig> | undefined;
    config.server.http.auth = {
      mode: args.authMode ?? config.server.http.auth?.mode ?? "oauth",
      oauth: {
        ...(existing ?? {}),
        ...(args.oauthResource !== undefined
          ? { resource: args.oauthResource }
          : {}),
        ...(args.oauthIssuer !== undefined ? { issuer: args.oauthIssuer } : {}),
        ...(args.oauthScopes !== undefined ? { scopes: args.oauthScopes } : {}),
        ...(args.oauthReadScope !== undefined
          ? { readScope: args.oauthReadScope }
          : {}),
        ...(args.oauthWriteScope !== undefined
          ? { writeScope: args.oauthWriteScope }
          : {}),
        ...(args.oauthClientRegistration !== undefined
          ? { clientRegistration: args.oauthClientRegistration }
          : {}),
        ...(args.oauthJwksUri !== undefined
          ? { jwksUri: args.oauthJwksUri }
          : {}),
        ...(args.oauthTrustedJwksHosts !== undefined
          ? { trustedJwksHosts: args.oauthTrustedJwksHosts }
          : {}),
        ...(args.oauthAlgorithms !== undefined
          ? { algorithms: args.oauthAlgorithms }
          : {}),
        ...(args.oauthResourceDocumentation !== undefined
          ? { resourceDocumentation: args.oauthResourceDocumentation }
          : {}),
        ...(args.unsafeOauthHttp
          ? { allowInsecureHttpForDevelopment: true }
          : {}),
      } as OAuthHttpAuthConfig,
    };
  }
  applyHttpAuthDefaults(config);
  validateConfig(config);

  const container = new Container(config);
  const registry = buildRegistry(container);

  // Trim the advertised tool surface (config + CLI). Clients that cap the tool
  // list (e.g. ~50 tools) can run a focused preset like "vibe". CLI flags win
  // over the config file. Applied before the first tools/list.
  const cfgTools = (
    config as {
      tools?: {
        preset?: string;
        enabledGroups?: string[];
        enabled?: string[];
        disabled?: string[];
      };
    }
  ).tools;
  const effectivePreset = args.toolsPreset ?? cfgTools?.preset;
  const active = resolveActiveTools(registry, {
    preset: effectivePreset,
    enabledGroups: args.toolsGroups ?? cfgTools?.enabledGroups,
    enabled: args.toolsEnable ?? cfgTools?.enabled,
    disabled: args.toolsDisable ?? cfgTools?.disabled,
  });
  if (active) {
    registry.setActive(active);
    logger.info(
      { advertised: active.length, total: registry.listAll().length },
      "Tool surface filtered",
    );
  }

  // Wire enabled child MCP adapters (Serena, Playwright, ...). Each child tool is
  // exposed namespaced (e.g. serena__find_symbol). Discovery never blocks startup.
  try {
    const added = await registerAdapterTools(
      container,
      registry,
      active === null || effectivePreset === "full",
    );
    if (added > 0) logger.info({ added }, "Registered child MCP adapter tools");
  } catch (err) {
    logger.warn(
      { err: String(err) },
      "Adapter tool registration failed; continuing without adapters",
    );
  }

  const makeServer = (principal: ToolPrincipal = STDIO_AGENT_PRINCIPAL) =>
    createMcpServer(registry, {
      name: config.server.name,
      version: VERSION,
      roots: config.workspace.allowedDirectories,
      principal,
    });
  // A primary server instance for stdio + lifecycle (shutdown). The HTTP
  // transport mints its own per-request server via `makeServer` (a shared
  // server can only connect to one transport at a time).
  const server = makeServer();

  container.audit.record({
    type: "server_start",
    summary: `transport=${config.server.transport} tools=${registry.listAll().length}`,
    detail: { version: VERSION, projectRoot: container.projectRoot() },
  });

  // Dashboard is independent of the MCP transport (and is safe to run alongside stdio).
  if (args.dashboard) {
    const dashHost = config.server.dashboard.host;
    // A non-loopback bind exposes the control plane to the network, so it must be
    // token-protected. Use the configured token or mint one and log it once.
    const token = config.server.dashboard.token;
    if (!isLoopbackHost(dashHost) && !token) {
      throw new Error(
        "Dashboard non-loopback bind requires server.dashboard.token; FolderForge will not print generated credentials to logs",
      );
    }
    startDashboard(container, registry, {
      host: dashHost,
      port: config.server.dashboard.port,
      ...(token ? { token } : {}),
    });
  }

  if (config.server.transport === "http") {
    const httpHost = config.server.http.host;
    const forceAuth = Boolean(config.server.http.requireAuth);
    const hasCredential =
      Boolean(config.server.http.token) ||
      (config.server.http.apiKeys?.length ?? 0) > 0;
    const configuredMode = config.server.http.auth?.mode;
    const effectiveMode =
      configuredMode ??
      (hasCredential || forceAuth || !isLoopbackHost(httpHost)
        ? "token"
        : "none");
    if (effectiveMode === "token" && !hasCredential) {
      throw new Error(
        "HTTP token authentication requires a configured credential. Set server.http.token, " +
          "server.http.apiKeys, FOLDERFORGE_HTTP_TOKEN, or pass --token. " +
          "FolderForge no longer prints generated bearer credentials to logs.",
      );
    }
    await startHttpTransport(makeServer, {
      host: httpHost,
      port: config.server.http.port,
      authMode: effectiveMode,
      ...(config.server.http.auth?.oauth
        ? { oauth: config.server.http.auth.oauth }
        : {}),
      ...(config.server.http.token ? { token: config.server.http.token } : {}),
      ...(config.server.http.apiKeys
        ? { apiKeys: config.server.http.apiKeys }
        : {}),
      ...(forceAuth ? { requireAuth: true } : {}),
      ...(config.server.http.corsOrigins
        ? { corsOrigins: config.server.http.corsOrigins }
        : {}),
      ...(config.server.http.sessionTtlMs !== undefined
        ? { sessionTtlMs: config.server.http.sessionTtlMs }
        : {}),
    });
  } else {
    await startStdioTransport(server);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down FolderForge");
    await Promise.allSettled([
      server.close(),
      container.adapters.stopAllAndWait(1_500),
    ]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error(
    { err: err instanceof Error ? err.stack : String(err) },
    "Fatal startup error",
  );
  process.exit(1);
});
