/* Shared data shapes mirroring the governed dashboard API. */

export type FleetAuthMode = 'none' | 'token' | 'api-key' | 'oauth';

export interface FleetOAuthConfig {
  resource: string;
  issuer: string;
  scopes: string[];
  readScope: string;
  writeScope: string;
  clientRegistration?: 'cimd' | 'dcr' | 'predefined';
}

export interface FleetInstance {
  id: string;
  name: string;
  projectPath: string;
  port: number;
  toolsPreset: string;
  policyMode: string;
  authMode: FleetAuthMode;
  oauth?: FleetOAuthConfig;
  openAiTunnel?: {
    tunnelId: string;
    apiKeyEnv: string;
    oauth: boolean;
    state: string;
    lastError?: string;
  };
  state: string;
  autoRestart?: boolean;
  lastError?: string;
  /** Live child pid while running (never persisted across restarts). */
  pid?: number;
  /** Per-start lease identity (fencing) while running. */
  leaseId?: string;
}

export interface TunnelRecord {
  id: string;
  kind?: 'quick' | 'named';
  targetPort: number;
  targetUrl: string;
  publicUrl?: string;
  hostname?: string;
  state: string;
  lastError?: string;
}

/** Response shape of GET /openai-tunnel/status (no secret values, env-var NAME only). */
export interface OpenAiTunnelStatus {
  configured: boolean;
  tunnelId?: string;
  apiKeyEnv?: string;
  linkedAt?: string;
  running?: boolean;
  supervisorPid?: number;
  apiKeyPresent?: boolean;
  /** True when the operator pasted the key itself (stored 0600). */
  apiKeyStored?: boolean;
  /** Last-4 preview of a stored key, e.g. "…cret". */
  keyPreview?: string;
}

/** Response shape of GET /cloudflare/status (token is never returned). */
export interface CloudflareStatus {
  configured: boolean;
  accountId?: string;
  zoneId?: string;
  domain?: string;
  tokenPreview?: string;
  linkedAt?: string;
}

export interface WorkspaceRecord {
  projectRoot?: string;
  path?: string;
  root?: string;
  current?: boolean;
  active?: boolean;
  isCurrent?: boolean;
}

export interface PluginRecord {
  id: string;
  version?: string;
  enabled?: boolean;
}

export interface MarketplaceEntry {
  id?: string;
  name?: string;
  publisher?: string;
  version?: string;
}

export interface ApprovalRecord {
  id: string;
  tool?: string;
  toolName?: string;
  risk?: string;
  status?: string;
  summary?: string;
  reason?: string;
}

export interface AuditRecord {
  timestamp?: string;
  time?: string;
  type?: string;
  summary?: string;
  status?: string;
  risk?: string;
}

export interface ToolRecord {
  name: string;
  group: string;
  risk: string;
  mutates: boolean;
  title?: string;
  description?: string;
}

export interface ToolsCatalog {
  tools?: ToolRecord[];
  presets?: Record<string, { groups: string[]; toolCount: number; note?: string }>;
}

export interface StatusSnapshot {
  policy?: { mode?: string };
  workspace?: { projectRoot?: string; allowedDirectories?: string[]; browsePoint?: string };
  server?: { version?: string };
}

/** Response shape of POST /fs/browse. */
export interface BrowseResult {
  path: string;
  parent: string;
  canGoUp: boolean;
  home: string;
  root: string;
  directories: Array<{ name: string; path: string }>;
}
