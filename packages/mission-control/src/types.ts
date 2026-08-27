/* Shared data shapes mirroring the governed dashboard API. */

export interface FleetInstance {
  id: string;
  name: string;
  projectPath: string;
  port: number;
  toolsPreset: string;
  policyMode: string;
  state: string;
  autoRestart?: boolean;
  lastError?: string;
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
  presets?: Record<string, { groups: string[]; toolCount: number }>;
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
