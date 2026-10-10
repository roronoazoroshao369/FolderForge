import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FleetManager } from '../../src/provisioner/fleet-manager.js';
import { TrustedHostStore } from '../../src/operator/trusted-host-store.js';
import { TrustedHostConsentService } from '../../src/operator/trusted-host-consent.js';
import type { FleetProfileTuple } from '../../src/operator/trusted-host-scope.js';

const tuple: FleetProfileTuple = { toolsPreset: 'full', policyMode: 'danger', terminalExecution: 'trusted-host' };
const roots: string[] = [];
function fixture(resolveAtStart = false, alive?: { current: boolean }) {
  const lazyService: { current?: TrustedHostConsentService } = {};
  const root = mkdtempSync(join(tmpdir(), 'ff-trusted-lifecycle-'));
  roots.push(root);
  const project = join(root, 'project');
  mkdirSync(project);
  const spawned: string[] = [];
  const fleet = new FleetManager(root, {
    mainJs: process.execPath, // existing file; avoids a build dependency in this focused test
    spawn: (command) => { spawned.push(command); return { sessionId: 'proc_1', pid: 99999 }; },
    stopSession: () => {},
    isAlive: () => alive?.current ?? false,
    ...(resolveAtStart ? { resolveTrustedHostConsent: () => lazyService.current ?? null } : {}),
  });
  const { instance } = fleet.create({ projectPath: project, authMode: 'api-key' });
  const store = new TrustedHostStore({ operatorRoot: join(root, 'operator'), currentUid: process.getuid?.() ?? 0, now: Date.now });
  const auth = new TrustedHostConsentService({
    fleet, store, installationId: 'test-install', serviceUid: process.getuid?.() ?? 0,
    now: Date.now, isWriteFrozen: () => false, recordAudit: () => {},
  });
  lazyService.current = auth;
  const approveApply = () => {
    const intent = auth.requestProfile(instance.id, tuple, { id: 'credential:admin', role: 'admin' });
    store.consumeLocalApproval(intent.requestId, store.readPending(intent.requestId)!.scopeHash);
    fleet.updateProfileAtomically(instance.id, tuple, auth);
  };
  return { fleet, instance, project, root, spawned, store, auth, approveApply };
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('Fleet trusted-host execution boundary', () => {
  it('revalidates scoped operator grant via the lazy resolver on every start', () => {
    const h = fixture(true);
    h.approveApply();
    h.fleet.start(h.instance.id);
    expect(h.spawned).toHaveLength(1);
  });

  it('requires a granted exact Fleet instance at every start and preserves the legacy denied default', () => {
    const h = fixture();
    expect(() => h.fleet.setTerminalExecution(h.instance.id, 'trusted-host')).toThrow();
    h.approveApply();
    expect(() => h.fleet.start(h.instance.id)).toThrow('TRUSTED_HOST_CONSENT_REQUIRED');
    h.fleet.bindTrustedHostConsent(h.auth);
    h.fleet.start(h.instance.id);
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]).toContain('--config');
  });

  it('supervises a revoked running child and never reports stopped while PID survives', () => {
    const h = fixture(true);
    h.approveApply();
    h.fleet.start(h.instance.id);
    h.auth.revokeFromLocal(h.instance.id);
    const affected = h.fleet.reconcileRevokedTrustedHosts();
    expect(affected).toContain(h.instance.id);
    const record = h.fleet.get(h.instance.id);
    expect(record.state).not.toBe('running');
    expect(record.state).toBe('stopped'); // injected PID is verified dead by fixture
    expect(() => h.fleet.start(h.instance.id)).toThrow('TRUSTED_HOST_CONSENT_REQUIRED');
  });

  it('holds a revoked live PID in an uncertain state until termination is proven', () => {
    const alive = { current: true };
    const h = fixture(true, alive);
    h.approveApply();
    h.fleet.start(h.instance.id);
    h.auth.revokeFromLocal(h.instance.id);
    h.fleet.reconcileRevokedTrustedHosts();
    const pending = h.fleet.get(h.instance.id);
    expect(pending.state).toBe('stopping');
    expect(pending.lastError).toBe('REVOKED_EXECUTION_UNCERTAIN');
    expect(pending.pid).toBe(99999);
    alive.current = false;
    h.fleet.reconcileRevokedTrustedHosts();
    const stopped = h.fleet.get(h.instance.id);
    expect(stopped.state).toBe('stopped');
    expect(stopped.pid).toBeUndefined();
  });

  it('never normalizes a revoked uncertain child to stopped after parent restart', () => {
    const alive = { current: true };
    const h = fixture(true, alive);
    h.approveApply();
    h.fleet.start(h.instance.id);
    h.auth.revokeFromLocal(h.instance.id);
    h.fleet.reconcileRevokedTrustedHosts();
    const restarted = new FleetManager(h.root, { isAlive: () => alive.current });
    const snapshot = restarted.get(h.instance.id);
    expect(snapshot.state).not.toBe('stopped');
    expect(snapshot.lastError).toMatch(/REVOKED_EXECUTION_UNCERTAIN/);
  });

  it('continues reconciliation after restart for a revoked child with a live unknown PID', () => {
    const alive = { current: true };
    const h = fixture(true, alive);
    h.approveApply();
    h.fleet.start(h.instance.id);
    h.auth.revokeFromLocal(h.instance.id);
    h.fleet.reconcileRevokedTrustedHosts();

    const restarted = new FleetManager(h.root, { isAlive: () => alive.current });
    expect(restarted.get(h.instance.id).lastError).toBe('REVOKED_EXECUTION_UNCERTAIN_AFTER_RESTART');

    alive.current = false;
    expect(restarted.reconcileRevokedTrustedHosts()).toContain(h.instance.id);
    const recovered = restarted.get(h.instance.id);
    expect(recovered.state).toBe('stopped');
    expect(recovered.pid).toBeUndefined();
    expect(recovered.lastError).toBe('TRUSTED_HOST_REVOKED_VERIFIED_STOP');
  });

  it('denies any new trusted-host start after local grant revocation', () => {
    const h = fixture();
    h.approveApply();
    h.fleet.bindTrustedHostConsent(h.auth);
    h.auth.revokeFromLocal(h.instance.id);
    expect(() => h.fleet.start(h.instance.id)).toThrow('TRUSTED_HOST_CONSENT_REQUIRED');
    expect(h.spawned).toHaveLength(0);
  });

  it('fails closed when saved YAML diverges from Fleet execution profile', () => {
    const h = fixture();
    const file = join(h.root, '.folderforge', 'fleet', h.instance.id + '.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('requireInDanger: true', 'requireInDanger: false'));
    expect(() => h.fleet.start(h.instance.id)).toThrow('FLEET_PROFILE_MISMATCH');
    expect(h.spawned).toHaveLength(0);
  });

  it('never represents a stopped instance as running/verified after an approved save', () => {
    const h = fixture();
    h.approveApply();
    const status = h.fleet.effectiveExecutionStatus(h.instance.id);
    expect(status.persistedProfile).toBe('trusted-host');
    expect(status.processState).toBe('stopped');
    expect(status.runtimeVerified).toBe(false);
  });
});
