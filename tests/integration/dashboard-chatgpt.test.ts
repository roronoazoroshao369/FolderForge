import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig } from "../../src/core/config.js";
import { Container } from "../../src/core/container.js";
import { startDashboard } from "../../src/dashboard/server.js";
import { buildRegistry } from "../../src/tools/index.js";
import {
  readConnectionReceipt,
  refreshChatGptLifecycle,
  writeConnectionReceipt,
  type ChatGptConnectionReceipt,
} from "../../src/chatgpt/cli.js";

interface DashboardHarness {
  root: string;
  container: Container;
  server: Server;
  baseUrl: string;
}

async function startHarness(): Promise<DashboardHarness> {
  const root = mkdtempSync(join(tmpdir(), "folderforge-dashboard-chatgpt-"));
  const config = defaultConfig(root);
  config.rateLimit.enabled = false;
  const container = new Container(config);
  const registry = buildRegistry(container);
  const server = startDashboard(container, registry, {
    host: "127.0.0.1",
    port: 0,
  });
  if (!server.listening) await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    root,
    container,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function createReadyReceipt(root: string): ChatGptConnectionReceipt {
  const now = new Date().toISOString();
  const logDir = join(root, ".folderforge", "logs");
  mkdirSync(logDir, { recursive: true });
  return {
    version: 2,
    status: "ready",
    provider: "auth0",
    mode: "quick",
    registration: "dcr",
    tenant: "tenant.example.auth0.com",
    issuer: "https://tenant.example.auth0.com/",
    resource: "https://mcp.example.com/mcp",
    mcpUrl: "https://mcp.example.com/mcp",
    metadataUrl:
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    scopes: ["folderforge:read", "folderforge:write"],
    projectRoot: root,
    configPath: join(root, ".folderforge", "config.yaml"),
    clientId: "tpc_dashboard",
    auth0: {
      apiId: "api_dashboard",
      apiName: "FolderForge MCP",
      createdByFolderForge: true,
    },
    connectivity: {
      kind: "stable-url",
      publicUrl: "https://mcp.example.com",
      localUrl: "http://127.0.0.1:7331/mcp",
    },
    processes: {
      serverPid: process.pid,
      serverLog: join(logDir, "server.log"),
      tunnelLog: join(logDir, "tunnel.log"),
    },
    checks: {
      dependencies: "pass",
      tenant: "pass",
      issuerDiscovery: "pass",
      dcr: "pass",
      auth0Api: "pass",
      localServer: "pass",
      publicEndpoint: "pass",
      resourceMetadata: "pass",
      unauthorizedChallenge: "pass",
      jwks: "pass",
      chatgptClient: "pass",
      loginConnections: "pass",
      userGrant: "pass",
      authorize: "pass",
      tokenValidation: "pending_user_login",
      mcpInitialize: "pending_user_login",
    },
    lifecycle: {
      sessionId: "session_dashboard",
      sessionStartedAt: new Date(Date.now() - 5_000).toISOString(),
      stage: "READY_TO_COMPLETE_LOGIN",
      detectedClient: {
        clientId: "tpc_dashboard",
        name: "ChatGPT",
        callbacks: ["https://chatgpt.com/connector/oauth/callback-dashboard"],
        externalMetadataType: "dcr",
        resource: "https://mcp.example.com/mcp",
        detectedAt: now,
      },
      loginConnections: [
        { id: "con_db", name: "Username-Password-Authentication" },
      ],
      userGrant: {
        id: "grant_dashboard",
        clientId: "tpc_dashboard",
        audience: "https://mcp.example.com/mcp",
        scopes: ["folderforge:read", "folderforge:write"],
        subjectType: "user",
      },
      authorize: {
        checkedAt: now,
        status: 302,
        outcome: "redirected_to_login_or_callback",
      },
      diagnostics: [],
    },
    warnings: [],
    runtime: {
      profile: "developer",
      policyMode: "safe",
      toolsPreset: "vibe",
      adapters: ["playwright"],
      dashboard: true,
      dashboardPort: 7332,
      offlineAccess: true,
      dcrClientPolicy: "require-grant",
      autoEnableDcr: true,
      loginConnections: ["Username-Password-Authentication"],
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe("ChatGPT dashboard lifecycle", () => {
  const harnesses: DashboardHarness[] = [];

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      await closeServer(harness.server);
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("renders the shared unconfigured lifecycle and the complete dashboard information architecture", async () => {
    const harness = await startHarness();
    harnesses.push(harness);

    const statusResponse = await fetch(`${harness.baseUrl}/chatgpt/status`);
    expect(statusResponse.status).toBe(200);
    const status = (await statusResponse.json()) as {
      configured: boolean;
      state: string;
      actions: Array<{ command?: string }>;
    };
    expect(status).toMatchObject({ configured: false, state: "UNCONFIGURED" });
    expect(status.actions[0]?.command).toContain("folderforge connect chatgpt");

    const html = await (await fetch(`${harness.baseUrl}/`)).text();
    expect(html).toContain("Overall status");
    expect(html).toContain("Connection timeline");
    expect(html).toContain("Diagnostics");
    expect(html).toContain("Project and runtime configuration");
    expect(html).toContain("Redacted logs");
    expect(html).toContain("lifecycle checks complete");
    expect(html).not.toContain("No additional evidence recorded.");
    expect(html).toContain("/chatgpt/actions/");
  });

  it("uses the same lifecycle evaluator for CLI and dashboard and marks connected only for the exact verified OAuth client", async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    const receiptPath = join(
      harness.root,
      ".folderforge",
      "chatgpt-connection.json",
    );
    writeConnectionReceipt(receiptPath, createReadyReceipt(harness.root));

    const ready = (await (
      await fetch(`${harness.baseUrl}/chatgpt/status`)
    ).json()) as {
      status: string;
      state: string;
      timeline: Array<{ stage: string }>;
      diagnostics: unknown[];
      actions: Array<{ id: string }>;
      configuration: { tenant: string; resourcePolicy: string };
    };
    expect(ready).toMatchObject({
      status: "waiting_for_chatgpt",
      state: "READY_TO_COMPLETE_LOGIN",
    });
    expect(ready.timeline.map((entry) => entry.stage)).toContain(
      "USER_GRANT_READY",
    );
    expect(ready.configuration).toMatchObject({
      tenant: "tenant.example.auth0.com",
      resourcePolicy: "require-grant",
    });
    expect(ready.actions.map((entry) => entry.id)).toContain("copy_mcp_url");

    harness.container.audit.record({
      type: "tool_call",
      tool: "workspace_status",
      risk: "LOW",
      summary: "wrong client",
      detail: { authMode: "oauth", oauthClientId: "tpc_other" },
    });
    const stillReady = (await (
      await fetch(`${harness.baseUrl}/chatgpt/status`)
    ).json()) as {
      state: string;
    };
    expect(stillReady.state).toBe("READY_TO_COMPLETE_LOGIN");

    harness.container.audit.record({
      type: "tool_call",
      tool: "workspace_status",
      risk: "LOW",
      summary: "verified ChatGPT client",
      detail: { authMode: "oauth", oauthClientId: "tpc_dashboard" },
    });
    const connected = (await (
      await fetch(`${harness.baseUrl}/chatgpt/status`)
    ).json()) as {
      status: string;
      state: string;
    };
    expect(connected).toMatchObject({
      status: "connected",
      state: "CONNECTED",
    });

    const receipt = readConnectionReceipt(receiptPath);
    const cliSnapshot = refreshChatGptLifecycle(receipt, true, true);
    expect(cliSnapshot.state).toBe(connected.state);
    expect(cliSnapshot.overall).toBe(connected.status);
  });

  it("redacts bounded logs and returns safe terminal guidance for runtime actions", async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    const receipt = createReadyReceipt(harness.root);
    writeConnectionReceipt(
      join(harness.root, ".folderforge", "chatgpt-connection.json"),
      receipt,
    );
    writeFileSync(
      receipt.processes.serverLog,
      [
        "client_secret=swordfish",
        "access_token:abc123456",
        "Authorization: Bearer raw-bearer-value",
        "eyJabcdefgh.abcdefgh.abcdefgh",
        "sk-abcdefghijklmnop",
      ].join("\n"),
    );

    const logsResponse = await fetch(
      `${harness.baseUrl}/chatgpt/logs?subsystem=server&limit=100`,
    );
    expect(logsResponse.status).toBe(200);
    const logs = JSON.stringify(await logsResponse.json());
    expect(logs).not.toContain("swordfish");
    expect(logs).not.toContain("abc123456");
    expect(logs).not.toContain("raw-bearer-value");
    expect(logs).not.toContain("eyJabcdefgh");
    expect(logs).not.toContain("sk-abcdefghijklmnop");
    expect(logs).toContain("REDACTED");

    const restart = await fetch(
      `${harness.baseUrl}/chatgpt/actions/restart_server`,
      {
        method: "POST",
      },
    );
    expect(restart.status).toBe(202);
    expect(await restart.json()).toMatchObject({
      accepted: false,
      requiresTerminal: true,
      action: { id: "restart_server", mode: "manual" },
    });

    const unknown = await fetch(`${harness.baseUrl}/chatgpt/actions/not_real`, {
      method: "POST",
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({
      error: "unknown_chatgpt_action",
    });
  });
});
