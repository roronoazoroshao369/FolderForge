import { createHash } from 'node:crypto';
import { isAbsolute, normalize, sep } from 'node:path';

export interface FleetProfileTuple {
  toolsPreset: string;
  policyMode: string;
  terminalExecution: 'sandbox-required' | 'trusted-host';
}

export interface ConsentIdentity {
  installationId: string;
  serviceUid: number;
  instanceId: string;
  workspaceRealpath: string;
  authMode: 'token' | 'api-key' | 'oauth' | 'none';
  revocationGeneration: number;
}

/** The digest excludes volatile Fleet revision; the pending intent CAS tracks that independently. */
export function scopeDigest(tuple: FleetProfileTuple, identity: ConsentIdentity): string {
  if (identity.authMode === 'none') throw new Error('TRUSTED_HOST_AUTH_REQUIRED');
  if (!identity.installationId || !identity.instanceId || !identity.workspaceRealpath ||
      !Number.isSafeInteger(identity.serviceUid) || identity.serviceUid < 0 ||
      !Number.isSafeInteger(identity.revocationGeneration) || identity.revocationGeneration < 0 ||
      !isAbsolute(identity.workspaceRealpath) ||
      normalize(identity.workspaceRealpath) !== identity.workspaceRealpath ||
      identity.workspaceRealpath.split(sep).includes('..') ||
      !tuple.toolsPreset || !tuple.policyMode ||
      !['sandbox-required', 'trusted-host'].includes(tuple.terminalExecution)) {
    throw new Error('INVALID_TRUSTED_HOST_SCOPE');
  }
  // Explicit ordered fields avoid JS object insertion order altering a capability identity.
  return createHash('sha256').update(JSON.stringify([
    'folderforge-trusted-host-scope-v1',
    identity.installationId, identity.serviceUid, identity.instanceId,
    identity.workspaceRealpath, identity.authMode, identity.revocationGeneration,
    tuple.toolsPreset, tuple.policyMode, tuple.terminalExecution,
  ])).digest('hex');
}
