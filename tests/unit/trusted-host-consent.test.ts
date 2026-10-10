import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FleetManager } from '../../src/provisioner/fleet-manager.js';
import { defaultConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { TrustedHostStore } from '../../src/operator/trusted-host-store.js';
import { TrustedHostConsentService } from '../../src/operator/trusted-host-consent.js';
import type { FleetProfileTuple } from '../../src/operator/trusted-host-scope.js';

const tuple: FleetProfileTuple = { toolsPreset: 'full', policyMode: 'danger', terminalExecution: 'trusted-host' };
const acceptedAdmin = { id: 'credential:operator-1', role: 'admin' as const };
const forbidden = { id: 'local:dashboard-admin', role: 'admin' as const };
const roots: string[] = [];
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'ff-consent-svc-'));
  roots.push(root);
  const project = join(root, 'project');
  mkdirSync(project);
  const fleet = new FleetManager(root);
  const { instance } = fleet.create({ projectPath: project, authMode: 'api-key' });
  let now = 1_800_000_000_000;
  let frozen = false;
  let auditFails = false;
  const store = new TrustedHostStore({ operatorRoot: join(root, 'operator-outside-project'), currentUid: process.getuid?.() ?? 0, now: () => now });
  const audit: string[] = [];
  const service = new TrustedHostConsentService({
    fleet, store, installationId: 'install-fixture-1', serviceUid: process.getuid?.() ?? 0,
    now: () => now, isWriteFrozen: () => frozen,
    recordAudit: (event: string) => { if (auditFails) throw new Error('AUDIT_UNAVAILABLE'); audit.push(event); },
  });
  return {
    root, instance, fleet, store, service, audit,
    setNow: (value: number) => { now = value; },
    setFrozen: (value: boolean) => { frozen = value; },
    setAuditFails: (value: boolean) => { auditFails = value; },
  };
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('trusted host profile consent service', () => {
  it.skipIf(process.platform === 'darwin')('keeps operator consent unavailable on non-qualified hosts', () => {
    const root = mkdtempSync(join(tmpdir(), 'ff-no-macos-consent-'));
    roots.push(root);
    const container = new Container(defaultConfig(root));
    expect(container.trustedHostConsentService()).toBeNull();
  });
  it('creates an immutable pending intent; does not change Fleet config or create a grant', () => {
    const h = harness();
    const before = h.fleet.get(h.instance.id);
    const intent = h.service.requestProfile(h.instance.id, tuple, acceptedAdmin);
    expect(intent.status).toBe('pending');
    expect(intent.requestId).toMatch(/^req_[A-Za-z0-9_-]+$/);
    expect(h.fleet.get(h.instance.id).toolsPreset).toBe(before.toolsPreset);
    expect(h.fleet.get(h.instance.id).policyMode).toBe(before.policyMode);
    expect(h.service.status(h.instance.id, intent.requestId).status).toBe('pending');
    expect(() => h.service.assertAuthorized(h.instance.id, tuple)).toThrow('TRUSTED_HOST_CONSENT_REQUIRED');
    expect(h.audit).toContain('trusted_host_intent_requested');
  });

  it('never accepts a local unauthenticated admin or low-scope actor', () => {
    const h = harness();
    expect(() => h.service.requestProfile(h.instance.id, tuple, forbidden)).toThrow('HOST_OPERATOR_AUTH_REQUIRED');
    expect(() => h.service.requestProfile(h.instance.id, tuple, { id: 'remote-agent', role: 'agent' })).toThrow('HOST_OPERATOR_AUTH_REQUIRED');
    expect(() => h.service.requestProfile(h.instance.id, tuple, { id: 'credential:wrong', role: 'viewer' })).toThrow('HOST_OPERATOR_AUTH_REQUIRED');
  });

  it('refuses an unprotected host instance, write freeze, and audit durability failure', () => {
    const h = harness();
    h.setFrozen(true);
    expect(() => h.service.requestProfile(h.instance.id, tuple, acceptedAdmin)).toThrow('WRITE_FREEZE_ACTIVE');
    h.setFrozen(false);
    h.setAuditFails(true);
    expect(() => h.service.requestProfile(h.instance.id, tuple, acceptedAdmin)).toThrow('AUDIT_UNAVAILABLE');
  });

  it('prevents different pending requests, but identical request remains idempotent', () => {
    const h = harness();
    const first = h.service.requestProfile(h.instance.id, tuple, acceptedAdmin);
    const second = h.service.requestProfile(h.instance.id, tuple, acceptedAdmin);
    expect(second.requestId).toBe(first.requestId);
    expect(() => h.service.requestProfile(h.instance.id, { ...tuple, policyMode: 'safe' }, acceptedAdmin)).toThrow('CONSENT_INTENT_CONFLICT');
  });

  it('requires a new consent when auth or exact settings scope changes', () => {
    const h = harness();
    const issued = h.service.requestProfile(h.instance.id, tuple, acceptedAdmin);
    const pending = h.store.readPending(issued.requestId)!;
    h.store.consumeLocalApproval(issued.requestId, pending.scopeHash);
    expect(() => h.service.assertAuthorized(h.instance.id, tuple)).not.toThrow();
    expect(() => h.service.assertAuthorized(h.instance.id, { ...tuple, policyMode: 'safe' })).toThrow('TRUSTED_HOST_CONSENT_REQUIRED');
    expect(h.service.status(h.instance.id, issued.requestId).status).toBe('approved');
  });

  it('enforces pending request revision CAS at apply time but keeps stable grant identity', () => {
    const h = harness();
    const issued = h.service.requestProfile(h.instance.id, tuple, acceptedAdmin);
    const pending = h.store.readPending(issued.requestId)!;
    h.store.consumeLocalApproval(issued.requestId, pending.scopeHash);
    h.fleet.setPolicyMode(h.instance.id, 'safe'); // unrelated Fleet revision
    expect(() => h.service.assertAuthorized(h.instance.id, tuple)).not.toThrow();
    expect(() => h.service.assertAuthorizedForIntent(h.instance.id, tuple, issued.requestId)).toThrow('CONSENT_STALE_REVISION');
  });

  it('cancelled or expired intents cannot be locally approved', () => {
    const h = harness();
    const issued = h.service.requestProfile(h.instance.id, tuple, acceptedAdmin);
    h.service.cancelPending(h.instance.id, issued.requestId, acceptedAdmin);
    expect(h.store.readPending(issued.requestId)).toBeNull();
    const second = h.service.requestProfile(h.instance.id, tuple, acceptedAdmin);
    h.setNow(1_800_000_601_000);
    expect(h.store.readPending(second.requestId)).toBeNull();
  });

  it('operator revocation invalidates an existing grant', () => {
    const h = harness();
    const issued = h.service.requestProfile(h.instance.id, tuple, acceptedAdmin);
    h.store.consumeLocalApproval(issued.requestId, h.store.readPending(issued.requestId)!.scopeHash);
    h.service.revokeFromLocal(h.instance.id);
    expect(() => h.service.assertAuthorized(h.instance.id, tuple)).toThrow('TRUSTED_HOST_CONSENT_REQUIRED');
  });
});
