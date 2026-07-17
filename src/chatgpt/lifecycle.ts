const CHATGPT_CALLBACK_PREFIX = "https://chatgpt.com/connector/oauth/";

export const CHATGPT_LIFECYCLE_STAGES = [
  "UNCONFIGURED",
  "AUTH0_READY",
  "RESOURCE_SERVER_READY",
  "LOCAL_SERVER_READY",
  "PUBLIC_ENDPOINT_READY",
  "OAUTH_METADATA_READY",
  "WAITING_FOR_CHATGPT_CLIENT",
  "CHATGPT_CLIENT_DETECTED",
  "LOGIN_CONNECTIONS_READY",
  "USER_GRANT_READY",
  "AUTHORIZE_READY",
  "READY_TO_COMPLETE_LOGIN",
  "CONNECTED",
] as const;

export const CHATGPT_ERROR_STATES = [
  "AUTH0_LOGIN_REQUIRED",
  "AUTH0_SCOPE_MISSING",
  "AUTH0_UNREACHABLE",
  "DCR_DISABLED",
  "RESOURCE_SERVER_MISCONFIGURED",
  "LOCAL_SERVER_STOPPED",
  "PORT_IN_USE",
  "TUNNEL_STOPPED",
  "PUBLIC_ENDPOINT_502",
  "PUBLIC_ENDPOINT_UNREACHABLE",
  "METADATA_INVALID",
  "CLIENT_NOT_AUTHORIZED",
  "NO_CONNECTIONS_ENABLED",
  "CALLBACK_MISMATCH",
  "TOKEN_EXCHANGE_FAILED",
  "MCP_TOOL_LIMIT_EXCEEDED",
  "MULTIPLE_CHATGPT_CLIENTS",
  "CHATGPT_CLIENT_TIMEOUT",
  "UNKNOWN",
] as const;

export type ChatGptLifecycleStage = (typeof CHATGPT_LIFECYCLE_STAGES)[number];
export type ChatGptErrorState = (typeof CHATGPT_ERROR_STATES)[number];
export type ChatGptErrorCode = ChatGptErrorState;

export interface ChatGptDetectedClient {
  clientId: string;
  name: string;
  callbacks: string[];
  externalMetadataType: "dcr";
  resource: string;
  detectedAt: string;
}

export interface ChatGptLifecycleRecord {
  sessionId: string;
  sessionStartedAt: string;
  stage: ChatGptLifecycleStage;
  detectedClient?: ChatGptDetectedClient;
  loginConnections?: Array<{ id: string; name: string }>;
  userGrant?: {
    id?: string;
    clientId: string;
    audience: string;
    scopes: string[];
    subjectType: "user";
  };
  authorize?: { checkedAt: string; status: number; outcome: string };
  diagnostics?: ChatGptDiagnostic[];
  lastError?: {
    code: ChatGptErrorState;
    message: string;
    evidence?: string;
    at: string;
  };
}

export type ChatGptLifecycleState = ChatGptLifecycleStage | ChatGptErrorState;
export type ChatGptOverallStatus =
  "connected" | "waiting_for_chatgpt" | "needs_attention" | "stopped";
export type ChatGptDiagnosticStatus = "pass" | "pending" | "fail" | "not_run";

export interface ChatGptDiagnostic {
  id: string;
  stage: ChatGptLifecycleStage;
  status: ChatGptDiagnosticStatus;
  checkedAt: string;
  evidence: string;
  autoRepair: boolean;
  repairAction?: string;
  userAction?: string;
  errorState?: ChatGptErrorState;
}

export interface ChatGptTimelineItem {
  stage: ChatGptLifecycleStage;
  label: string;
  status: ChatGptDiagnosticStatus;
  evidence: string;
}

export interface ChatGptLifecycleSnapshot {
  state: ChatGptLifecycleState;
  overall: ChatGptOverallStatus;
  timeline: ChatGptTimelineItem[];
  diagnostics: ChatGptDiagnostic[];
  actions: string[];
  updatedAt: string;
}

export interface ChatGptLifecycleInput {
  receiptExists: boolean;
  serverAlive: boolean;
  tunnelRequired: boolean;
  tunnelAlive: boolean;
  checks: Partial<
    Record<
      | "dependencies"
      | "tenant"
      | "dcr"
      | "auth0Api"
      | "localServer"
      | "publicEndpoint"
      | "resourceMetadata"
      | "unauthorizedChallenge"
      | "chatgptClient"
      | "loginConnections"
      | "userGrant"
      | "authorize"
      | "tokenValidation"
      | "mcpInitialize",
      ChatGptDiagnosticStatus
    >
  >;
  diagnostics?: ChatGptDiagnostic[];
  updatedAt?: string;
}

export interface Auth0ClientCandidate {
  client_id?: string;
  name?: string;
  callbacks?: string[];
  client_metadata?: Record<string, string>;
  external_metadata_type?: string;
  registration_type?: string;
  resource_server_identifier?: string;
  grant_types?: string[];
  token_endpoint_auth_method?: string;
}

export interface ClientMatchResult {
  matched: boolean;
  reasons: string[];
}

const LABELS: Record<ChatGptLifecycleStage, string> = {
  UNCONFIGURED: "Project configuration",
  AUTH0_READY: "Auth0 tenant",
  RESOURCE_SERVER_READY: "Resource server",
  LOCAL_SERVER_READY: "Local MCP server",
  PUBLIC_ENDPOINT_READY: "Tunnel / public URL",
  OAUTH_METADATA_READY: "OAuth metadata and 401 challenge",
  WAITING_FOR_CHATGPT_CLIENT: "Waiting for ChatGPT",
  CHATGPT_CLIENT_DETECTED: "ChatGPT DCR client",
  LOGIN_CONNECTIONS_READY: "Login connection",
  USER_GRANT_READY: "User grant",
  AUTHORIZE_READY: "Authorization endpoint",
  READY_TO_COMPLETE_LOGIN: "Ready to complete login",
  CONNECTED: "MCP authenticated handshake",
};

const SECRET_KEY_PATTERN =
  /(secret|token|authorization|cookie|password|verifier|code)$/i;
const JWT_PATTERN =
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~-]+/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /((?:client_secret|access_token|refresh_token|id_token|password|cookie)\s*[:=]\s*)(["']?)([^\s"',;}]+)\2/gi;
const OPENAI_STYLE_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{12,}\b/g;

export function redactSensitiveText(value: string): string {
  return value
    .replace(JWT_PATTERN, "[REDACTED_JWT]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1[REDACTED]")
    .replace(OPENAI_STYLE_KEY_PATTERN, "[REDACTED_API_KEY]");
}

export function redactSensitive<T>(value: T): T {
  const visit = (input: unknown, key?: string): unknown => {
    if (key && SECRET_KEY_PATTERN.test(key)) return "[REDACTED]";
    if (typeof input === "string") return redactSensitiveText(input);
    if (Array.isArray(input)) return input.map((entry) => visit(entry));
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input).map(([entryKey, entry]) => [
          entryKey,
          visit(entry, entryKey),
        ]),
      );
    }
    return input;
  };
  return visit(value) as T;
}

function callbackIsChatGpt(callback: string): boolean {
  try {
    const url = new URL(callback);
    return (
      url.protocol === "https:" &&
      url.origin === "https://chatgpt.com" &&
      url.pathname.startsWith("/connector/oauth/")
    );
  } catch {
    return false;
  }
}

export function matchChatGptClient(
  candidate: Auth0ClientCandidate,
  expectedResource: string,
  baselineClientIds: ReadonlySet<string> = new Set(),
): ClientMatchResult {
  const reasons: string[] = [];
  const clientId = candidate.client_id ?? "";
  if (!clientId) reasons.push("missing client_id");
  if (baselineClientIds.has(clientId))
    reasons.push("client existed before this connect session");
  if (!/chatgpt/i.test(candidate.name ?? ""))
    reasons.push("client name is not ChatGPT");

  const dcrMarker =
    candidate.external_metadata_type === "dcr" ||
    candidate.registration_type === "dcr" ||
    clientId.startsWith("tpc_");
  if (!dcrMarker)
    reasons.push("client is not marked as a DCR/third-party client");

  const callbacks = candidate.callbacks ?? [];
  if (callbacks.length === 0 || !callbacks.some(callbackIsChatGpt)) {
    reasons.push(`callback is not under ${CHATGPT_CALLBACK_PREFIX}`);
  }
  if (callbacks.some((callback) => !callbackIsChatGpt(callback))) {
    reasons.push(
      "client includes a callback outside the ChatGPT connector callback boundary",
    );
  }

  const metadataResource =
    candidate.client_metadata?.resource ??
    candidate.client_metadata?.audience ??
    candidate.resource_server_identifier;
  if (metadataResource !== expectedResource)
    reasons.push("resource/audience does not match this FolderForge project");

  const grants = candidate.grant_types ?? [];
  if (grants.length > 0 && !grants.includes("authorization_code"))
    reasons.push("authorization_code grant is not enabled");
  if (
    candidate.token_endpoint_auth_method &&
    candidate.token_endpoint_auth_method !== "none"
  ) {
    reasons.push("DCR client is not a public PKCE client");
  }

  return { matched: reasons.length === 0, reasons };
}

function statusFor(
  checks: ChatGptLifecycleInput["checks"],
  ...keys: Array<keyof ChatGptLifecycleInput["checks"]>
): ChatGptDiagnosticStatus {
  const values = keys
    .map((key) => checks[key])
    .filter((value): value is ChatGptDiagnosticStatus => Boolean(value));
  if (values.includes("fail")) return "fail";
  if (values.includes("pending")) return "pending";
  if (values.length > 0 && values.every((value) => value === "pass"))
    return "pass";
  return "not_run";
}

function timeline(input: ChatGptLifecycleInput): ChatGptTimelineItem[] {
  const configured: ChatGptDiagnosticStatus = input.receiptExists
    ? "pass"
    : "not_run";
  const map = new Map<ChatGptLifecycleStage, ChatGptDiagnosticStatus>([
    ["UNCONFIGURED", configured],
    ["AUTH0_READY", statusFor(input.checks, "dependencies", "tenant", "dcr")],
    ["RESOURCE_SERVER_READY", statusFor(input.checks, "auth0Api")],
    [
      "LOCAL_SERVER_READY",
      input.serverAlive ? "pass" : statusFor(input.checks, "localServer"),
    ],
    [
      "PUBLIC_ENDPOINT_READY",
      input.tunnelRequired && !input.tunnelAlive
        ? "fail"
        : statusFor(input.checks, "publicEndpoint"),
    ],
    [
      "OAUTH_METADATA_READY",
      statusFor(input.checks, "resourceMetadata", "unauthorizedChallenge"),
    ],
    [
      "WAITING_FOR_CHATGPT_CLIENT",
      statusFor(input.checks, "chatgptClient") === "not_run"
        ? "pending"
        : statusFor(input.checks, "chatgptClient"),
    ],
    ["CHATGPT_CLIENT_DETECTED", statusFor(input.checks, "chatgptClient")],
    ["LOGIN_CONNECTIONS_READY", statusFor(input.checks, "loginConnections")],
    ["USER_GRANT_READY", statusFor(input.checks, "userGrant")],
    ["AUTHORIZE_READY", statusFor(input.checks, "authorize")],
    ["READY_TO_COMPLETE_LOGIN", statusFor(input.checks, "authorize")],
    ["CONNECTED", statusFor(input.checks, "tokenValidation", "mcpInitialize")],
  ]);
  return CHATGPT_LIFECYCLE_STAGES.map((stage) => ({
    stage,
    label: LABELS[stage],
    status: map.get(stage) ?? "not_run",
    evidence:
      input.diagnostics?.find((diagnostic) => diagnostic.stage === stage)
        ?.evidence ?? "",
  }));
}

function lastPassedStage(items: ChatGptTimelineItem[]): ChatGptLifecycleStage {
  let current: ChatGptLifecycleStage = "UNCONFIGURED";
  for (const item of items) {
    if (item.status !== "pass") break;
    current = item.stage;
  }
  return current;
}

export function classifyChatGptError(message: string): ChatGptErrorState {
  const lower = message.toLowerCase();
  if (
    lower.includes("not logged in") ||
    lower.includes("authentication required")
  )
    return "AUTH0_LOGIN_REQUIRED";
  if (
    lower.includes("insufficient_scope") ||
    lower.includes("missing scope") ||
    lower.includes("access denied")
  )
    return "AUTH0_SCOPE_MISSING";
  if (
    lower.includes("dynamic client registration") &&
    lower.includes("disabled")
  )
    return "DCR_DISABLED";
  if (lower.includes("port") && lower.includes("already in use"))
    return "PORT_IN_USE";
  if (lower.includes("502")) return "PUBLIC_ENDPOINT_502";
  if (lower.includes("no connections enabled")) return "NO_CONNECTIONS_ENABLED";
  if (
    lower.includes("not authorized to access resource server") ||
    lower.includes("unauthorized_client")
  )
    return "CLIENT_NOT_AUTHORIZED";
  if (lower.includes("callback") || lower.includes("redirect_uri"))
    return "CALLBACK_MISMATCH";
  if (lower.includes("multiple") && lower.includes("chatgpt"))
    return "MULTIPLE_CHATGPT_CLIENTS";
  if (lower.includes("timed out") && lower.includes("chatgpt"))
    return "CHATGPT_CLIENT_TIMEOUT";
  if (lower.includes("metadata")) return "METADATA_INVALID";
  return "UNKNOWN";
}

export function deriveChatGptLifecycle(
  input: ChatGptLifecycleInput,
): ChatGptLifecycleSnapshot {
  const items = timeline(input);
  const diagnostics = input.diagnostics ?? [];
  const failure = diagnostics.find(
    (diagnostic) => diagnostic.status === "fail" && diagnostic.errorState,
  );
  let state: ChatGptLifecycleState;
  let overall: ChatGptOverallStatus;

  if (failure?.errorState) {
    state = failure.errorState;
    overall =
      failure.errorState === "LOCAL_SERVER_STOPPED" ||
      failure.errorState === "TUNNEL_STOPPED"
        ? "stopped"
        : "needs_attention";
  } else if (!input.receiptExists) {
    state = "UNCONFIGURED";
    overall = "stopped";
  } else if (!input.serverAlive) {
    state = "LOCAL_SERVER_STOPPED";
    overall = "stopped";
  } else if (input.tunnelRequired && !input.tunnelAlive) {
    state = "TUNNEL_STOPPED";
    overall = "stopped";
  } else if (
    input.checks.tokenValidation === "pass" &&
    input.checks.mcpInitialize === "pass"
  ) {
    state = "CONNECTED";
    overall = "connected";
  } else if (input.checks.authorize === "pass") {
    state = "READY_TO_COMPLETE_LOGIN";
    overall = "waiting_for_chatgpt";
  } else if (input.checks.chatgptClient !== "pass") {
    state =
      input.checks.resourceMetadata === "pass"
        ? "WAITING_FOR_CHATGPT_CLIENT"
        : lastPassedStage(items);
    overall = "waiting_for_chatgpt";
  } else {
    state = lastPassedStage(items);
    overall = "needs_attention";
  }

  const actions = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.status === "fail" && diagnostic.repairAction)
      actions.add(diagnostic.repairAction);
  }
  if (state === "WAITING_FOR_CHATGPT_CLIENT")
    actions.add("wait_for_dcr_client");
  if (state === "LOCAL_SERVER_STOPPED") actions.add("start_server");
  if (state === "TUNNEL_STOPPED") actions.add("restart_tunnel");
  actions.add("rerun_verification");

  return {
    state,
    overall,
    timeline: items,
    diagnostics,
    actions: [...actions],
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
}
