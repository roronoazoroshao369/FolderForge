import { afterEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetManager } from '../../src/provisioner/fleet-manager.js';
import { FleetProfileTransaction } from '../../src/provisioner/fleet-profile-transaction.js';
import type { FleetProfileTuple } from '../../src/operator/trusted-host-scope.js';

const tuple: FleetProfileTuple = { toolsPreset: 'full', policyMode: 'danger', terminalExecution: 'trusted-host' };
const roots: string[] = [];
function fixture(phase?: 'prepared' | 'yaml-renamed' | 'state-renamed' | 'committed') {
  const root = mkdtempSync(join(tmpdir(), 'ff-profile-tx-'));
  roots.push(root);
  const project = join(root, 'project');
  mkdirSync(project);
  const fleet = new FleetManager(root);
  const { instance } = fleet.create({ projectPath: project, authMode: 'api-key' });
  const statePath = join(root, '.folderforge', 'fleet.json');
  const yamlPath = join(root, '.folderforge', 'fleet', `${instance.id}.yaml`);
  const before = { json: readFileSync(statePath, 'utf8'), yaml: readFileSync(yamlPath, 'utf8') };
  const tx = new FleetProfileTransaction({
    root, authorize: (id, _tuple, digest) => { if (id !== instance.id || digest !== 'allowed-digest') throw new Error('CONSENT_REQUIRED'); },
    onPhase: (name) => { if (name === phase) throw new Error(`FAULT_AT_${name}`); },
  });
  return { root, tx, before, statePath, yamlPath, instance };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('crash-consistent Fleet profile transaction', () => {
  it('preserves YAML credentials while changing only requested tuple', () => {
    const h = fixture();
    const updated = h.tx.commit(h.instance.id, tuple, 'allowed-digest');
    expect(updated.toolsPreset).toBe('full');
    expect(updated.policyMode).toBe('danger');
    expect(updated.terminalExecution).toBe('trusted-host');
    const yaml = readFileSync(h.yamlPath, 'utf8');
    expect(yaml).toMatch(/requireInDanger: false/);
    expect(yaml).toMatch(/defaultMode: "danger"/);
    expect(yaml).toMatch(/apiKeys:/);
    expect(yaml).toContain(h.before.yaml.match(/ffk_[A-Za-z0-9_-]+/)?.[0] ?? 'NOT_FOUND');
    expect(readFileSync(h.statePath, 'utf8')).toContain('"toolsPreset": "full"');
  });

  it.each(['prepared', 'yaml-renamed', 'state-renamed'] as const)(
    'recovers the old coherent tuple after a crash at %s', (phase) => {
      const h = fixture(phase);
      expect(() => h.tx.commit(h.instance.id, tuple, 'allowed-digest')).toThrow(`FAULT_AT_${phase}`);
      const reloaded = new FleetProfileTransaction({ root: h.root, authorize: () => {} });
      reloaded.recoverBeforeReadOrStart();
      expect(readFileSync(h.yamlPath, 'utf8')).toBe(h.before.yaml);
      expect(readFileSync(h.statePath, 'utf8')).toBe(h.before.json);
    },
  );

  it('reclaims a demonstrably dead writer lock before recovering PREPARED journal', () => {
    const h = fixture('yaml-renamed');
    expect(() => h.tx.commit(h.instance.id, tuple, 'allowed-digest')).toThrow('FAULT_AT_yaml-renamed');
    const lock = join(h.root, '.folderforge', 'fleet-profile.lock');
    writeFileSync(lock, '2147483646', { mode: 0o600 });
    const restarted = new FleetProfileTransaction({ root: h.root, authorize: () => {} });
    restarted.recoverBeforeReadOrStart();
    expect(readFileSync(h.yamlPath, 'utf8')).toBe(h.before.yaml);
    expect(readFileSync(h.statePath, 'utf8')).toBe(h.before.json);
    expect(() => lstatSync(lock)).toThrow();
  });

  it('never reclaims a lock owned by an OS process that is still alive', () => {
    const h = fixture('prepared');
    expect(() => h.tx.commit(h.instance.id, tuple, 'allowed-digest')).toThrow('FAULT_AT_prepared');
    const lock = join(h.root, '.folderforge', 'fleet-profile.lock');
    writeFileSync(lock, String(process.pid), { mode: 0o600 });
    const competing = new FleetProfileTransaction({ root: h.root, authorize: () => {} });
    expect(() => competing.recoverBeforeReadOrStart()).toThrow('FLEET_PROFILE_BUSY');
    expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
  });

  it('recovers committed new values after crash before final cleanup', () => {
    const h = fixture('committed');
    expect(() => h.tx.commit(h.instance.id, tuple, 'allowed-digest')).toThrow('FAULT_AT_committed');
    const tx = new FleetProfileTransaction({ root: h.root, authorize: () => {} });
    tx.recoverBeforeReadOrStart();
    const fleetState = JSON.parse(readFileSync(h.statePath, 'utf8'));
    expect(fleetState.instances[0].toolsPreset).toBe('full');
    expect(readFileSync(h.yamlPath, 'utf8')).toMatch(/requireInDanger: false/);
  });

  it('fails closed on invalid approval without touching any persisted file', () => {
    const h = fixture();
    expect(() => h.tx.commit(h.instance.id, tuple, 'denied')).toThrow('CONSENT_REQUIRED');
    expect(readFileSync(h.yamlPath, 'utf8')).toBe(h.before.yaml);
    expect(readFileSync(h.statePath, 'utf8')).toBe(h.before.json);
  });

  it('rejects symlink replacement and never follows an unsafe YAML pointer', () => {
    const h = fixture();
    rmSync(h.yamlPath);
    symlinkSync(h.statePath, h.yamlPath);
    expect(() => h.tx.commit(h.instance.id, tuple, 'allowed-digest')).toThrow();
    expect(lstatSync(h.yamlPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(h.statePath, 'utf8')).toBe(h.before.json);
  });

  it('halts on corrupt recovery journal instead of allowing a Fleet start', () => {
    const h = fixture();
    const journal = join(h.root, '.folderforge', 'fleet-profile.journal');
    writeFileSync(journal, '{bad-json', { mode: 0o600 });
    expect(() => h.tx.recoverBeforeReadOrStart()).toThrow('RECOVERY_REQUIRED');
    expect(readFileSync(h.yamlPath, 'utf8')).toBe(h.before.yaml);
  });
});
