import { createHash } from 'node:crypto';
import type { ToolPrincipal } from './types.js';

export const STDIO_AGENT_PRINCIPAL: ToolPrincipal = {
  id: 'local:stdio-agent',
  role: 'agent',
  authMode: 'stdio',
};

export const LOOPBACK_HTTP_AGENT_PRINCIPAL: ToolPrincipal = {
  id: 'local:http-agent',
  role: 'agent',
  authMode: 'none',
};

export const LOOPBACK_DASHBOARD_ADMIN_PRINCIPAL: ToolPrincipal = {
  id: 'local:dashboard-admin',
  role: 'admin',
};

export function credentialPrincipalId(credential: string): string {
  return `credential:${createHash('sha256').update(credential).digest('hex').slice(0, 24)}`;
}

export function agentPrincipalFromCredential(credential?: string): ToolPrincipal {
  return credential
    ? { id: credentialPrincipalId(credential), role: 'agent', authMode: 'token' }
    : LOOPBACK_HTTP_AGENT_PRINCIPAL;
}

export function adminPrincipalFromCredential(credential?: string): ToolPrincipal {
  return credential
    ? { id: credentialPrincipalId(credential), role: 'admin' }
    : LOOPBACK_DASHBOARD_ADMIN_PRINCIPAL;
}
