/**
 * Control-plane OpenAI Secure MCP Tunnel configuration store.
 *
 * Persisted at <projectRoot>/.folderforge/openai-tunnel-config.json with 0600
 * permissions, mirroring the Cloudflare account store. The record holds the
 * tunnel id, the NAME of the environment variable carrying the OpenAI
 * control-plane API key, and OPTIONALLY the key value itself (operator-pasted
 * in Mission Control — stored like the Cloudflare API token: 0600, denied to
 * agent file tools, never returned by the API), plus the supervisor pid while
 * the tunnel is running, so Mission Control and `folderforge control` share a
 * single runtime view. The path is covered by DEFAULT_DENIED_GLOBS.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface OpenAiTunnelConfig {
  tunnelId: string;
  apiKeyEnv: string;
  linkedAt: string;
  /**
   * Optional operator-pasted key value (0600 file, never echoed by the API).
   * When set it wins over the environment at supervisor spawn time only when
   * the referenced env var is absent.
   */
  apiKey?: string;
  /** Detached tunnel supervisor pid while running (app- or CLI-managed). */
  supervisorPid?: number;
}

export function openAiTunnelConfigPath(projectRoot: string): string {
  return join(projectRoot, '.folderforge', 'openai-tunnel-config.json');
}

export function loadOpenAiTunnelConfig(projectRoot: string): OpenAiTunnelConfig | null {
  const file = openAiTunnelConfigPath(projectRoot);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<OpenAiTunnelConfig>;
    if (typeof raw.tunnelId !== 'string' || typeof raw.apiKeyEnv !== 'string') return null;
    return {
      tunnelId: raw.tunnelId,
      apiKeyEnv: raw.apiKeyEnv,
      linkedAt: typeof raw.linkedAt === 'string' ? raw.linkedAt : '',
      ...(typeof raw.apiKey === 'string' && raw.apiKey ? { apiKey: raw.apiKey } : {}),
      ...(typeof raw.supervisorPid === 'number' ? { supervisorPid: raw.supervisorPid } : {}),
    };
  } catch {
    return null;
  }
}

export function saveOpenAiTunnelConfig(
  projectRoot: string,
  config: OpenAiTunnelConfig,
): void {
  const dir = join(projectRoot, '.folderforge');
  mkdirSync(dir, { recursive: true });
  const file = openAiTunnelConfigPath(projectRoot);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  chmodSync(file, 0o600);
}

/**
 * Insert or update tunnel id/env name (and optionally the pasted key value),
 * preserving linkedAt, supervisorPid, and a previously stored key when no new
 * key is supplied.
 */
export function upsertOpenAiTunnelConfig(
  projectRoot: string,
  patch: { tunnelId: string; apiKeyEnv: string; apiKey?: string },
): OpenAiTunnelConfig {
  const existing = loadOpenAiTunnelConfig(projectRoot);
  const next: OpenAiTunnelConfig = {
    tunnelId: patch.tunnelId,
    apiKeyEnv: patch.apiKeyEnv,
    linkedAt: existing?.linkedAt || new Date().toISOString(),
    ...(patch.apiKey ?? existing?.apiKey ? { apiKey: patch.apiKey ?? existing!.apiKey! } : {}),
    ...(existing?.supervisorPid !== undefined
      ? { supervisorPid: existing.supervisorPid }
      : {}),
  };
  saveOpenAiTunnelConfig(projectRoot, next);
  return next;
}

/** Record/clear the running supervisor pid (no-op when no config exists). */
export function setOpenAiTunnelSupervisorPid(projectRoot: string, pid?: number): void {
  const existing = loadOpenAiTunnelConfig(projectRoot);
  if (!existing) return;
  const next: OpenAiTunnelConfig = { ...existing };
  if (pid === undefined) delete next.supervisorPid;
  else next.supervisorPid = pid;
  saveOpenAiTunnelConfig(projectRoot, next);
}

/** Display-only preview of a stored key, e.g. "…cret" — never the full value. */
export function maskedOpenAiTunnelKeyPreview(config: OpenAiTunnelConfig): string | undefined {
  if (!config.apiKey) return undefined;
  return `…${config.apiKey.slice(-4)}`;
}

export function clearOpenAiTunnelConfig(projectRoot: string): void {
  rmSync(openAiTunnelConfigPath(projectRoot), { force: true });
}
