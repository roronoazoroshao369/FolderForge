import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, linkSync, lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TrustedHostStore, type TrustedHostIntent } from '../../src/operator/trusted-host-store.js';
import { scopeDigest, type FleetProfileTuple, type ConsentIdentity } from '../../src/operator/trusted-host-scope.js';

const tuple: FleetProfileTuple = { toolsPreset: 'full', policyMode: 'danger', terminalExecution: 'trusted-host' };
const identity: ConsentIdentity = {
  installationId: 'install-test', serviceUid: process.getuid?.() ?? 0, instanceId: 'flt_test',
  workspaceRealpath: '/tmp/project-identity', authMode: 'api-key', revocationGeneration: 0,
};
const roots: string[] = [];
const now = 1_800_000_000_000;

function harness() {
  const outer = mkdtempSync(join(tmpdir(), 'trusted-host-store-tests-'));
  roots.push(outer);
  const operatorRoot = join(outer, 'operator');
  const store = new TrustedHostStore({ operatorRoot, currentUid: process.getuid?.() ?? 0, now: () => now });
  return { outer, operatorRoot, store };
}

function intent(requestId: string): TrustedHostIntent {
  return {
    schemaVersion: 1, requestId, instanceId: identity.instanceId,
    tuple, identity, scopeHash: scopeDigest(tuple, identity),
    expectedInstanceRevision: 'revision-1', requestedBy: 'operator-a',
    createdAt: now, expiresAt: now + 600_000,
  };
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('operator-only scoped grant store', () => {
  it('creates owner-private state and a one-shot exact-scope grant', () => {
    const { store, operatorRoot } = harness();
    store.createPending(intent('req_aaa'));
    expect(lstatSync(operatorRoot).mode & 0o077).toBe(0);
    expect(store.readPending('req_aaa')?.instanceId).toBe('flt_test');
    expect(store.validateGrant(identity, tuple)).toBe(false);
    const grant = store.consumeLocalApproval('req_aaa', scopeDigest(tuple, identity));
    expect(grant.scopeHash).toBe(scopeDigest(tuple, identity));
    expect(store.validateGrant(identity, tuple)).toBe(true);
    expect(store.validateGrant(identity, { ...tuple, policyMode: 'safe' })).toBe(false);
    expect(() => store.consumeLocalApproval('req_aaa', grant.scopeHash)).toThrow();
    const filenames = ['pending/req_aaa.json', 'grants/' + grant.scopeHash + '.json'];
    for (const f of filenames) {
      const path = join(operatorRoot, f);
      expect(lstatSync(path).mode & 0o077).toBe(0);
    }
  });

  it('rejects an expired request, mismatching tuple and unsafe request identifiers', () => {
    const { store } = harness();
    store.createPending(intent('req_aaa'));
    expect(() => store.consumeLocalApproval('req_aaa', 'a'.repeat(64))).toThrow('CONSENT_SCOPE_MISMATCH');
    expect(() => store.readPending('../../etc/passwd')).toThrow('INVALID_CONSENT_REQUEST_ID');
    expect(() => store.createPending({ ...intent('req_bbb'), expiresAt: now - 1 })).toThrow();
  });

  it('refuses symlinked state and unsafe permissions rather than trusting its path', () => {
    const { store, operatorRoot } = harness();
    store.createPending(intent('req_aaa'));
    const rootLink = join(operatorRoot, 'pending', 'req_bbb.json');
    symlinkSync(join(operatorRoot, 'pending', 'req_aaa.json'), rootLink);
    expect(() => store.readPending('req_bbb')).toThrow();
    chmodSync(join(operatorRoot, 'pending', 'req_aaa.json'), 0o644);
    expect(() => store.readPending('req_aaa')).toThrow('INVALID_OPERATOR_FILE');
  });

  it('refuses extra hard links for a pending request', () => {
    const { store, operatorRoot } = harness();
    store.createPending(intent('req_aaa'));
    linkSync(join(operatorRoot, 'pending', 'req_aaa.json'), join(operatorRoot, 'linked'));
    expect(() => store.readPending('req_aaa')).toThrow('INVALID_OPERATOR_FILE');
  });

  it('revoking a scope denies its old grant and an unchanged-grant copy cannot resurrect it', () => {
    const { store } = harness();
    store.createPending(intent('req_aaa'));
    store.consumeLocalApproval('req_aaa', scopeDigest(tuple, identity));
    store.revoke(identity);
    expect(store.validateGrant(identity, tuple)).toBe(false);
    expect(store.currentRevocationGeneration(identity)).toBe(1);
  });

  it('rejects invalid owner root and fails closed on an untrusted filesystem tree', () => {
    const { operatorRoot } = harness();
    // Constructor must refuse world readable owner-root data.
    mkdirSync(operatorRoot, { recursive: true, mode: 0o777 });
    chmodSync(operatorRoot, 0o777);
    expect(() => new TrustedHostStore({ operatorRoot, currentUid: process.getuid?.() ?? 0, now: () => now })).toThrow('INVALID_OPERATOR_DIRECTORY');
  });
});
