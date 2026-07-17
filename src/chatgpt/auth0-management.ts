import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { ChatGptDetectedClient, ChatGptErrorCode } from "./lifecycle.js";
import { classifyChatGptError } from "./lifecycle.js";

const MAX_OUTPUT = 1024 * 1024;
const AUTH0_MAX_PAGE_SIZE = 100;
const AUTH0_MAX_PAGES = 1000;
const CHATGPT_CALLBACK_ORIGIN = "https://chatgpt.com";
const CHATGPT_CALLBACK_PREFIX = "/connector/oauth/";

export interface Auth0DcrClient {
  client_id: string;
  name?: string;
  callbacks?: string[];
  app_type?: string;
  is_first_party?: boolean;
  external_metadata_type?: string;
  external_metadata_created_by?: string;
  resource_server_identifier?: string;
  grant_types?: string[];
  token_endpoint_auth_method?: string;
}

export interface Auth0Connection {
  id: string;
  name: string;
  strategy?: string;
  authentication?: { active?: boolean };
}

export interface Auth0ClientGrant {
  id?: string;
  client_id?: string;
  audience?: string;
  scope?: string[];
  subject_type?: string;
  default_for?: string;
}

interface Auth0LogEntry {
  date?: string;
  client_id?: string;
  description?: string;
  details?: {
    qs?: {
      resource?: string;
      redirect_uri?: string;
      client_id?: string;
    };
    error?: { message?: string; oauthError?: string; type?: string };
  };
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class ChatGptAuth0Error extends Error {
  constructor(
    message: string,
    readonly code: ChatGptErrorCode = classifyChatGptError(message),
    readonly evidence?: string,
  ) {
    super(message);
    this.name = "ChatGptAuth0Error";
  }
}

async function runAuth0(
  args: string[],
  timeoutMs = 30_000,
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve) => {
    const child = spawn("auth0", args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString("utf8")}`.slice(-MAX_OUTPUT);
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) {
        settled = true;
        resolve({
          exitCode: 124,
          stdout,
          stderr: `${stderr}\nAuth0 command timed out`,
        });
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        resolve({
          exitCode: 127,
          stdout,
          stderr: `${stderr}\n${error.message}`,
        });
      }
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        resolve({ exitCode: code ?? 1, stdout, stderr });
      }
    });
  });
}

function parseJson<T>(raw: string): T {
  const trimmed = raw.trim();
  if (!trimmed) throw new ChatGptAuth0Error("Auth0 returned an empty response");
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const starts = [trimmed.indexOf("["), trimmed.indexOf("{")].filter(
      (value) => value >= 0,
    );
    for (const start of starts.sort((a, b) => a - b)) {
      try {
        return JSON.parse(trimmed.slice(start)) as T;
      } catch {
        // Try the next possible JSON boundary.
      }
    }
    throw new ChatGptAuth0Error(
      "Auth0 returned invalid JSON",
      "UNKNOWN",
      trimmed.slice(0, 500),
    );
  }
}

async function auth0Api<T>(
  tenant: string,
  method: "get" | "post" | "patch",
  path: string,
  options: { query?: string[]; data?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const args = [
    "api",
    method,
    path,
    "--tenant",
    tenant,
    "--no-color",
    "--no-input",
  ];
  for (const query of options.query ?? []) args.push("-q", query);
  if (options.data !== undefined)
    args.push("--data", JSON.stringify(options.data));
  const result = await runAuth0(args, options.timeoutMs);
  if (result.exitCode !== 0) {
    const message =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `Auth0 API ${method.toUpperCase()} ${path} failed`;
    throw new ChatGptAuth0Error(
      message,
      classifyChatGptError(message),
      redactEvidence(message),
    );
  }
  const raw = result.stdout || result.stderr;
  if (!raw.trim() && method !== "get") return {} as T;
  return parseJson<T>(raw);
}

async function auth0ApiList<T>(
  tenant: string,
  path: string,
  query: string[] = [],
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 0; page < AUTH0_MAX_PAGES; page += 1) {
    const batch = await auth0Api<T[]>(tenant, "get", path, {
      query: [
        ...query,
        `page=${page}`,
        `per_page=${AUTH0_MAX_PAGE_SIZE}`,
      ],
    });
    if (!Array.isArray(batch)) {
      throw new ChatGptAuth0Error(
        `Auth0 API GET ${path} returned an invalid collection`,
      );
    }
    items.push(...batch);
    if (batch.length < AUTH0_MAX_PAGE_SIZE) return items;
  }
  throw new ChatGptAuth0Error(
    `Auth0 API GET ${path} exceeded ${AUTH0_MAX_PAGES} pages`,
  );
}

function redactEvidence(value: string): string {
  return value
    .replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      "[REDACTED_JWT]",
    )
    .replace(
      /("?(?:access|refresh)_token"?\s*[:=]\s*")([^"]+)(")/gi,
      "$1[REDACTED]$3",
    )
    .replace(/("?client_secret"?\s*[:=]\s*")([^"]+)(")/gi, "$1[REDACTED]$3")
    .slice(0, 1000);
}

export async function listAuth0Clients(
  tenant: string,
): Promise<Auth0DcrClient[]> {
  return await auth0ApiList<Auth0DcrClient>(tenant, "clients", [
    "fields=client_id,name,callbacks,app_type,is_first_party,external_metadata_type,external_metadata_created_by,resource_server_identifier,grant_types,token_endpoint_auth_method",
    "include_fields=true",
  ]);
}

export async function getAuth0Client(
  tenant: string,
  clientId: string,
): Promise<Auth0DcrClient> {
  return await auth0Api<Auth0DcrClient>(
    tenant,
    "get",
    `clients/${encodeURIComponent(clientId)}`,
  );
}

export function isChatGptCallback(callback: string): boolean {
  try {
    const url = new URL(callback);
    return (
      url.origin === CHATGPT_CALLBACK_ORIGIN &&
      url.pathname.startsWith(CHATGPT_CALLBACK_PREFIX) &&
      url.pathname.length > CHATGPT_CALLBACK_PREFIX.length &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function isChatGptDcrClient(client: Auth0DcrClient): boolean {
  return (
    client.name?.trim().toLowerCase() === "chatgpt" &&
    client.external_metadata_type === "dcr" &&
    client.external_metadata_created_by === "client" &&
    client.is_first_party === false &&
    client.token_endpoint_auth_method !== "client_secret_post" &&
    (client.callbacks ?? []).length > 0 &&
    (client.callbacks ?? []).every(isChatGptCallback) &&
    (client.grant_types ?? []).includes("authorization_code")
  );
}

async function resourceFromClientLogs(
  tenant: string,
  clientId: string,
  resource: string,
): Promise<{ resource: string; callback?: string; date?: string } | undefined> {
  const logs = await auth0Api<Auth0LogEntry[]>(tenant, "get", "logs", {
    query: [`q=client_id:${clientId}`, "sort=date:-1", "per_page=20"],
  });
  for (const log of logs) {
    const loggedResource = log.details?.qs?.resource;
    if (loggedResource !== resource) continue;
    return {
      resource: loggedResource,
      ...(log.details?.qs?.redirect_uri
        ? { callback: log.details.qs.redirect_uri }
        : {}),
      ...(log.date ? { date: log.date } : {}),
    };
  }
  return undefined;
}

export async function validateChatGptClientForResource(
  tenant: string,
  client: Auth0DcrClient,
  resource: string,
): Promise<ChatGptDetectedClient> {
  if (!isChatGptDcrClient(client)) {
    throw new ChatGptAuth0Error(
      "The selected OAuth client is not a safely matching ChatGPT DCR client.",
      "CALLBACK_MISMATCH",
    );
  }
  if (
    client.resource_server_identifier &&
    client.resource_server_identifier !== resource
  ) {
    throw new ChatGptAuth0Error(
      "The selected ChatGPT client belongs to a different resource server.",
      "CLIENT_NOT_AUTHORIZED",
    );
  }
  const logMatch = await resourceFromClientLogs(
    tenant,
    client.client_id,
    resource,
  );
  if (!logMatch) {
    throw new ChatGptAuth0Error(
      "ChatGPT client was detected, but no Auth0 authorize log proves that it requested this FolderForge resource.",
      "CLIENT_NOT_AUTHORIZED",
    );
  }
  if (
    logMatch.callback &&
    !(client.callbacks ?? []).includes(logMatch.callback)
  ) {
    throw new ChatGptAuth0Error(
      "The ChatGPT authorize callback does not match the registered callback.",
      "CALLBACK_MISMATCH",
    );
  }
  return {
    clientId: client.client_id,
    name: client.name ?? "ChatGPT",
    callbacks: [...(client.callbacks ?? [])],
    externalMetadataType: "dcr",
    resource,
    detectedAt: logMatch.date ?? new Date().toISOString(),
  };
}

export interface WaitForChatGptClientOptions {
  tenant: string;
  resource: string;
  baselineClientIds: ReadonlySet<string>;
  timeoutMs: number;
  pollIntervalMs: number;
  explicitClientId?: string;
  onProgress?: (message: string) => void;
}

export async function waitForChatGptClient(
  options: WaitForChatGptClientOptions,
): Promise<ChatGptDetectedClient | undefined> {
  if (options.explicitClientId) {
    const explicit = await getAuth0Client(
      options.tenant,
      options.explicitClientId,
    );
    return await validateChatGptClientForResource(
      options.tenant,
      explicit,
      options.resource,
    );
  }
  const deadline = Date.now() + options.timeoutMs;
  let announcedCandidate = false;
  while (Date.now() < deadline) {
    const clients = await listAuth0Clients(options.tenant);
    const candidates = clients.filter(
      (client) =>
        !options.baselineClientIds.has(client.client_id) &&
        isChatGptDcrClient(client),
    );
    if (candidates.length > 0 && !announcedCandidate) {
      announcedCandidate = true;
      options.onProgress?.(
        "✓ ChatGPT DCR client detected; verifying its requested resource",
      );
    }
    const matches: ChatGptDetectedClient[] = [];
    for (const candidate of candidates) {
      try {
        matches.push(
          await validateChatGptClientForResource(
            options.tenant,
            candidate,
            options.resource,
          ),
        );
      } catch (error) {
        if (
          !(error instanceof ChatGptAuth0Error) ||
          error.code !== "CLIENT_NOT_AUTHORIZED"
        ) {
          throw error;
        }
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new ChatGptAuth0Error(
        "Multiple new ChatGPT DCR clients requested this resource. Re-run with an explicit --client-id after reviewing them.",
        "MULTIPLE_CHATGPT_CLIENTS",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
  }
  return undefined;
}

export async function listAuth0Connections(
  tenant: string,
): Promise<Auth0Connection[]> {
  return await auth0ApiList<Auth0Connection>(tenant, "connections", [
    "fields=id,name,strategy,authentication",
    "include_fields=true",
  ]);
}

export function selectLoginConnections(
  connections: Auth0Connection[],
  requestedNames: string[] = [],
): Auth0Connection[] {
  const active = connections.filter(
    (connection) => connection.authentication?.active !== false,
  );
  if (requestedNames.length > 0) {
    const selected = requestedNames.map((name) =>
      active.find(
        (connection) => connection.name.toLowerCase() === name.toLowerCase(),
      ),
    );
    const missing = requestedNames.filter((_, index) => !selected[index]);
    if (missing.length > 0) {
      throw new ChatGptAuth0Error(
        `Requested Auth0 login connection(s) not found or inactive: ${missing.join(", ")}`,
        "NO_CONNECTIONS_ENABLED",
      );
    }
    return selected as Auth0Connection[];
  }
  const database = active.filter(
    (connection) => connection.strategy === "auth0",
  );
  if (database.length === 1) return database;
  const conventional = database.find(
    (connection) => connection.name === "Username-Password-Authentication",
  );
  if (conventional) return [conventional];
  if (active.length === 1) return active;
  throw new ChatGptAuth0Error(
    "No unique safe default login connection could be selected. Pass --login-connection <name>.",
    "NO_CONNECTIONS_ENABLED",
  );
}

async function connectionClientIds(
  tenant: string,
  connectionId: string,
): Promise<string[]> {
  const result = await auth0Api<{ clients?: Array<{ client_id?: string }> }>(
    tenant,
    "get",
    `connections/${encodeURIComponent(connectionId)}/clients`,
  );
  return (result.clients ?? [])
    .map((entry) => entry.client_id)
    .filter((value): value is string => Boolean(value));
}

export async function ensureLoginConnections(
  tenant: string,
  clientId: string,
  requestedNames: string[],
  repair: boolean,
): Promise<Array<{ id: string; name: string }>> {
  const selected = selectLoginConnections(
    await listAuth0Connections(tenant),
    requestedNames,
  );
  for (const connection of selected) {
    const clients = await connectionClientIds(tenant, connection.id);
    if (clients.includes(clientId)) continue;
    if (!repair) {
      throw new ChatGptAuth0Error(
        `No connections enabled for the ChatGPT client (${connection.name}).`,
        "NO_CONNECTIONS_ENABLED",
      );
    }
    await auth0Api<Record<string, unknown>>(
      tenant,
      "post",
      `connections/${encodeURIComponent(connection.id)}/clients`,
      { data: { client_id: clientId } },
    );
    const verified = await connectionClientIds(tenant, connection.id);
    if (!verified.includes(clientId)) {
      throw new ChatGptAuth0Error(
        `Auth0 did not retain the client membership for ${connection.name}.`,
        "NO_CONNECTIONS_ENABLED",
      );
    }
  }
  return selected.map(({ id, name }) => ({ id, name }));
}

export async function listAuth0ClientGrants(
  tenant: string,
): Promise<Auth0ClientGrant[]> {
  return await auth0ApiList<Auth0ClientGrant>(tenant, "client-grants");
}

export async function ensureUserClientGrant(
  tenant: string,
  clientId: string,
  audience: string,
  scopes: string[],
  repair: boolean,
): Promise<{
  id?: string;
  clientId: string;
  audience: string;
  scopes: string[];
  subjectType: "user";
}> {
  const grants = await listAuth0ClientGrants(tenant);
  const matching = grants.find(
    (grant) =>
      grant.client_id === clientId &&
      grant.audience === audience &&
      grant.subject_type === "user" &&
      !grant.default_for,
  );
  if (!matching) {
    if (!repair) {
      throw new ChatGptAuth0Error(
        "The ChatGPT client is not authorized to access this FolderForge resource server.",
        "CLIENT_NOT_AUTHORIZED",
      );
    }
    const created = await auth0Api<Auth0ClientGrant>(
      tenant,
      "post",
      "client-grants",
      {
        data: {
          client_id: clientId,
          audience,
          scope: scopes,
          subject_type: "user",
        },
      },
    );
    return {
      ...(created.id ? { id: created.id } : {}),
      clientId,
      audience,
      scopes: [...scopes],
      subjectType: "user",
    };
  }
  const currentScopes = new Set(matching.scope ?? []);
  const missing = scopes.filter((scope) => !currentScopes.has(scope));
  if (missing.length > 0) {
    if (!repair || !matching.id) {
      throw new ChatGptAuth0Error(
        `The ChatGPT user grant is missing scope(s): ${missing.join(", ")}`,
        "CLIENT_NOT_AUTHORIZED",
      );
    }
    const merged = [...new Set([...(matching.scope ?? []), ...scopes])];
    await auth0Api<Auth0ClientGrant>(
      tenant,
      "patch",
      `client-grants/${encodeURIComponent(matching.id)}`,
      { data: { scope: merged } },
    );
    matching.scope = merged;
  }
  return {
    ...(matching.id ? { id: matching.id } : {}),
    clientId,
    audience,
    scopes: [...new Set([...(matching.scope ?? []), ...scopes])],
    subjectType: "user",
  };
}

export async function verifyAuthorizeEndpoint(options: {
  authorizationEndpoint: string;
  client: ChatGptDetectedClient;
  resource: string;
  scopes: string[];
  timeoutMs?: number;
}): Promise<{ checkedAt: string; status: number; outcome: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(options.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.client.clientId);
  url.searchParams.set("redirect_uri", options.client.callbacks[0]!);
  url.searchParams.set(
    "scope",
    ["openid", "email", "offline_access", ...options.scopes].join(" "),
  );
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", options.resource);
  url.searchParams.set("state", randomBytes(16).toString("base64url"));
  url.searchParams.set("prompt", "none");
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    headers: { accept: "text/html,application/json" },
  });
  const location = response.headers.get("location") ?? "";
  const body = (await response.text()).slice(0, 20_000);
  const combined = `${location}\n${body}`;
  const lower = combined.toLowerCase();
  if (lower.includes("no connections enabled")) {
    throw new ChatGptAuth0Error(
      "No connections enabled for the ChatGPT client.",
      "NO_CONNECTIONS_ENABLED",
    );
  }
  if (
    lower.includes("not authorized to access resource server") ||
    lower.includes("unauthorized_client")
  ) {
    throw new ChatGptAuth0Error(
      "The ChatGPT client is not authorized to access the FolderForge resource server.",
      "CLIENT_NOT_AUTHORIZED",
    );
  }
  if (
    lower.includes("callback") &&
    (lower.includes("mismatch") || lower.includes("not allowed"))
  ) {
    throw new ChatGptAuth0Error(
      "Auth0 rejected the ChatGPT callback URI.",
      "CALLBACK_MISMATCH",
    );
  }
  if (response.status >= 400) {
    throw new ChatGptAuth0Error(
      `Auth0 authorize verification failed with HTTP ${response.status}.`,
      classifyChatGptError(combined),
      redactEvidence(combined),
    );
  }
  return {
    checkedAt: new Date().toISOString(),
    status: response.status,
    outcome: location ? "redirected_to_login_or_callback" : "login_page_ready",
  };
}
