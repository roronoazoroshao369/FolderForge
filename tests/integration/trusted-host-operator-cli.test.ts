import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runTrustedHostOperatorCli, type OperatorCliIO } from '../../src/operator/trusted-host-cli.js';
import { TrustedHostStore, type TrustedHostIntent } from '../../src/operator/trusted-host-store.js';
import { scopeDigest, type ConsentIdentity, type FleetProfileTuple } from '../../src/operator/trusted-host-scope.js';

const tuple: FleetProfileTuple = { toolsPreset: 'full', policyMode: 'danger', terminalExecution: 'trusted-host' };
const identity: ConsentIdentity = { installationId: 'mac-local-install', serviceUid: 501, instanceId: 'flt_approved', workspaceRealpath: '/home/project', authMode: 'api-key', revocationGeneration: 0 };
const now = 1_800_000_000_000;
const temp: string[] = [];
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'ff-local-cli-'));
  temp.push(root);
  const store = new TrustedHostStore({ operatorRoot: join(root, 'consent'), currentUid: process.getuid?.() ?? 0, now: () => now });
  const request: TrustedHostIntent = {
    schemaVersion: 1, requestId: 'req_1abc', instanceId: identity.instanceId,
    identity, tuple, scopeHash: scopeDigest(tuple, identity),
    expectedInstanceRevision: 'revision_1', requestedBy: 'admin',
    createdAt: now, expiresAt: now + 600_000,
  };
  store.createPending(request);
  return { store, request };
}
afterEach(() => { for (const p of temp.splice(0)) rmSync(p, { recursive: true, force: true }); });
function io(answer: string, override: Partial<OperatorCliIO> = {}): OperatorCliIO {
  return { stdinIsTTY: true, stdoutIsTTY: true, osUid: identity.serviceUid,
    print: () => {}, ask: async () => answer, ...override };
}

describe('separate on-host operator CLI', () => {
  it('displays bound tuple and requires an explicit confirmation without exposing grant', async () => {
    const { store, request } = harness();
    const result = await runTrustedHostOperatorCli(['approve', request.requestId], io('APPROVE flt_approved'), store);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('flt_approved');
    expect(result.output).toContain('/home/project');
    expect(result.output).toContain('full');
    expect(result.output).toContain('danger');
    expect(result.output).toContain('trusted-host');
    expect(store.validateGrant(identity, tuple)).toBe(true);
    expect(result.output).not.toContain(request.scopeHash);
  });

  it.each(['no', 'yes', '', 'APPROVE flt_other'])('rejects ambiguous user answer: %j', async (answer) => {
    const { store, request } = harness();
    const result = await runTrustedHostOperatorCli(['approve', request.requestId], io(answer), store);
    expect(result.exitCode).not.toBe(0);
    expect(store.validateGrant(identity, tuple)).toBe(false);
  });

  it('fails closed if command is noninteractive, wrong user or includes --yes', async () => {
    const { store, request } = harness();
    for (const opts of [
      { stdinIsTTY: false }, { stdoutIsTTY: false }, { osUid: 502 },
    ]) {
      const result = await runTrustedHostOperatorCli(['approve', request.requestId], io('APPROVE flt_approved', opts), store);
      expect(result.exitCode).not.toBe(0);
    }
    expect((await runTrustedHostOperatorCli(['approve', request.requestId, '--yes'], io('APPROVE flt_approved'), store)).exitCode).not.toBe(0);
    expect(store.validateGrant(identity, tuple)).toBe(false);
  });

  it('revokes an existing capability via interactive confirmation', async () => {
    const { store, request } = harness();
    store.consumeLocalApproval(request.requestId, request.scopeHash);
    expect(store.validateGrant(identity, tuple)).toBe(true);
    const result = await runTrustedHostOperatorCli(['revoke', request.scopeHash], io('REVOKE flt_approved'), store);
    expect(result.exitCode).toBe(0);
    expect(store.validateGrant(identity, tuple)).toBe(false);
  });
});
