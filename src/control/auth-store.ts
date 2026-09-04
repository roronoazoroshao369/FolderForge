/**
 * Mission Control control-plane credential store.
 *
 * Persisted at <projectRoot>/.folderforge/control-auth.json with 0600
 * permissions, mirroring the Cloudflare account store. The credential is a
 * secret: it never enters process argv (visible via `ps`), never lands in
 * control.json (the state file records only the auth mode), is never
 * audit-logged, and the path is covered by DEFAULT_DENIED_GLOBS so agent file
 * tools cannot read it. The credential is printed to the operator only as part
 * of the signed dynamic link (`/app?token=…`) at start / `control open`.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const CONTROL_AUTH_MODES = ['none', 'token', 'api-key'] as const;
export type ControlAuthMode = (typeof CONTROL_AUTH_MODES)[number];
export type ControlAuthCredentialMode = Exclude<ControlAuthMode, 'none'>;

export interface ControlAuthConfig {
  mode: ControlAuthCredentialMode;
  credential: string;
  createdAt: string;
}

export interface ControlAuthMasked {
  configured: boolean;
  mode?: ControlAuthCredentialMode;
  credentialPreview?: string;
  createdAt?: string;
}

export function controlAuthPath(projectRoot: string): string {
  return join(projectRoot, '.folderforge', 'control-auth.json');
}

/** 192-bit URL-safe credential for the dashboard bearer/x-api-key check. */
export function generateControlCredential(): string {
  return randomBytes(24).toString('base64url');
}

export function saveControlAuth(
  projectRoot: string,
  config: ControlAuthConfig,
): void {
  const dir = join(projectRoot, '.folderforge');
  mkdirSync(dir, { recursive: true });
  const file = controlAuthPath(projectRoot);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  chmodSync(file, 0o600);
}

export function loadControlAuth(projectRoot: string): ControlAuthConfig | null {
  const file = controlAuthPath(projectRoot);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ControlAuthConfig>;
    if (
      (raw.mode !== 'token' && raw.mode !== 'api-key') ||
      typeof raw.credential !== 'string' ||
      raw.credential.length === 0
    ) {
      return null;
    }
    return {
      mode: raw.mode,
      credential: raw.credential,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    };
  } catch {
    return null;
  }
}

export function clearControlAuth(projectRoot: string): void {
  rmSync(controlAuthPath(projectRoot), { force: true });
}

/** Status-safe view: never returns the credential itself. */
export function maskedControlAuth(projectRoot: string): ControlAuthMasked {
  const config = loadControlAuth(projectRoot);
  if (!config) return { configured: false };
  return {
    configured: true,
    mode: config.mode,
    credentialPreview: `…${config.credential.slice(-4)}`,
    createdAt: config.createdAt,
  };
}
