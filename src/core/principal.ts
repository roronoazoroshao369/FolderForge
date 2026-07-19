import { createHash, randomUUID } from 'node:crypto';
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

export function projectPrincipalId(projectRoot: string): string {
  return `project:${createHash('sha256').update(projectRoot).digest('hex').slice(0, 24)}`;
}

export function scopedSessionId(principalId: string, hint?: string): string {
  const material = JSON.stringify([principalId, hint?.trim() || randomUUID()]);
  return `session:${createHash('sha256').update(material).digest('hex').slice(0, 24)}`;
}

/** Add project/session/RBAC context without weakening the authenticated identity. */
export function withExecutionContext(
  principal: ToolPrincipal,
  projectRoot: string,
  sessionHint?: string,
): ToolPrincipal {
  return {
    ...principal,
    roles: principal.roles?.length ? [...new Set(principal.roles)] : [principal.role],
    organizationId: principal.organizationId ?? 'organization:local',
    teamIds: principal.teamIds?.length ? [...new Set(principal.teamIds)] : ['team:local'],
    projectId: principal.projectId ?? projectPrincipalId(projectRoot),
    sessionId: principal.sessionId ?? scopedSessionId(principal.id, sessionHint),
  };
}
