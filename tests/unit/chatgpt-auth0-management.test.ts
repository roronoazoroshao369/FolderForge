import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  ChatGptAuth0Error,
  ensureDefaultThirdPartyUserGrant,
  ensureLoginConnections,
  ensureUserClientGrant,
  isChatGptCallback,
  isChatGptDcrClient,
  listAuth0ClientGrants,
  listAuth0Clients,
  listAuth0Connections,
  selectLoginConnections,
  validateChatGptClientForResource,
  verifyAuthorizeEndpoint,
  waitForChatGptClient,
  type Auth0DcrClient,
} from "../../src/chatgpt/auth0-management.js";

const originalPath = process.env.PATH;
const originalState = process.env.FAKE_AUTH0_STATE;
const originalFetch = globalThis.fetch;

function installFakeAuth0(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "fake-auth0.mjs");
  writeFileSync(
    script,
    `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const statePath = process.env.FAKE_AUTH0_STATE;
const read = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const write = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
const data = () => { const i = args.indexOf('--data'); return i >= 0 ? JSON.parse(args[i + 1]) : {}; };
const queryValues = args.flatMap((value, index) => value === '-q' ? [args[index + 1] || ''] : []);
const query = (name) => { const value = queryValues.find((entry) => entry.startsWith(name + '=')); return value?.slice(name.length + 1); };
const perPage = Number(query('per_page') || 50);
const page = Number(query('page') || 0);
if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
  console.error("Query validation error: 'Value " + perPage + " is greater than maximum 100' on property per_page");
  process.exit(1);
}
const paginate = (values) => values.slice(page * perPage, (page + 1) * perPage);
const method = args[1];
const path = args[2] || '';
const state = read();
if (args[0] !== 'api') { console.error('unsupported'); process.exit(2); }
if (method === 'get' && path === 'clients') {
  state.clientListCalls = (state.clientListCalls || 0) + 1;
  write(state);
  const revealAfter = state.revealAfter ?? 0;
  console.log(JSON.stringify(paginate(state.clients.filter((client) => !client.delayed || state.clientListCalls > revealAfter))));
  process.exit(0);
}
if (method === 'get' && path.startsWith('clients/')) {
  const id = decodeURIComponent(path.slice('clients/'.length));
  const client = state.clients.find((entry) => entry.client_id === id);
  if (!client) process.exit(1);
  console.log(JSON.stringify(client)); process.exit(0);
}
if (method === 'get' && path === 'logs') {
  console.log(JSON.stringify(state.logs || [])); process.exit(0);
}
if (method === 'get' && path === 'connections') {
  console.log(JSON.stringify(paginate(state.connections || []))); process.exit(0);
}
const connectionPath = path.startsWith('connections/') ? decodeURIComponent(path.slice('connections/'.length)) : '';
if (connectionPath && method === 'get') {
  const connection = state.connections.find((entry) => entry.id === connectionPath);
  if (!connection) process.exit(1);
  console.log(JSON.stringify(connection)); process.exit(0);
}
if (connectionPath && method === 'patch') {
  const connection = state.connections.find((entry) => entry.id === connectionPath);
  if (!connection) process.exit(1);
  Object.assign(connection, data());
  state.connectionWrites = (state.connectionWrites || 0) + 1;
  write(state); console.log(JSON.stringify(connection)); process.exit(0);
}
if (method === 'get' && path === 'client-grants') {
  console.log(JSON.stringify(paginate(state.grants || []))); process.exit(0);
}
if (method === 'post' && path === 'client-grants') {
  state.grants ||= [];
  const grant = { id: 'grant_' + (state.grants.length + 1), ...data() };
  state.grants.push(grant);
  state.grantCreates = (state.grantCreates || 0) + 1;
  write(state); console.log(JSON.stringify(grant)); process.exit(0);
}
if (method === 'patch' && path.startsWith('client-grants/')) {
  const id = decodeURIComponent(path.slice('client-grants/'.length));
  const grant = state.grants.find((entry) => entry.id === id);
  if (!grant) process.exit(1);
  Object.assign(grant, data());
  state.grantUpdates = (state.grantUpdates || 0) + 1;
  write(state); console.log(JSON.stringify(grant)); process.exit(0);
}
console.error('unsupported fake auth0 invocation', args.join(' ')); process.exit(2);
`,
  );
  chmodSync(script, 0o755);
  if (process.platform === "win32") {
    writeFileSync(
      join(bin, "auth0.cmd"),
      `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
    );
  } else {
    writeFileSync(
      join(bin, "auth0"),
      `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    );
    chmodSync(join(bin, "auth0"), 0o755);
  }
  return bin;
}

function chatGptClient(id = "tpc_new"): Auth0DcrClient & { delayed?: boolean } {
  return {
    client_id: id,
    name: "ChatGPT",
    callbacks: ["https://chatgpt.com/connector/oauth/callback-123"],
    app_type: "native",
    is_first_party: false,
    external_metadata_type: "dcr",
    external_metadata_created_by: "client",
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "none",
  };
}

beforeEach(() => {
  globalThis.fetch = vi.fn(
    async () =>
      new Response("", {
        status: 302,
        headers: { location: "https://tenant.example.auth0.com/login" },
      }),
  ) as typeof fetch;
});

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalState === undefined) delete process.env.FAKE_AUTH0_STATE;
  else process.env.FAKE_AUTH0_STATE = originalState;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("ChatGPT Auth0 lifecycle management", () => {
  it("accepts only bounded ChatGPT callback and DCR metadata", () => {
    expect(
      isChatGptCallback("https://chatgpt.com/connector/oauth/callback-123"),
    ).toBe(true);
    expect(
      isChatGptCallback(
        "https://chatgpt.com.evil.example/connector/oauth/callback-123",
      ),
    ).toBe(false);
    expect(isChatGptCallback("https://chatgpt.com/connector/oauth/")).toBe(
      false,
    );
    expect(isChatGptDcrClient(chatGptClient())).toBe(true);
    expect(
      isChatGptDcrClient({
        ...chatGptClient(),
        callbacks: ["https://evil.example/callback"],
      }),
    ).toBe(false);
    expect(
      isChatGptDcrClient({
        ...chatGptClient(),
        external_metadata_type: "manual",
      }),
    ).toBe(false);
  });

  it("selects a unique database connection and rejects ambiguous defaults", () => {
    expect(
      selectLoginConnections([
        {
          id: "con_db",
          name: "Username-Password-Authentication",
          strategy: "auth0",
        },
        { id: "con_google", name: "google-oauth2", strategy: "google-oauth2" },
      ]),
    ).toEqual([
      {
        id: "con_db",
        name: "Username-Password-Authentication",
        strategy: "auth0",
      },
    ]);
    expect(() =>
      selectLoginConnections([
        { id: "con_a", name: "Database A", strategy: "auth0" },
        { id: "con_b", name: "Database B", strategy: "auth0" },
        { id: "con_google", name: "Google", strategy: "google-oauth2" },
      ]),
    ).toThrow(/unique safe default/);
  });

  it("paginates Auth0 collections without exceeding the API page limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "folderforge-auth0-pagination-"));
    const statePath = join(root, "state.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        clients: Array.from({ length: 101 }, (_, index) => ({
          client_id: `client_${index}`,
        })),
        logs: [],
        connections: Array.from({ length: 101 }, (_, index) => ({
          id: `connection_${index}`,
          name: `Connection ${index}`,
        })),
        grants: Array.from({ length: 101 }, (_, index) => ({
          id: `grant_${index}`,
          client_id: `client_${index}`,
        })),
      }),
    );
    process.env.PATH = `${installFakeAuth0(root)}${delimiter}${originalPath ?? ""}`;
    process.env.FAKE_AUTH0_STATE = statePath;

    await expect(
      listAuth0Clients("tenant.example.auth0.com"),
    ).resolves.toHaveLength(101);
    await expect(
      listAuth0Connections("tenant.example.auth0.com"),
    ).resolves.toHaveLength(101);
    await expect(
      listAuth0ClientGrants("tenant.example.auth0.com"),
    ).resolves.toHaveLength(101);
  });

  it("provisions a scoped default user grant for all current and future third-party DCR clients", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "folderforge-auth0-default-grant-"),
    );
    const statePath = join(root, "state.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        clients: [],
        logs: [],
        connections: [],
        grants: [],
      }),
    );
    process.env.PATH = `${installFakeAuth0(root)}${delimiter}${originalPath ?? ""}`;
    process.env.FAKE_AUTH0_STATE = statePath;

    const first = await ensureDefaultThirdPartyUserGrant(
      "tenant.example.auth0.com",
      "https://mcp.example.com/mcp",
      ["folderforge:read"],
      true,
    );
    const second = await ensureDefaultThirdPartyUserGrant(
      "tenant.example.auth0.com",
      "https://mcp.example.com/mcp",
      ["folderforge:read", "folderforge:write"],
      true,
    );
    const clientGrant = await ensureUserClientGrant(
      "tenant.example.auth0.com",
      "tpc_future",
      "https://mcp.example.com/mcp",
      ["folderforge:read", "folderforge:write"],
      false,
    );

    expect(first).toMatchObject({
      defaultFor: "third_party_clients",
      subjectType: "user",
      scopes: ["folderforge:read"],
    });
    expect(second.scopes).toEqual(["folderforge:read", "folderforge:write"]);
    expect(clientGrant).toMatchObject({
      clientId: "tpc_future",
      subjectType: "user",
      scopes: ["folderforge:read", "folderforge:write"],
    });
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      grantCreates: number;
      grantUpdates: number;
      grants: Array<{
        client_id?: string;
        default_for?: string;
        audience: string;
        subject_type: string;
        scope: string[];
      }>;
    };
    expect(state.grantCreates).toBe(1);
    expect(state.grantUpdates).toBe(1);
    expect(state.grants).toEqual([
      expect.objectContaining({
        default_for: "third_party_clients",
        audience: "https://mcp.example.com/mcp",
        subject_type: "user",
        scope: ["folderforge:read", "folderforge:write"],
      }),
    ]);
    expect(state.grants[0]).not.toHaveProperty("client_id");
  });

  it("detects a delayed session client, proves its resource, and repairs connection and user grant idempotently", async () => {
    const root = mkdtempSync(join(tmpdir(), "folderforge-auth0-lifecycle-"));
    const statePath = join(root, "state.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        revealAfter: 1,
        clients: [
          { ...chatGptClient("tpc_old"), delayed: false },
          { ...chatGptClient("tpc_new"), delayed: true },
        ],
        logs: [
          {
            date: "2026-07-16T10:00:00.000Z",
            client_id: "tpc_new",
            details: {
              qs: {
                resource: "https://mcp.example.com/mcp",
                redirect_uri:
                  "https://chatgpt.com/connector/oauth/callback-123",
              },
            },
          },
        ],
        connections: [
          {
            id: "con_db",
            name: "Username-Password-Authentication",
            strategy: "auth0",
            is_domain_connection: false,
            authentication: { active: true },
          },
        ],
        grants: [],
      }),
    );
    process.env.PATH = `${installFakeAuth0(root)}${delimiter}${originalPath ?? ""}`;
    process.env.FAKE_AUTH0_STATE = statePath;

    const baseline = new Set(
      (await listAuth0Clients("tenant.example.auth0.com")).map(
        (client) => client.client_id,
      ),
    );
    expect(baseline).toEqual(new Set(["tpc_old"]));
    const detected = await waitForChatGptClient({
      tenant: "tenant.example.auth0.com",
      resource: "https://mcp.example.com/mcp",
      baselineClientIds: baseline,
      timeoutMs: 2_000,
      pollIntervalMs: 10,
    });
    expect(detected).toMatchObject({
      clientId: "tpc_new",
      resource: "https://mcp.example.com/mcp",
    });

    const firstConnections = await ensureLoginConnections(
      "tenant.example.auth0.com",
      detected!.clientId,
      [],
      true,
    );
    const firstGrant = await ensureUserClientGrant(
      "tenant.example.auth0.com",
      detected!.clientId,
      detected!.resource,
      ["folderforge:read", "folderforge:write"],
      true,
    );
    await ensureLoginConnections(
      "tenant.example.auth0.com",
      detected!.clientId,
      [],
      true,
    );
    await ensureUserClientGrant(
      "tenant.example.auth0.com",
      detected!.clientId,
      detected!.resource,
      ["folderforge:read", "folderforge:write"],
      true,
    );
    const authorize = await verifyAuthorizeEndpoint({
      authorizationEndpoint: "https://tenant.example.auth0.com/authorize",
      client: detected!,
      resource: detected!.resource,
      scopes: ["folderforge:read", "folderforge:write"],
    });

    expect(firstConnections).toEqual([
      { id: "con_db", name: "Username-Password-Authentication" },
    ]);
    expect(firstGrant).toMatchObject({
      clientId: "tpc_new",
      subjectType: "user",
    });
    expect(authorize.outcome).toBe("redirected_to_login_or_callback");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      connectionWrites: number;
      grantCreates: number;
      grantUpdates?: number;
      connections: Array<{ is_domain_connection: boolean }>;
      grants: Array<{
        client_id: string;
        audience: string;
        subject_type: string;
        scope: string[];
      }>;
    };
    expect(state.connectionWrites).toBe(1);
    expect(state.grantCreates).toBe(1);
    expect(state.grantUpdates ?? 0).toBe(0);
    expect(state.connections[0]?.is_domain_connection).toBe(true);
    expect(state.grants[0]).toMatchObject({
      client_id: "tpc_new",
      audience: "https://mcp.example.com/mcp",
      subject_type: "user",
      scope: ["folderforge:read", "folderforge:write"],
    });
  });

  it("recovers a recent existing ChatGPT client that already entered the baseline", async () => {
    const root = mkdtempSync(join(tmpdir(), "folderforge-auth0-recover-"));
    const statePath = join(root, "state.json");
    const client = chatGptClient("tpc_existing");
    writeFileSync(
      statePath,
      JSON.stringify({
        clients: [client],
        logs: [
          {
            date: new Date().toISOString(),
            client_id: client.client_id,
            details: {
              qs: {
                resource: "https://mcp.example.com/mcp",
                redirect_uri:
                  "https://chatgpt.com/connector/oauth/callback-123",
              },
            },
          },
        ],
        connections: [],
        grants: [],
      }),
    );
    process.env.PATH = `${installFakeAuth0(root)}${delimiter}${originalPath ?? ""}`;
    process.env.FAKE_AUTH0_STATE = statePath;
    const progress: string[] = [];

    await expect(
      waitForChatGptClient({
        tenant: "tenant.example.auth0.com",
        resource: "https://mcp.example.com/mcp",
        baselineClientIds: new Set([client.client_id]),
        timeoutMs: 200,
        pollIntervalMs: 5,
        onProgress: (message) => progress.push(message),
      }),
    ).resolves.toMatchObject({
      clientId: client.client_id,
      resource: "https://mcp.example.com/mcp",
    });
    expect(progress).toContain(
      "✓ Recent existing ChatGPT DCR client recovered from an exact Auth0 resource log",
    );
  });

  it("times out cleanly when no new ChatGPT client appears", async () => {
    const root = mkdtempSync(join(tmpdir(), "folderforge-auth0-timeout-"));
    const statePath = join(root, "state.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        clients: [chatGptClient("tpc_old")],
        logs: [],
        connections: [],
        grants: [],
      }),
    );
    process.env.PATH = `${installFakeAuth0(root)}${delimiter}${originalPath ?? ""}`;
    process.env.FAKE_AUTH0_STATE = statePath;
    await expect(
      waitForChatGptClient({
        tenant: "tenant.example.auth0.com",
        resource: "https://mcp.example.com/mcp",
        baselineClientIds: new Set(["tpc_old"]),
        timeoutMs: 30,
        pollIntervalMs: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects multiple new ChatGPT clients that requested the same resource", async () => {
    const root = mkdtempSync(join(tmpdir(), "folderforge-auth0-multiple-"));
    const statePath = join(root, "state.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        clients: [chatGptClient("tpc_one"), chatGptClient("tpc_two")],
        logs: [
          {
            client_id: "tpc_one",
            details: {
              qs: {
                resource: "https://mcp.example.com/mcp",
                redirect_uri:
                  "https://chatgpt.com/connector/oauth/callback-123",
              },
            },
          },
          {
            client_id: "tpc_two",
            details: {
              qs: {
                resource: "https://mcp.example.com/mcp",
                redirect_uri:
                  "https://chatgpt.com/connector/oauth/callback-123",
              },
            },
          },
        ],
        connections: [],
        grants: [],
      }),
    );
    process.env.PATH = `${installFakeAuth0(root)}${delimiter}${originalPath ?? ""}`;
    process.env.FAKE_AUTH0_STATE = statePath;
    await expect(
      waitForChatGptClient({
        tenant: "tenant.example.auth0.com",
        resource: "https://mcp.example.com/mcp",
        baselineClientIds: new Set(),
        timeoutMs: 200,
        pollIntervalMs: 5,
      }),
    ).rejects.toMatchObject<Partial<ChatGptAuth0Error>>({
      code: "MULTIPLE_CHATGPT_CLIENTS",
    });
  });

  it("rejects a ChatGPT-looking client without an exact resource log", async () => {
    const root = mkdtempSync(join(tmpdir(), "folderforge-auth0-resource-"));
    const statePath = join(root, "state.json");
    const candidate = chatGptClient("tpc_wrong_resource");
    writeFileSync(
      statePath,
      JSON.stringify({
        clients: [candidate],
        logs: [
          {
            client_id: candidate.client_id,
            details: { qs: { resource: "https://other.example.com/mcp" } },
          },
        ],
      }),
    );
    process.env.PATH = `${installFakeAuth0(root)}${delimiter}${originalPath ?? ""}`;
    process.env.FAKE_AUTH0_STATE = statePath;
    await expect(
      validateChatGptClientForResource(
        "tenant.example.auth0.com",
        candidate,
        "https://mcp.example.com/mcp",
      ),
    ).rejects.toMatchObject<Partial<ChatGptAuth0Error>>({
      code: "CLIENT_NOT_AUTHORIZED",
    });
  });

  it("classifies authorize endpoint connection and resource errors", async () => {
    const detected = {
      clientId: "tpc_test",
      name: "ChatGPT",
      callbacks: ["https://chatgpt.com/connector/oauth/callback-123"],
      externalMetadataType: "dcr" as const,
      resource: "https://mcp.example.com/mcp",
      detectedAt: "2026-07-16T00:00:00.000Z",
    };
    globalThis.fetch = vi.fn(
      async () =>
        new Response("no connections enabled for the client", { status: 200 }),
    ) as typeof fetch;
    await expect(
      verifyAuthorizeEndpoint({
        authorizationEndpoint: "https://tenant.example.auth0.com/authorize",
        client: detected,
        resource: detected.resource,
        scopes: ["folderforge:read"],
      }),
    ).rejects.toMatchObject<Partial<ChatGptAuth0Error>>({
      code: "NO_CONNECTIONS_ENABLED",
    });

    globalThis.fetch = vi.fn(
      async () =>
        new Response("client is not authorized to access resource server", {
          status: 200,
        }),
    ) as typeof fetch;
    await expect(
      verifyAuthorizeEndpoint({
        authorizationEndpoint: "https://tenant.example.auth0.com/authorize",
        client: detected,
        resource: detected.resource,
        scopes: ["folderforge:read"],
      }),
    ).rejects.toMatchObject<Partial<ChatGptAuth0Error>>({
      code: "CLIENT_NOT_AUTHORIZED",
    });

    globalThis.fetch = vi.fn(
      async () => new Response("oauth error: login_required", { status: 400 }),
    ) as typeof fetch;
    await expect(
      verifyAuthorizeEndpoint({
        authorizationEndpoint: "https://tenant.example.auth0.com/authorize",
        client: detected,
        resource: detected.resource,
        scopes: ["folderforge:read"],
      }),
    ).resolves.toMatchObject({
      status: 400,
      outcome: "login_required",
    });
  });
});
