/**
 * Core type definitions shared across FolderForge.
 */

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type PolicyMode = "readonly" | "safe" | "dev" | "danger";

export type AuditDurability = "required" | "best-effort";

export interface AuditConfig {
  /** Baseline durability for audit events that are not otherwise elevated. */
  durability: AuditDurability;
  /** Force durable audit writes for HIGH and CRITICAL operations. */
  requireForHighRisk: boolean;
  /** Force durable audit writes for token- or OAuth-authenticated HTTP callers. */
  requireForAuthenticatedHttp: boolean;
}

export type ToolAudience = "agent" | "admin";

export type HttpAuthMode = "none" | "token" | "oauth";
export type OAuthClientRegistrationStrategy = "cimd" | "dcr" | "predefined";

export interface OAuthHttpAuthConfig {
  /** Canonical public MCP resource URI, normally the public `/mcp` URL. */
  resource: string;
  /** Trusted external authorization-server issuer. */
  issuer: string;
  /** Minimal scopes advertised by protected-resource metadata. */
  scopes: string[];
  /** Scope required to list/call non-mutating tools. */
  readScope: string;
  /** Additional scope required before any mutating tool executes. */
  writeScope: string;
  /** ChatGPT client identification strategy expected from the external IdP. */
  clientRegistration: OAuthClientRegistrationStrategy;
  /** Optional trusted JWKS URI override. */
  jwksUri?: string;
  /** Additional exact JWKS host[:port] values trusted for cross-origin discovery. */
  trustedJwksHosts?: string[];
  /** Asymmetric JWT algorithms accepted by the resource server. */
  algorithms?: string[];
  /** Allowed JWT clock skew in seconds. */
  clockToleranceSeconds?: number;
  /** Discovery/JWKS request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Remote JWKS cache lifetime in milliseconds. */
  jwksCacheTtlMs?: number;
  /** Minimum delay before retrying JWKS after an unknown key id. */
  jwksCooldownMs?: number;
  /**
   * Development-only escape hatch. HTTP is accepted only when both issuer and
   * resource are loopback URLs. Production OAuth always requires HTTPS.
   */
  allowInsecureHttpForDevelopment?: boolean;
  /** Optional public documentation URL included in RFC 9728 metadata. */
  resourceDocumentation?: string;
}

export interface HttpAuthConfig {
  mode: HttpAuthMode;
  oauth?: OAuthHttpAuthConfig;
}

export interface ToolPrincipal {
  id: string;
  role: "agent" | "admin" | "system";
  /** Optional fine-grained RBAC roles in addition to the coarse control-plane role. */
  roles?: string[];
  /** Optional organization boundary supplied by trusted auth claims or local context. */
  organizationId?: string;
  /** Optional verified team/group memberships for fine-grained RBAC. */
  teamIds?: string[];
  /** Stable hash-derived project identity for policy and audit correlation. */
  projectId?: string;
  /** Connection/session identity; never used as the sole authentication factor. */
  sessionId?: string;
  authMode?: HttpAuthMode | "stdio";
  /** OAuth scopes only; static token principals intentionally remain unscoped. */
  scopes?: string[];
  /** OAuth client identifier used for lifecycle correlation; never a client secret. */
  oauthClientId?: string;
  /** Challenge context used for tool-level OAuth step-up responses. */
  resourceMetadataUrl?: string;
  readScope?: string;
  writeScope?: string;
}

export interface ServerConfig {
  name: string;
  transport: "stdio" | "http";
  http: {
    host: string;
    port: number;
    /**
     * Bearer token required on the MCP HTTP endpoint. When unset, a token is
     * auto-generated for non-loopback binds (and logged once), matching the
     * dashboard behaviour. Loopback binds are open by default.
     */
    token?: string;
    /**
     * Additional API keys accepted alongside `token`. Each may be presented by
     * a client as `Authorization: Bearer <key>` OR as the `X-API-Key: <key>`
     * header. Lets several clients authenticate with distinct credentials.
     */
    apiKeys?: string[];
    /**
     * Force authentication even on loopback binds. When true, a token/api key
     * MUST be configured and every request must present a valid credential -
     * including localhost. Default false (loopback is open unless a token is
     * set).
     */
    requireAuth?: boolean;
    /**
     * Allowed CORS origins for the HTTP transport. Use ['*'] to allow any
     * origin (not recommended for non-loopback binds). Empty disables CORS
     * headers entirely.
     */
    corsOrigins?: string[];
    /** Idle session lifetime in ms before an HTTP MCP session is expired. */
    sessionTtlMs?: number;
    /** Explicit HTTP authentication mode. Omit to preserve legacy auto behaviour. */
    auth?: HttpAuthConfig;
  };
  dashboard: {
    /** Whether the local dashboard is started by default. */
    enabled: boolean;
    host: string;
    port: number;
    /**
     * Bearer token required for dashboard requests. When unset, a token is
     * auto-generated at startup for non-loopback binds (and logged once).
     * Ignored for loopback hosts, where the dashboard is open by default.
     */
    token?: string;
  };
}

export interface WorkspaceConfig {
  defaultProject: string;
  allowedDirectories: string[];
  deniedGlobs: string[];
}

export interface PolicyConfig {
  defaultMode: PolicyMode;
  requireApproval: string[];
  blockedCommands: string[];
  /** Lifetime of a pending approval before it expires. */
  approvalTtlMs: number;
  /** Explicit autonomous-agent escape hatch for isolated environments. */
  allowCriticalInDanger: boolean;
  /** Additional project-relative policy files or directories. */
  files?: string[];
}

export interface TerminalConfig {
  shell: string;
  defaultTimeoutMs: number;
  maxOutputBytes: number;
  envPolicy: "redact" | "passthrough";
}

export interface GitConfig {
  allowCommit: "approval" | "allow" | "deny";
  allowPush: "approval" | "allow" | "deny";
  allowResetHard: boolean;
}

/**
 * Per-tool rate limiting and quotas. A sliding window of `windowMs` bounds how
 * many times a tool may run (`maxCalls`); `dailyQuota` caps total calls per
 * 24h. `overrides` lets a specific tool relax or tighten the defaults. Set
 * `enabled: false` to disable enforcement entirely.
 */
export interface RateLimitRule {
  maxCalls: number;
  windowMs: number;
  dailyQuota?: number;
}

export interface RateLimitConfig {
  enabled: boolean;
  default: RateLimitRule;
  overrides: Record<string, RateLimitRule>;
}

/**
 * Secret-scanning configuration. Beyond the built-in regex rules, an
 * entropy-based detector can flag high-entropy tokens that don't match a known
 * pattern (e.g. bespoke API keys). `minEntropy` is bits/char (Shannon) and
 * `minLength` is the shortest token considered.
 */
export interface SecretScanConfig {
  entropyEnabled: boolean;
  minEntropy: number;
  minLength: number;
}

export type ChildSandboxMode = 'process' | 'docker' | 'podman';

export interface ChildSandboxMount {
  /** Absolute host path exposed to the container runtime. */
  source: string;
  /** Absolute POSIX path inside the container. */
  target: string;
  mode: 'ro' | 'rw';
}

export interface ChildSandboxConfig {
  mode: ChildSandboxMode;
  /** Pre-existing image; container backends never pull automatically. */
  image?: string;
  /** Command executed inside the container. Required for docker/podman. */
  command?: string;
  /** Arguments executed inside the container. */
  args?: string[];
  workdir?: string;
  network?: 'none' | 'bridge';
  mounts?: ChildSandboxMount[];
  readOnlyRoot?: boolean;
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
  tmpfsMb?: number;
  /** Require image@sha256:... pinning. Defaults true. */
  requireImageDigest?: boolean;
}

export interface AdapterDef {
  enabled: boolean;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Child process working directory. */
  cwd?: string;
  /** Whether to inherit the parent environment (defaults to true for built-ins). */
  inheritEnv?: boolean;
  /** Optional OS/container isolation for this child MCP runtime. */
  sandbox?: ChildSandboxConfig;
  /**
   * Facade mode. When true, this adapter is exposed through a two-tool facade
   * (`<adapter>__list_tools` + `<adapter>__call_tool`) instead of re-exporting
   * every child tool as a flat `<adapter>__<tool>` entry. Intended for large
   * child MCP servers (100+ tools) that would otherwise blow the client tool
   * cap. Sub-ops are still governed per call, keyed as
   * `<adapter>__call_tool:<subtool>`. Defaults to false (flat namespacing).
   * See docs/mcp-facade.md.
   */
  facade?: boolean;
}

export interface AdaptersConfig {
  serena?: AdapterDef;
  playwright?: AdapterDef;
  desktopCommander?: AdapterDef;
  godot?: GodotConfig;
}

/**
 * Godot game-engine adapter configuration (the `game_*` tool group).
 *
 * Unlike the child-MCP adapters, Godot is not an MCP server: FolderForge talks
 * to it over three channels - a headless CLI runner (`godot --headless`), a
 * WebSocket editor addon, and a TCP runtime autoload bridge. Step 1 only uses
 * the CLI/file-read tier, so only `godotPath` is required; `editorPort` /
 * `runtimePort` are reserved for the later runtime/editor tiers. A missing
 * `godot` binary degrades gracefully: file-based reads still work (they parse
 * project files directly) and engine-only ops return a clear, actionable error.
 */
export interface GodotConfig {
  enabled: boolean;
  /** Path to the Godot 4.x binary, or a bare name resolved on PATH. */
  godotPath: string;
  /** WebSocket port for the editor addon (EDIT channel; later tiers). */
  editorPort: number;
  /** TCP port for the runtime autoload bridge (RUN channel; later tiers). */
  runtimePort: number;
}

/**
 * A language-server definition for the native LSP proxy (Gap 1). Commands are
 * looked up on PATH at spawn time; a missing binary degrades gracefully to the
 * Serena adapter or regex fallback.
 */
export interface LanguageServerDef {
  id: string;
  command: string;
  args: string[];
  extensions: string[];
  languageId: string;
}

/**
 * Native LSP proxy configuration. When enabled, FolderForge spawns the
 * project's language server(s) and speaks JSON-RPC LSP directly, instead of
 * relying on the Serena child-MCP. `servers` overrides/extends the built-in
 * TypeScript + Python table.
 */
export interface LspConfig {
  enabled: boolean;
  requestTimeoutMs: number;
  servers?: LanguageServerDef[];
}

export interface ToolsConfig {
  preset?: string;
  groups?: string[];
  enable?: string[];
  disable?: string[];
}

export interface FolderForgeConfig {
  server: ServerConfig;
  workspace: WorkspaceConfig;
  policy: PolicyConfig;
  audit: AuditConfig;
  terminal: TerminalConfig;
  git: GitConfig;
  rateLimit: RateLimitConfig;
  secretScan: SecretScanConfig;
  adapters: AdaptersConfig;
  tools?: ToolsConfig;
  lsp: LspConfig;
}

/**
 * MCP tool annotations (spec: ToolAnnotations). These are *hints* for clients
 * and must never be relied on for security decisions. FolderForge derives them
 * deterministically from the existing `mutates` / `risk` contract (see
 * `deriveAnnotations` in tools/registry.ts), so they add zero new surface to
 * the schema lock.
 */
export interface ToolAnnotations {
  /** Human-friendly title for display. */
  title?: string;
  /** True when the tool does not modify its environment (`mutates === false`). */
  readOnlyHint?: boolean;
  /** True when the tool may perform irreversible/destructive updates (risk HIGH+). */
  destructiveHint?: boolean;
  /** True when calling repeatedly with the same args has no additional effect. */
  idempotentHint?: boolean;
  /** True when the tool interacts with entities outside the local workspace. */
  openWorldHint?: boolean;
}

export interface ToolCallClassification {
  /** Effective policy/audit/rate-limit identity for this invocation. */
  name: string;
  /** Effective risk after inspecting the concrete call arguments. */
  risk: RiskLevel;
  /** Effective mutation flag after inspecting the concrete call arguments. */
  mutates: boolean;
  /**
   * Arguments bound to approvals and shown in bounded audit summaries. Defaults
   * to the public tool arguments. Dispatchers may narrow this to the selected
   * sub-tool's arguments while their handler still receives the full envelope.
   */
  governanceArgs?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Optional JSON-Schema describing the shape of a successful `data` payload.
   * When present it is advertised to clients (MCP `outputSchema`) and the
   * structured payload is mirrored into `structuredContent`.
   */
  outputSchema?: Record<string, unknown>;
  /** Optional MCP tool annotations (hints only). */
  annotations?: ToolAnnotations;
  risk: RiskLevel;
  group: string;
  /** Which control plane may invoke the tool. Defaults to agent. */
  audience: ToolAudience;
  /** Whether the tool mutates state; used by readonly mode. */
  mutates: boolean;
  /**
   * Optional per-call classifier for dispatcher-style tools. It runs before
   * OAuth scope checks and before the governance pipeline, allowing one public
   * tool to adopt the selected operation's real identity, risk, mutation flag,
   * and approval arguments without nesting a second pipeline.
   */
  classifyCall?: (args: Record<string, unknown>) => ToolCallClassification;
  handler: ToolHandler;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult>;

/**
 * Parameters for an elicitation request (MCP `elicitation/create`, 2025-06-18).
 * A handler asks the connected client for structured input mid-call; the
 * client renders UI and returns one of accept / decline / cancel.
 */
export interface ElicitRequestParams {
  /** Human-readable prompt shown to the user. */
  message: string;
  /** JSON-Schema (flat object of primitives) describing the requested input. */
  requestedSchema: Record<string, unknown>;
}

export interface ElicitResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

/**
 * Per-call protocol controls injected by the server request layer
 * (see server/mcp-server.ts). Every field is optional so tool handlers and
 * tests that don't need protocol features can omit it entirely. Wiring these
 * here keeps the frozen tool input/output schemas untouched.
 *
 *  - P4 progress:     {@link reportProgress} (present only when the client sent
 *                     a progressToken in the request _meta).
 *  - P6 cancellation: {@link signal} (aborted on notifications/cancelled).
 *  - P8 elicitation:  {@link elicitInput} (present only when the client
 *                     advertised the `elicitation` capability).
 */
export interface ToolCallControl {
  /** Authenticated caller identity supplied by the transport/admin plane. */
  principal?: ToolPrincipal;
  /** Abort signal that fires when the client cancels this tool call. */
  signal?: AbortSignal;
  /** Emit an incremental progress notification for this call. */
  reportProgress?: (
    progress: number,
    total?: number,
    message?: string,
  ) => Promise<void>;
  /** Request structured input from the client mid-call. */
  elicitInput?: (params: ElicitRequestParams) => Promise<ElicitResult>;
}

/**
 * A rich content block a tool can return for the client to render directly in
 * its UI (MCP `tools/call` content items). Beyond plain text, FolderForge tools
 * can attach embedded resources (an inline diff, a file preview) or resource
 * links (a pointer the client can open in a viewer/tab). The server layer maps
 * these onto MCP content blocks in `toCallToolResult`.
 */
export type ToolContentBlock =
  | { kind: "text"; text: string }
  | {
      /** Base64-encoded image content rendered directly by vision-capable clients. */
      kind: "image";
      data: string;
      mimeType: string;
    }
  | {
      /** Inline resource the client renders in place (diff, file preview, log). */
      kind: "resource";
      uri: string;
      title?: string;
      mimeType?: string;
      text: string;
    }
  | {
      /** A link the client can open (e.g. a file, a localhost URL, a tab). */
      kind: "resource_link";
      uri: string;
      name?: string;
      title?: string;
      description?: string;
      mimeType?: string;
    };

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  diff?: string;
  approvalId?: string;
  /**
   * Optional rich content blocks (embedded resources / links) the client should
   * render alongside the structured result. Plain handlers omit this; handlers
   * that produce viewable artifacts (diffs, file previews, dashboards) attach
   * them here. Mapped onto MCP content blocks by the server layer.
   */
  content?: ToolContentBlock[];
}

export interface ToolRoutingRegistry {
  setActive(names: readonly string[] | null): void;
  listAgentActive(): ToolDefinition[];
  listAll(): ToolDefinition[];
}

export interface ToolContext {
  config: FolderForgeConfig;
  projectRoot: string;
  /**
   * Per-call protocol controls (progress / cancellation / elicitation). May be
   * absent for internal or test invocations; handlers must treat every member
   * as optional and degrade gracefully when it is missing.
   */
  control?: ToolCallControl;
  // Filled in by the runtime container; circular at type level so kept loose.

  container: any;
}
