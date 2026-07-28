import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFolderForgeServerArgs,
  buildOpenAiTunnelChildEnvironments,
  buildTunnelClientArgs,
  executeOpenAiTunnelCli,
  parseOpenAiTunnelArgs,
  readOpenAiTunnelReceipt,
  selectTunnelClientReleaseAsset,
  validateTunnelId,
  writeOpenAiTunnelReceipt,
  type OpenAiTunnelReceipt,
} from "../../src/chatgpt/openai-tunnel.js";

const TUNNEL_ID = `tunnel_${"a".repeat(32)}`;

function fakeTunnelClient(root: string): string {
  const bin = join(root, "tunnel-client");
  writeFileSync(
    bin,
    "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'tunnel-client v0.0.10'; exit 0; fi\nif [ \"$1\" = \"run\" ] && [ \"$2\" = \"--help\" ]; then echo '--control-plane.tunnel-id --control-plane.api-key --mcp.server-url --mcp.extra-headers --mcp.discovery-extra-headers --health.listen-addr --health.url-file --log.level --log.format'; exit 0; fi\nexit 0\n",
    { mode: 0o755 },
  );
  chmodSync(bin, 0o755);
  return bin;
}

function receipt(root: string): OpenAiTunnelReceipt {
  return {
    version: 1,
    provider: "openai-secure-mcp-tunnel",
    projectRoot: root,
    tunnelId: TUNNEL_ID,
    apiKeyRef: "env:CONTROL_PLANE_API_KEY",
    profile: "developer",
    policyMode: "dev",
    toolsPreset: "full",
    dashboard: true,
    tunnelClient: {
      path: join(root, "tunnel-client"),
      version: "0.0.10",
    },
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

describe("OpenAI Secure MCP Tunnel CLI", () => {
  it("parses a one-command developer profile and validates tunnel IDs", () => {
    const parsed = parseOpenAiTunnelArgs(
      [
        "connect",
        "--openai-tunnel",
        "--tunnel-id",
        TUNNEL_ID,
        "--profile",
        "developer",
        "--no-open",
      ],
      "/tmp/project",
    );

    expect(parsed.projectRoot).toBe("/tmp/project");
    expect(parsed.tunnelId).toBe(TUNNEL_ID);
    expect(parsed.profile).toBe("developer");
    expect(parsed.dashboard).toBe(true);
    expect(parsed.autoInstall).toBe(true);
    expect(parsed.openBrowser).toBe(false);
    expect(validateTunnelId(TUNNEL_ID)).toBe(TUNNEL_ID);
    expect(() => validateTunnelId("tunnel_bad")).toThrow(/32 lowercase/);
    expect(() =>
      parseOpenAiTunnelArgs([
        "connect",
        "--openai-tunnel",
        "--api-key-env",
        "KEY",
        "--api-key-file",
        "/tmp/key",
      ]),
    ).toThrow(/only one/);
  });

  it("accepts only the official digested GitHub release asset", () => {
    const selected = selectTunnelClientReleaseAsset({
      tag_name: "v0.0.10",
      assets: [
        {
          name: "tunnel-client-v0.0.10-all.tar.gz",
          size: 45_000_000,
          browser_download_url:
            "https://github.com/openai/tunnel-client/releases/download/v0.0.10/tunnel-client-v0.0.10-all.tar.gz",
          digest: `sha256:${"b".repeat(64)}`,
        },
      ],
    });

    expect(selected).toMatchObject({
      tag: "v0.0.10",
      version: "0.0.10",
      sha256: "b".repeat(64),
    });
    expect(() =>
      selectTunnelClientReleaseAsset({
        tag_name: "v0.0.10",
        assets: [
          {
            name: "tunnel-client-v0.0.10-all.tar.gz",
            size: 100,
            browser_download_url:
              "https://evil.example/tunnel-client-v0.0.10-all.tar.gz",
            digest: `sha256:${"b".repeat(64)}`,
          },
        ],
      }),
    ).toThrow(/non-official/);
  });

  it("builds a loopback token-authenticated server without critical bypass", () => {
    const args = buildFolderForgeServerArgs("/pkg/dist/main.js", {
      projectRoot: "/workspace/project",
      dashboard: true,
      mcpPort: 7441,
      dashboardPort: 7442,
      policyMode: "danger",
      toolsPreset: "full",
    });

    expect(args).toContain("127.0.0.1");
    expect(args).toContain("token");
    expect(args).toContain("--require-auth");
    expect(args).toContain("danger");
    expect(args).toContain("full");
    expect(args).not.toContain("--dangerously-allow-critical");
  });

  it("passes only secret references and a protected local MCP header", () => {
    const args = buildTunnelClientArgs({
      tunnelId: TUNNEL_ID,
      apiKeyRef: "env:CONTROL_PLANE_API_KEY",
      policyMode: "dev",
      toolsPreset: "full",
      tunnelClientPath: "/bin/tunnel-client",
      tunnelClientVersion: "0.0.10",
      mcpPort: 7331,
      dashboardPort: 7332,
      localMcpUrl: "http://127.0.0.1:7331/mcp",
      healthUrlFile: "/tmp/health.url",
      serverLog: "/tmp/server.log",
    });

    expect(args).toContain("env:CONTROL_PLANE_API_KEY");
    expect(args).toContain(
      "X-API-Key: env:FOLDERFORGE_OPENAI_TUNNEL_LOCAL_TOKEN",
    );
    expect(args.join(" ")).not.toMatch(/\bsk-/);
  });

  it("keeps control-plane credentials out of the FolderForge child environment", () => {
    const baseEnv = {
      PATH: "/bin",
      CONTROL_PLANE_API_KEY: "sk-control-plane-secret",
      OPENAI_API_KEY: "sk-unrelated-openai-secret",
      OTHER_VALUE: "preserved",
      FOLDERFORGE_HTTP_TOKEN: "stale-token",
    };

    const { serverEnv, tunnelEnv } = buildOpenAiTunnelChildEnvironments(
      baseEnv,
      "env:CONTROL_PLANE_API_KEY",
      "local-runtime-token",
    );

    expect(serverEnv.CONTROL_PLANE_API_KEY).toBeUndefined();
    expect(serverEnv.OPENAI_API_KEY).toBeUndefined();
    expect(serverEnv.FOLDERFORGE_HTTP_TOKEN).toBe("local-runtime-token");
    expect(serverEnv.FOLDERFORGE_OPENAI_TUNNEL_LOCAL_TOKEN).toBeUndefined();
    expect(serverEnv.OTHER_VALUE).toBe("preserved");

    expect(tunnelEnv.CONTROL_PLANE_API_KEY).toBe("sk-control-plane-secret");
    expect(tunnelEnv.OPENAI_API_KEY).toBeUndefined();
    expect(tunnelEnv.FOLDERFORGE_OPENAI_TUNNEL_LOCAL_TOKEN).toBe(
      "local-runtime-token",
    );
    expect(tunnelEnv.FOLDERFORGE_HTTP_TOKEN).toBeUndefined();
  });

  it("stores a mode-0600 secret-free receipt", () => {
    const root = mkdtempSync(join(tmpdir(), "folderforge-openai-receipt-"));
    const path = join(root, "state", "openai-tunnel.json");
    const value = receipt(root);

    writeOpenAiTunnelReceipt(path, value);

    expect(readOpenAiTunnelReceipt(path)).toEqual(value);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(path, "utf8")).not.toMatch(/\bsk-/);
    expect(() =>
      writeOpenAiTunnelReceipt(path, {
        ...value,
        apiKeyRef: "sk-test-secret-value-1234567890",
      }),
    ).toThrow(/API key value/);
  });

  it("rejects a symlinked local state directory", () => {
    if (process.platform === "win32") return;

    const root = mkdtempSync(join(tmpdir(), "folderforge-openai-symlink-"));
    const project = join(root, "project");
    const outside = join(root, "outside");
    mkdirSync(project);
    mkdirSync(outside);
    symlinkSync(outside, join(project, ".folderforge"));

    const receiptPath = join(project, ".folderforge", "openai-tunnel.json");
    expect(() => writeOpenAiTunnelReceipt(receiptPath, receipt(project))).toThrow(
      /unsafe local state directory/,
    );
    expect(existsSync(join(outside, "openai-tunnel.json"))).toBe(false);
  });

  it("installs or verifies the client without requiring a tunnel ID or API key", async () => {
    const root = mkdtempSync(join(tmpdir(), "folderforge-openai-install-only-"));
    mkdirSync(join(root, "project"));
    const client = fakeTunnelClient(root);

    const result = await executeOpenAiTunnelCli(
      [
        "connect",
        "--openai-tunnel",
        "--project",
        join(root, "project"),
        "--tunnel-client",
        client,
        "--install-only",
      ],
      {
        env: { PATH: "" },
        homeDir: root,
        stdoutIsTty: false,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("0.0.10");
  });

  it("rejects an incompatible tunnel-client before launch", async () => {
    const root = mkdtempSync(join(tmpdir(), "folderforge-openai-incompatible-"));
    const project = join(root, "project");
    mkdirSync(project);
    const client = join(root, "tunnel-client");
    writeFileSync(
      client,
      "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'tunnel-client v0.0.1'; exit 0; fi\nif [ \"$1\" = \"run\" ] && [ \"$2\" = \"--help\" ]; then echo '--mcp.server-url'; exit 0; fi\nexit 0\n",
      { mode: 0o755 },
    );
    chmodSync(client, 0o755);

    const result = await executeOpenAiTunnelCli(
      [
        "connect",
        "--openai-tunnel",
        "--project",
        project,
        "--tunnel-client",
        client,
        "--install-only",
      ],
      { env: { PATH: "" }, homeDir: root, stdoutIsTty: false },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Incompatible tunnel-client");
    expect(result.output).toContain("--control-plane.tunnel-id");
  });

  it("prints a dry-run plan without leaking the runtime API key", async () => {
    const root = mkdtempSync(join(tmpdir(), "folderforge-openai-dry-run-"));
    const project = join(root, "project");
    mkdirSync(project);
    const client = fakeTunnelClient(root);
    const secret = "sk-test-secret-value-never-print-123456";

    const result = await executeOpenAiTunnelCli(
      [
        "connect",
        "--openai-tunnel",
        "--project",
        project,
        "--tunnel-id",
        TUNNEL_ID,
        "--tunnel-client",
        client,
        "--dry-run",
        "--no-open",
      ],
      {
        env: {
          PATH: "",
          CONTROL_PLANE_API_KEY: secret,
        },
        homeDir: root,
        stdoutIsTty: false,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("env:CONTROL_PLANE_API_KEY");
    expect(result.output).toContain("token-authenticated");
    expect(result.output).not.toContain(secret);
    expect(result.output).not.toContain("--dangerously-allow-critical");
  });
});
