/**
 * Core type definitions shared across FolderForge.
 */

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type PolicyMode = 'readonly' | 'safe' | 'dev' | 'danger';

export interface ServerConfig {
  name: string;
  transport: 'stdio' | 'http';
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
  };
  dashboard: {
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
}

export interface TerminalConfig {
  shell: string;
  defaultTimeoutMs: number;
  maxOutputBytes: number;
  envPolicy: 'redact' | 'passthrough';
}

export interface GitConfig {
  allowCommit: 'approval' | 'allow' | 'deny';
  allowPush: 'approval' | 'allow' | 'deny';
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

export interface AdapterDef {
  enabled: boolean;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AdaptersConfig {
  serena?: AdapterDef;
  playwright?: AdapterDef;
  desktopCommander?: AdapterDef;
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

export interface FolderForgeConfig {
  server: ServerConfig;
  workspace: WorkspaceConfig;
  policy: PolicyConfig;
  terminal: TerminalConfig;
  git: GitConfig;
  rateLimit: RateLimitConfig;
  secretScan: SecretScanConfig;
  adapters: AdaptersConfig;
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
  /** Whether the tool mutates state; used by readonly mode. */
  mutates: boolean;
  handler: ToolHandler;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext
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
  action: 'accept' | 'decline' | 'cancel';
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
  /** Abort signal that fires when the client cancels this tool call. */
  signal?: AbortSignal;
  /** Emit an incremental progress notification for this call. */
  reportProgress?: (
    progress: number,
    total?: number,
    message?: string
  ) => Promise<void>;
  /** Request structured input from the client mid-call. */
  elicitInput?: (params: ElicitRequestParams) => Promise<ElicitResult>;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  diff?: string;
  approvalId?: string;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  container: any;
}
