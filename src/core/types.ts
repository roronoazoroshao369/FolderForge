/**
 * Core type definitions shared across FolderForge (VibeMCP).
 */

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type PolicyMode = 'readonly' | 'safe' | 'dev' | 'danger';

export interface ServerConfig {
  name: string;
  transport: 'stdio' | 'http';
  http: {
    host: string;
    port: number;
  };
  dashboard: {
    host: string;
    port: number;
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

export interface FolderForgeConfig {
  server: ServerConfig;
  workspace: WorkspaceConfig;
  policy: PolicyConfig;
  terminal: TerminalConfig;
  git: GitConfig;
  adapters: AdaptersConfig;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
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
  // Filled in by the runtime container; circular at type level so kept loose.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  container: any;
}
