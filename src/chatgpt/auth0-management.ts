import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { ChatGptDetectedClient, ChatGptErrorCode } from "./lifecycle.js";
import { classifyChatGptError } from "./lifecycle.js";

const MAX_OUTPUT = 1024 * 1024;
const AUTH0_MAX_PAGE_SIZE = 100;
const AUTH0_MAX_PAGES = 1000;
const CHATGPT_CALLBACK_ORIGIN = "https://chatgpt.com";
const CHATGPT_CALLBACK_PREFIX = "/connector/oauth/";
const CHATGPT_EXISTING_CLIENT_RECOVERY_MS = 15 * 60_000;

export interface Auth0DcrClient {
  client_id: string;
  name?: string;
  callbacks?: string[];
  app_type?: string;
  is_first_party?: boolean;
  global?: boolean;
  external_metadata_type?: string;
  external_metadata_created_by?: string;
  resource_server_identifier?: string;
  grant_types?: string[];
  token_endpoint_auth_method?: string;
}

export interface ChatGptDcrClientActivity {
  clientId: string;
  callbacks: string[];
  latestEventAt?: string;
  latestEventType?: string;
  latestResource?: string;
  hasSuccessfulActivity: boolean;
  protected: boolean;
  protectionReasons: string[];
}

export interface ChatGptDcrPrunePlan {
  countedApplications: number;
  chatGptDcrClients: number;
  keep: ChatGptDcrClientActivity[];
  remove: ChatGptDcrClientActivity[];
}

export interface Auth0Connection {
  id: string;
  name: string;
  strategy?: string;
  is_domain_connection?: boolean;
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
  type?: string;
  client_id?: string;
  description?: string;
  details?: {
    qs?: {
      resource?: string;
      redirect_uri?: string;
      client_id?: string;
    };
    requested_audience?: string;
    audience?: string;
    prompts?: Array<{
      grantInfo?: {
        audience?: string;
      };
    }>;
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
  method: "get" | "post" | "patch" | "delete",
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
      query: [...query, `page=${page}`, `per_page=${AUTH0_MAX_PAGE_SIZE}`],
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
    "fields=client_id,name,callbacks,app_type,is_first_party,global,external_metadata_type,external_metadata_created_by,resource_server_identifier,grant_types,token_endpoint_auth_method",
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

export function countAuth0Applications(clients: Auth0DcrClient[]): number {
  return clients.filter(
    (client) => client.global !== true && client.name !== "All Applications",
  ).length;
}

async function listClientLogs(
  tenant: string,
  clientId: string,
): Promise<Auth0LogEntry[]> {
  return await auth0Api<Auth0LogEntry[]>(tenant, "get", "logs", {
    query: [`q=client_id:${clientId}`, "sort=date:-1", "per_page=50"],
  });
}

function resourceFromAuth0Log(log: Auth0LogEntry): string | undefined {
  return (
    log.details?.qs?.resource ??
    log.details?.requested_audience ??
    log.details?.audience ??
    log.details?.prompts
      ?.map((prompt) => prompt.grantInfo?.audience)
      .find((audience): audience is string => Boolean(audience))
  );
}

function callbackGroupKey(callbacks: string[]): string {
  return [...callbacks].sort().join("\n");
}

function latestTimestamp(activity: ChatGptDcrClientActivity): number {
  const timestamp = activity.latestEventAt
    ? Date.parse(activity.latestEventAt)
    : Number.NEGATIVE_INFINITY;
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

export async function planChatGptDcrPrune(
  tenant: string,
  protectedClientIds: ReadonlySet<string> = new Set(),
): Promise<ChatGptDcrPrunePlan> {
  const clients = await listAuth0Clients(tenant);
  const dcrClients = clients.filter(isChatGptDcrClient);
  const activities: ChatGptDcrClientActivity[] = [];
  for (const client of dcrClients) {
    const logs = await listClientLogs(tenant, client.client_id);
    const latest = logs[0];
    const latestResource = logs
      .map(resourceFromAuth0Log)
      .find((resource): resource is string => Boolean(resource));
    const protectionReasons: string[] = [];
    if (protectedClientIds.has(client.client_id)) {
      protectionReasons.push("current_receipt");
    }
    if (logs.some((log) => (log.type ?? "").startsWith("s"))) {
      protectionReasons.push("successful_activity");
    }
    activities.push({
      clientId: client.client_id,
      callbacks: [...(client.callbacks ?? [])],
      ...(latest?.date ? { latestEventAt: latest.date } : {}),
      ...(latest?.type ? { latestEventType: latest.type } : {}),
      ...(latestResource ? { latestResource } : {}),
      hasSuccessfulActivity: protectionReasons.includes("successful_activity"),
      protected: protectionReasons.length > 0,
      protectionReasons,
    });
  }

  const groups = new Map<string, ChatGptDcrClientActivity[]>();
  for (const activity of activities) {
    const key = callbackGroupKey(activity.callbacks);
    const group = groups.get(key) ?? [];
    group.push(activity);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const latest = [...group].sort(
      (left, right) =>
        latestTimestamp(right) - latestTimestamp(left) ||
        right.clientId.localeCompare(left.clientId),
    )[0];
    if (latest && !latest.protectionReasons.includes("latest_for_callback")) {
      latest.protectionReasons.push("latest_for_callback");
      latest.protected = true;
    }
  }

  const sorted = [...activities].sort(
    (left, right) =>
      latestTimestamp(right) - latestTimestamp(left) ||
      left.clientId.localeCompare(right.clientId),
  );
  return {
    countedApplications: countAuth0Applications(clients),
    chatGptDcrClients: dcrClients.length,
    keep: sorted.filter((activity) => activity.protected),
    remove: sorted.filter((activity) => !activity.protected),
  };
}

export async function deleteChatGptDcrClient(
  tenant: string,
  clientId: string,
): Promise<void> {
  const client = await getAuth0Client(tenant, clientId);
  if (!isChatGptDcrClient(client)) {
    throw new ChatGptAuth0Error(
      `Refusing to delete ${clientId}; it is not a safely matched ChatGPT DCR client.`,
      "CALLBACK_MISMATCH",
    );
  }
  await auth0Api<Record<string, never>>(
    tenant,
    "delete",
    `clients/${encodeURIComponent(clientId)}`,
  );
  const remaining = await listAuth0Clients(tenant);
  if (remaining.some((entry) => entry.client_id === clientId)) {
    throw new ChatGptAuth0Error(
      `Auth0 did not delete ChatGPT DCR client ${clientId}.`,
    );
  }
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
    const loggedResource = resourceFromAuth0Log(log);
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

async function matchingChatGptClientsForResource(
  tenant: string,
  clients: Auth0DcrClient[],
  resource: string,
): Promise<ChatGptDetectedClient[]> {
  const matches: ChatGptDetectedClient[] = [];
  for (const candidate of clients) {
    try {
      matches.push(
        await validateChatGptClientForResource(tenant, candidate, resource),
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
  return matches;
}

function isRecentRecoveredClient(
  client: ChatGptDetectedClient,
  now = Date.now(),
): boolean {
  const detectedAt = Date.parse(client.detectedAt);
  return (
    Number.isFinite(detectedAt) &&
    detectedAt <= now &&
    now - detectedAt <= CHATGPT_EXISTING_CLIENT_RECOVERY_MS
  );
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
  let announcedRecovery = false;
  while (Date.now() < deadline) {
    const clients = (await listAuth0Clients(options.tenant)).filter(
      isChatGptDcrClient,
    );
    const newCandidates = clients.filter(
      (client) => !options.baselineClientIds.has(client.client_id),
    );
    if (newCandidates.length > 0 && !announcedCandidate) {
      announcedCandidate = true;
      options.onProgress?.(
        "✓ ChatGPT DCR client detected; verifying its requested resource",
      );
    }
    const newMatches = await matchingChatGptClientsForResource(
      options.tenant,
      newCandidates,
      options.resource,
    );
    if (newMatches.length === 1) return newMatches[0];
    if (newMatches.length > 1) {
      throw new ChatGptAuth0Error(
        "Multiple new ChatGPT DCR clients requested this resource. Re-run with an explicit --client-id after reviewing them.",
        "MULTIPLE_CHATGPT_CLIENTS",
      );
    }

    const existingCandidates = clients.filter((client) =>
      options.baselineClientIds.has(client.client_id),
    );
    const recoveredMatches = (
      await matchingChatGptClientsForResource(
        options.tenant,
        existingCandidates,
        options.resource,
      )
    ).filter((client) => isRecentRecoveredClient(client));
    if (recoveredMatches.length === 1) {
      if (!announcedRecovery) {
        announcedRecovery = true;
        options.onProgress?.(
          "✓ Recent existing ChatGPT DCR client recovered from an exact Auth0 resource log",
        );
      }
      return recoveredMatches[0];
    }
    if (recoveredMatches.length > 1) {
      throw new ChatGptAuth0Error(
        "Multiple recent ChatGPT DCR clients requested this resource. Re-run with an explicit --client-id after reviewing them.",
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

async function getAuth0Connection(
  tenant: string,
  connectionId: string,
): Promise<Auth0Connection> {
  return await auth0Api<Auth0Connection>(
    tenant,
    "get",
    `connections/${encodeURIComponent(connectionId)}`,
  );
}

export async function ensureLoginConnections(
  tenant: string,
  _clientId: string,
  requestedNames: string[],
  repair: boolean,
): Promise<Array<{ id: string; name: string }>> {
  const selected = selectLoginConnections(
    await listAuth0Connections(tenant),
    requestedNames,
  );
  for (const connection of selected) {
    if (connection.is_domain_connection === true) continue;
    if (!repair) {
      throw new ChatGptAuth0Error(
        `Login connection ${connection.name} is not promoted to the Auth0 domain level required by third-party DCR clients.`,
        "NO_CONNECTIONS_ENABLED",
      );
    }
    await auth0Api<Auth0Connection>(
      tenant,
      "patch",
      `connections/${encodeURIComponent(connection.id)}`,
      { data: { is_domain_connection: true } },
    );
    const verified = await getAuth0Connection(tenant, connection.id);
    if (verified.is_domain_connection !== true) {
      throw new ChatGptAuth0Error(
        `Auth0 did not promote ${connection.name} to a domain-level connection.`,
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

async function ensureGrantScopes(
  tenant: string,
  grant: Auth0ClientGrant,
  scopes: string[],
  repair: boolean,
  errorLabel: string,
): Promise<string[]> {
  const currentScopes = new Set(grant.scope ?? []);
  const missing = scopes.filter((scope) => !currentScopes.has(scope));
  if (missing.length === 0) return [...currentScopes];
  if (!repair || !grant.id) {
    throw new ChatGptAuth0Error(
      `${errorLabel} is missing scope(s): ${missing.join(", ")}`,
      "CLIENT_NOT_AUTHORIZED",
    );
  }
  const merged = [...new Set([...(grant.scope ?? []), ...scopes])];
  await auth0Api<Auth0ClientGrant>(
    tenant,
    "patch",
    `client-grants/${encodeURIComponent(grant.id)}`,
    { data: { scope: merged } },
  );
  grant.scope = merged;
  return merged;
}

export async function ensureDefaultThirdPartyUserGrant(
  tenant: string,
  audience: string,
  scopes: string[],
  repair: boolean,
): Promise<{
  id?: string;
  defaultFor: "third_party_clients";
  audience: string;
  scopes: string[];
  subjectType: "user";
}> {
  const grants = await listAuth0ClientGrants(tenant);
  const matching = grants.find(
    (grant) =>
      grant.default_for === "third_party_clients" &&
      grant.audience === audience &&
      grant.subject_type === "user" &&
      !grant.client_id,
  );
  if (!matching) {
    if (!repair) {
      throw new ChatGptAuth0Error(
        "No default third-party user grant exists for this FolderForge resource server.",
        "CLIENT_NOT_AUTHORIZED",
      );
    }
    const created = await auth0Api<Auth0ClientGrant>(
      tenant,
      "post",
      "client-grants",
      {
        data: {
          default_for: "third_party_clients",
          audience,
          scope: scopes,
          subject_type: "user",
        },
      },
    );
    return {
      ...(created.id ? { id: created.id } : {}),
      defaultFor: "third_party_clients",
      audience,
      scopes: [...scopes],
      subjectType: "user",
    };
  }
  const mergedScopes = await ensureGrantScopes(
    tenant,
    matching,
    scopes,
    repair,
    "The default third-party user grant",
  );
  return {
    ...(matching.id ? { id: matching.id } : {}),
    defaultFor: "third_party_clients",
    audience,
    scopes: mergedScopes,
    subjectType: "user",
  };
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
  const defaultGrant = grants.find(
    (grant) =>
      grant.default_for === "third_party_clients" &&
      grant.audience === audience &&
      grant.subject_type === "user" &&
      !grant.client_id,
  );
  if (!matching && defaultGrant) {
    const mergedScopes = await ensureGrantScopes(
      tenant,
      defaultGrant,
      scopes,
      repair,
      "The default third-party user grant",
    );
    return {
      ...(defaultGrant.id ? { id: defaultGrant.id } : {}),
      clientId,
      audience,
      scopes: mergedScopes,
      subjectType: "user",
    };
  }
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
  const mergedScopes = await ensureGrantScopes(
    tenant,
    matching,
    scopes,
    repair,
    "The ChatGPT user grant",
  );
  return {
    ...(matching.id ? { id: matching.id } : {}),
    clientId,
    audience,
    scopes: mergedScopes,
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
  if (lower.includes("login_required")) {
    return {
      checkedAt: new Date().toISOString(),
      status: response.status,
      outcome: "login_required",
    };
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
