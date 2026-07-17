import { describe, expect, it } from "vitest";
import {
  deriveChatGptLifecycle,
  matchChatGptClient,
  redactSensitive,
  redactSensitiveText,
  type ChatGptDiagnostic,
} from "../../src/chatgpt/lifecycle.js";

describe("ChatGPT lifecycle domain model", () => {
  it("accepts only a new DCR ChatGPT client bound to the current resource", () => {
    const candidate = {
      client_id: "tpc_new",
      name: "ChatGPT Connector",
      callbacks: ["https://chatgpt.com/connector/oauth/callback"],
      external_metadata_type: "dcr",
      resource_server_identifier: "https://mcp.example.com/mcp",
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    };
    expect(
      matchChatGptClient(
        candidate,
        "https://mcp.example.com/mcp",
        new Set(["tpc_old"]),
      ),
    ).toEqual({
      matched: true,
      reasons: [],
    });
    expect(
      matchChatGptClient(candidate, "https://other.example.com/mcp"),
    ).toMatchObject({ matched: false });
    expect(
      matchChatGptClient(
        candidate,
        "https://mcp.example.com/mcp",
        new Set(["tpc_new"]),
      ),
    ).toMatchObject({
      matched: false,
      reasons: expect.arrayContaining([
        expect.stringMatching(/before this connect session/),
      ]),
    });
  });

  it("rejects mixed or non-ChatGPT callbacks", () => {
    const result = matchChatGptClient(
      {
        client_id: "tpc_new",
        name: "ChatGPT",
        callbacks: [
          "https://chatgpt.com/connector/oauth/callback",
          "https://attacker.example/callback",
        ],
        registration_type: "dcr",
        resource_server_identifier: "https://mcp.example.com/mcp",
      },
      "https://mcp.example.com/mcp",
    );
    expect(result.matched).toBe(false);
    expect(result.reasons).toContain(
      "client includes a callback outside the ChatGPT connector callback boundary",
    );
  });

  it("derives waiting, repair, and connected states from the same checks", () => {
    const base = {
      receiptExists: true,
      serverAlive: true,
      tunnelRequired: false,
      tunnelAlive: true,
      checks: {
        dependencies: "pass" as const,
        tenant: "pass" as const,
        dcr: "pass" as const,
        auth0Api: "pass" as const,
        localServer: "pass" as const,
        publicEndpoint: "pass" as const,
        resourceMetadata: "pass" as const,
        unauthorizedChallenge: "pass" as const,
        chatgptClient: "pending" as const,
      },
    };
    expect(deriveChatGptLifecycle(base)).toMatchObject({
      state: "WAITING_FOR_CHATGPT_CLIENT",
      overall: "waiting_for_chatgpt",
      actions: expect.arrayContaining(["wait_for_dcr_client"]),
    });

    const diagnostics: ChatGptDiagnostic[] = [
      {
        id: "auth0.connections",
        stage: "LOGIN_CONNECTIONS_READY",
        status: "fail",
        checkedAt: "2026-07-16T00:00:00.000Z",
        evidence: "No enabled database or social connection",
        autoRepair: true,
        repairAction: "enable_login_connection",
        errorState: "NO_CONNECTIONS_ENABLED",
      },
    ];
    expect(
      deriveChatGptLifecycle({
        ...base,
        checks: {
          ...base.checks,
          chatgptClient: "pass",
          loginConnections: "fail",
        },
        diagnostics,
      }),
    ).toMatchObject({
      state: "NO_CONNECTIONS_ENABLED",
      overall: "needs_attention",
    });

    expect(
      deriveChatGptLifecycle({
        ...base,
        checks: {
          ...base.checks,
          chatgptClient: "pass",
          loginConnections: "pass",
          userGrant: "pass",
          authorize: "pass",
          tokenValidation: "pass",
          mcpInitialize: "pass",
        },
      }),
    ).toMatchObject({ state: "CONNECTED", overall: "connected" });
  });

  it("redacts token-like values recursively", () => {
    const redacted = redactSensitive({
      accessToken: "secret",
      nested: {
        authorization: "Bearer abc.def.ghi",
        message: "eyJabcdefgh.abcdefgh.abcdefgh",
      },
    });
    expect(redacted).toEqual({
      accessToken: "[REDACTED]",
      nested: { authorization: "[REDACTED]", message: "[REDACTED_JWT]" },
    });
    const text = redactSensitiveText(
      "client_secret=swordfish access_token:abc123 Bearer raw-token sk-abcdefghijklmnop eyJabcdefgh.abcdefgh.abcdefgh",
    );
    expect(text).not.toContain("swordfish");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("raw-token");
    expect(text).not.toContain("sk-abcdefghijklmnop");
    expect(text).not.toContain("eyJabcdefgh");
  });
});
