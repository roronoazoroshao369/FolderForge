import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scopeDigest, operatorStateOutsideProjects, type ConsentIdentity, type FleetProfileTuple } from '../../src/operator/trusted-host-scope.js';

const tuple: FleetProfileTuple = { toolsPreset: 'full', policyMode: 'danger', terminalExecution: 'trusted-host' };
const identity: ConsentIdentity = {
  installationId: 'install-a', serviceUid: 501, instanceId: 'flt_a',
  workspaceRealpath: '/projects/real', authMode: 'api-key', revocationGeneration: 1,
};

describe('scope-bound trusted host grants', () => {
  it('denies symlinked agent roots that contain operator state, even with unrelated lexical path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-operator-symlink-'));
    try {
      const parent = join(dir, 'real');
      const state = join(parent, 'Library', 'FolderForge');
      mkdirSync(state, { recursive: true });
      const alias = join(dir, 'workspace-link');
      symlinkSync(parent, alias);
      expect(operatorStateOutsideProjects(state, [alias])).toBe(false);
      expect(operatorStateOutsideProjects(state, [join(dir, 'other')])).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('uses stable scope identity, not routine instance revision or mutable object order', () => {
    const reordered: FleetProfileTuple = { terminalExecution: 'trusted-host', policyMode: 'danger', toolsPreset: 'full' };
    expect(scopeDigest(tuple, identity)).toBe(scopeDigest(reordered, { ...identity }));
    expect(scopeDigest(tuple, identity)).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['installationId', 'other'], ['serviceUid', 502], ['instanceId', 'flt_other'],
    ['workspaceRealpath', '/projects/other'], ['authMode', 'oauth'],
    ['revocationGeneration', 2],
  ] as const)('changes grant digest when %s changes', (key, value) => {
    expect(scopeDigest(tuple, identity)).not.toBe(scopeDigest(tuple, { ...identity, [key]: value }));
  });

  it.each([
    [{ ...tuple, policyMode: 'safe' }],
    [{ ...tuple, toolsPreset: 'vibe' }],
    [{ ...tuple, terminalExecution: 'sandbox-required' }],
  ] as const)('never reuses grant for a changed tuple', (changed) => {
    expect(scopeDigest(tuple, identity)).not.toBe(scopeDigest(changed, identity));
  });

  it('does not incorporate a raw credential', () => {
    const result = scopeDigest(tuple, identity);
    expect(result).not.toContain('my-token');
  });

  it('refuses unsafe grant identities and unauthenticated children', () => {
    expect(() => scopeDigest(tuple, { ...identity, authMode: 'none' })).toThrow('TRUSTED_HOST_AUTH_REQUIRED');
    expect(() => scopeDigest(tuple, { ...identity, instanceId: '' })).toThrow();
    expect(() => scopeDigest(tuple, { ...identity, revocationGeneration: -1 })).toThrow();
  });
});
