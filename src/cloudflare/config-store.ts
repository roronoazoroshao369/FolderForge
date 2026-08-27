/**
 * Cloudflare account link storage (ADR-0012, Phase 4).
 *
 * Persisted at <projectRoot>/.folderforge/cloudflare.json with 0600
 * permissions. The API token is a secret: it is never audit-logged, never
 * returned by status reads (only a last-4 preview), and the file stays out of
 * any MCP-exposed path by living in the dot-dir alongside control.json.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CloudflareConfig {
  accountId: string;
  zoneId: string;
  domain: string;
  apiToken: string;
  linkedAt: string;
}

export interface CloudflareConfigMasked {
  configured: boolean;
  accountId?: string;
  zoneId?: string;
  domain?: string;
  tokenPreview?: string;
  linkedAt?: string;
}

export function cloudflareConfigPath(projectRoot: string): string {
  return join(projectRoot, '.folderforge', 'cloudflare.json');
}

export function saveCloudflareConfig(projectRoot: string, config: CloudflareConfig): void {
  const dir = join(projectRoot, '.folderforge');
  mkdirSync(dir, { recursive: true });
  const file = cloudflareConfigPath(projectRoot);
  writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
  chmodSync(file, 0o600);
}

export function loadCloudflareConfig(projectRoot: string): CloudflareConfig | null {
  const file = cloudflareConfigPath(projectRoot);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<CloudflareConfig>;
    if (
      typeof raw.accountId !== 'string' ||
      typeof raw.zoneId !== 'string' ||
      typeof raw.domain !== 'string' ||
      typeof raw.apiToken !== 'string'
    ) {
      return null;
    }
    return {
      accountId: raw.accountId,
      zoneId: raw.zoneId,
      domain: raw.domain,
      apiToken: raw.apiToken,
      linkedAt: typeof raw.linkedAt === 'string' ? raw.linkedAt : '',
    };
  } catch {
    return null;
  }
}

export function clearCloudflareConfig(projectRoot: string): void {
  rmSync(cloudflareConfigPath(projectRoot), { force: true });
}

export function maskedCloudflareConfig(projectRoot: string): CloudflareConfigMasked {
  const config = loadCloudflareConfig(projectRoot);
  if (!config) return { configured: false };
  return {
    configured: true,
    accountId: config.accountId,
    zoneId: config.zoneId,
    domain: config.domain,
    tokenPreview: `\u2026${config.apiToken.slice(-4)}`,
    linkedAt: config.linkedAt,
  };
}
