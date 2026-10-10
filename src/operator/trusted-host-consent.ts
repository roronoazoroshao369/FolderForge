import { randomBytes, createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { FleetInstance, FleetManager } from '../provisioner/fleet-manager.js';
import { FLEET_POLICY_MODES, FLEET_TOOLS_PRESETS } from '../provisioner/fleet-manager.js';
import { TrustedHostStore } from './trusted-host-store.js';
import { scopeDigest, type ConsentIdentity, type FleetProfileTuple } from './trusted-host-scope.js';

export interface OperatorPrincipal {
  id: string;
  role: string;
}

export interface PendingView {
  status: 'pending' | 'approved';
  requestId: string;
  expiresAt: number;
  instanceId: string;
}

export interface RedactedConsentView {
  status: 'pending' | 'approved' | 'expired' | 'not_requested';
  instanceId: string;
  requestId?: string;
  expiresAt?: number;
}

export interface TrustedHostConsentOptions {
  fleet: Pick<FleetManager, 'get'>;
  store: TrustedHostStore;
  installationId: string;
  serviceUid: number;
  now: () => number;
  isWriteFrozen: () => boolean;
  recordAudit: (event: string) => void;
}

function fleetRevision(record: FleetInstance): string {
  // CAS identity is intentionally distinct from the durable capability digest.
  return createHash('sha256').update(JSON.stringify([
    record.id, record.toolsPreset, record.policyMode, record.terminalExecution,
    record.authMode, record.updatedAt,
  ])).digest('hex');
}

/**
 * Only host-local CLI is allowed to consume pending intents. This class never
 * makes a grant over HTTP and never modifies the process-global sandbox config.
 */
export class TrustedHostConsentService {
  constructor(private readonly deps: TrustedHostConsentOptions) {}

  private identityFor(instanceId: string): ConsentIdentity {
    const record = this.deps.fleet.get(instanceId);
    if (record.authMode === 'none') throw new Error('TRUSTED_HOST_AUTH_REQUIRED');
    const identity: ConsentIdentity = {
      installationId: this.deps.installationId,
      serviceUid: this.deps.serviceUid,
      instanceId: record.id,
      workspaceRealpath: realpathSync(record.projectPath),
      authMode: record.authMode,
      revocationGeneration: 0,
    };
    identity.revocationGeneration = this.deps.store.currentRevocationGeneration(identity);
    return identity;
  }

  private checkOperator(principal: OperatorPrincipal): void {
    if (principal.role !== 'admin' || !principal.id.startsWith('credential:')) {
      throw new Error('HOST_OPERATOR_AUTH_REQUIRED');
    }
  }

  private assertWritable(): void {
    if (this.deps.isWriteFrozen()) throw new Error('WRITE_FREEZE_ACTIVE');
  }

  requestProfile(instanceId: string, tuple: FleetProfileTuple, principal: OperatorPrincipal): PendingView {
    this.checkOperator(principal);
    this.assertWritable();
    if (!(FLEET_TOOLS_PRESETS as readonly string[]).includes(tuple.toolsPreset) ||
        !(FLEET_POLICY_MODES as readonly string[]).includes(tuple.policyMode) ||
        tuple.terminalExecution !== 'trusted-host') {
      throw new Error('INVALID_TRUSTED_HOST_PROFILE');
    }
    const record = this.deps.fleet.get(instanceId);
    const identity = this.identityFor(instanceId);
    const digest = scopeDigest(tuple, identity);
    const approved = this.deps.store.readGrantByScope(digest);
    if (approved && this.deps.store.validateGrant(identity, tuple) &&
        record.toolsPreset === tuple.toolsPreset && record.policyMode === tuple.policyMode &&
        record.terminalExecution === tuple.terminalExecution) {
      return { status: 'approved', requestId: approved.requestId, expiresAt: 0, instanceId };
    }
    const existing = this.deps.store.findPendingByInstance(instanceId);
    if (existing) {
      if (existing.scopeHash !== digest || existing.requestedBy !== principal.id) {
        throw new Error('CONSENT_INTENT_CONFLICT');
      }
      return { status: 'pending', requestId: existing.requestId, expiresAt: existing.expiresAt, instanceId };
    }
    const createdAt = this.deps.now();
    const requestId = `req_${randomBytes(24).toString('base64url')}`;
    this.deps.recordAudit('trusted_host_intent_requested');
    this.deps.store.createPending({
      schemaVersion: 1,
      requestId, instanceId,
      tuple, identity, scopeHash: digest,
      expectedInstanceRevision: fleetRevision(record),
      requestedBy: principal.id,
      createdAt, expiresAt: createdAt + 600_000,
    });
    return { status: 'pending', requestId, expiresAt: createdAt + 600_000, instanceId };
  }

  status(instanceId: string, requestId?: string): RedactedConsentView {
    const record = this.deps.fleet.get(instanceId);
    const identity = this.identityFor(instanceId);
    const requested = requestId
      ? this.deps.store.readIntentRecord(requestId)
      : this.deps.store.findPendingByInstance(instanceId);
    if (requested && requested.instanceId !== instanceId) throw new Error('CONSENT_SCOPE_MISMATCH');
    if (requested && this.deps.store.validateGrant(identity, requested.tuple)) {
      return { status: 'approved', instanceId, requestId: requested.requestId };
    }
    if (requested && !requested.consumedAt && requested.expiresAt > this.deps.now()) {
      return { status: 'pending', instanceId, requestId: requested.requestId, expiresAt: requested.expiresAt };
    }
    if (requested && requested.expiresAt <= this.deps.now()) {
      return { status: 'expired', instanceId, requestId: requested.requestId };
    }
    // Do not guess that persisted Fleet settings mean a live process is elevated.
    void record;
    return { status: 'not_requested', instanceId };
  }

  cancelPending(instanceId: string, requestId: string, principal: OperatorPrincipal): void {
    this.checkOperator(principal);
    this.assertWritable();
    const pending = this.deps.store.readPending(requestId);
    if (!pending || pending.instanceId !== instanceId || pending.requestedBy !== principal.id) {
      throw new Error('CONSENT_REQUEST_UNAVAILABLE');
    }
    this.deps.recordAudit('trusted_host_intent_cancelled');
    this.deps.store.cancelPending(requestId);
  }

  assertAuthorized(instanceId: string, tuple: FleetProfileTuple): void {
    const identity = this.identityFor(instanceId);
    if (!this.deps.store.validateGrant(identity, tuple)) throw new Error('TRUSTED_HOST_CONSENT_REQUIRED');
  }

  assertAuthorizedForIntent(instanceId: string, tuple: FleetProfileTuple, requestId: string): void {
    this.assertWritable();
    this.assertAuthorized(instanceId, tuple);
    const intent = this.deps.store.readIntentRecord(requestId);
    const instance = this.deps.fleet.get(instanceId);
    const identity = this.identityFor(instanceId);
    if (!intent || intent.instanceId !== instanceId || intent.scopeHash !== scopeDigest(tuple, identity)) {
      throw new Error('CONSENT_SCOPE_MISMATCH');
    }
    if (intent.expectedInstanceRevision !== fleetRevision(instance)) {
      throw new Error('CONSENT_STALE_REVISION');
    }
  }

  revokeFromLocal(instanceId: string): void {
    this.deps.recordAudit('trusted_host_grant_revoked');
    this.deps.store.revoke(this.identityFor(instanceId));
  }
}
