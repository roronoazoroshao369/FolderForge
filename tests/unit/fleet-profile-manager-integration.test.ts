import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FleetManager } from '../../src/provisioner/fleet-manager.js';
import { TrustedHostStore } from '../../src/operator/trusted-host-store.js';
import { TrustedHostConsentService } from '../../src/operator/trusted-host-consent.js';
import type { FleetProfileTuple } from '../../src/operator/trusted-host-scope.js';

const tuple: FleetProfileTuple = { toolsPreset: 'full', policyMode: 'danger', terminalExecution: 'trusted-host' };
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ff-manager-tx-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const fleet = new FleetManager(root);
  const { instance } = fleet.create({ projectPath: workspace, authMode: 'api-key' });
  const store = new TrustedHostStore({ operatorRoot: join(root, 'operator'), currentUid: process.getuid?.() ?? 0, now: Date.now });
  const auth = new TrustedHostConsentService({
    store, fleet, installationId: 'install', serviceUid: process.getuid?.() ?? 0,
    now: Date.now, isWriteFrozen: () => false, recordAudit: () => {},
  });
  return { root, fleet, instance, store, auth };
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('FleetManager zero-config tuple application', () => {
  it('applies only an exact locally approved tuple while preserving credentials', () => {
    const h = fixture();
    const req = h.auth.requestProfile(h.instance.id, tuple, { id: 'credential:admin', role: 'admin' });
    const pending = h.store.readPending(req.requestId)!;
    h.store.consumeLocalApproval(req.requestId, pending.scopeHash);
    const updated = h.fleet.updateProfileAtomically(h.instance.id, tuple, h.auth);
    expect(updated.toolsPreset).toBe('full');
    expect(updated.policyMode).toBe('danger');
    expect(updated.terminalExecution).toBe('trusted-host');
    expect(h.fleet.get(h.instance.id).terminalExecution).toBe('trusted-host');
    const yaml = readFileSync(join(h.root, '.folderforge', 'fleet', h.instance.id + '.yaml'), 'utf8');
    expect(yaml).toContain('requireInDanger: false');
    expect(yaml).toContain('apiKeys:');
  });

  it('rejects stale revision after another profile change without partial elevation', () => {
    const h = fixture();
    const req = h.auth.requestProfile(h.instance.id, tuple, { id: 'credential:admin', role: 'admin' });
    h.store.consumeLocalApproval(req.requestId, h.store.readPending(req.requestId)!.scopeHash);
    h.fleet.setPolicyMode(h.instance.id, 'safe');
    expect(() => h.fleet.updateProfileAtomically(h.instance.id, tuple, h.auth)).toThrow('CONSENT_STALE_REVISION');
    expect(h.fleet.get(h.instance.id).terminalExecution).not.toBe('trusted-host');
    expect(h.fleet.get(h.instance.id).toolsPreset).not.toBe('full');
  });
});
