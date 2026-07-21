import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../../src/runtime/config.js';
import { PolicyEngine } from '../../src/policy/policy-engine.js';
import { Container } from '../../src/runtime/container.js';
import { buildRegistry } from '../../src/tools/index.js';
import {
  MISSION_CONTROL_OPERATOR_ROLE,
  MissionControlState,
} from '../../src/operator/mission-control.js';

function setup(root: string, mode: 'readonly' | 'safe' | 'dev' | 'danger' = 'safe') {
  const config = defaultConfig(root);
  config.policy.defaultMode = mode;
  const policy = new PolicyEngine(config);
  policy.setMode(mode);
  const missionControl = new MissionControlState(root, policy);
  return { policy, missionControl };
}

describe('MissionControlState', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'folderforge-mission-control-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('persists write-freeze, restores it on restart, and restores the prior mode', () => {
    const first = setup(root, 'dev');
    const frozen = first.missionControl.setWriteFreeze(true, 'admin:operator');
    expect(frozen).toMatchObject({
      writeFreeze: true,
      effectivePolicyMode: 'readonly',
      previousPolicyMode: 'dev',
    });
    expect(first.policy.getMode()).toBe('readonly');

    const restarted = setup(root, 'safe');
    expect(restarted.missionControl.describe()).toMatchObject({
      writeFreeze: true,
      effectivePolicyMode: 'readonly',
      previousPolicyMode: 'dev',
    });

    const unfrozen = restarted.missionControl.setWriteFreeze(false, 'admin:operator');
    expect(unfrozen).toMatchObject({
      writeFreeze: false,
      effectivePolicyMode: 'dev',
    });
  });

  it('preserves an explicitly readonly prior mode across freeze/unfreeze', () => {
    const { policy, missionControl } = setup(root, 'readonly');
    missionControl.setWriteFreeze(true, 'admin:operator');
    missionControl.setWriteFreeze(false, 'admin:operator');
    expect(policy.getMode()).toBe('readonly');
  });

  it('permits only exact dashboard containment actions during write-freeze', () => {
    const { missionControl } = setup(root);
    missionControl.setWriteFreeze(true, 'admin:operator');
    const dashboardAdmin = {
      id: 'local:dashboard-admin:operator-action',
      role: 'admin' as const,
      roles: ['admin', MISSION_CONTROL_OPERATOR_ROLE],
    };

    expect(missionControl.allowsContainmentAction('workflow_pause', dashboardAdmin)).toBe(true);
    expect(missionControl.allowsContainmentAction('process_kill', dashboardAdmin)).toBe(true);
    expect(missionControl.allowsContainmentAction('isolation_rollback', dashboardAdmin)).toBe(true);
    expect(missionControl.allowsContainmentAction('isolation_apply', dashboardAdmin)).toBe(false);
    expect(
      missionControl.allowsContainmentAction('workflow_pause', {
        ...dashboardAdmin,
        roles: ['admin'],
      }),
    ).toBe(false);
    expect(
      missionControl.allowsContainmentAction('workflow_pause', {
        ...dashboardAdmin,
        role: 'agent',
      }),
    ).toBe(false);
  });

  it('keeps agents readonly while allowing audited dashboard containment', async () => {
    const config = defaultConfig(root);
    config.rateLimit.enabled = false;
    const container = new Container(config);
    const registry = buildRegistry(container);
    const owner = {
      id: 'credential:task-owner',
      role: 'agent' as const,
      projectId: 'project:test',
    };
    const run = container.workflows.create(
      {
        name: 'containment task',
        roles: { reader: { allowedTools: ['policy_get'] } },
        steps: [{ id: 'read', role: 'reader', tool: 'policy_get' }],
      },
      owner,
    );
    container.missionControl.setWriteFreeze(true, 'local:dashboard-admin');

    const denied = await registry.callAgent(
      'workflow_pause',
      { id: run.id },
      { principal: { ...owner, roles: [MISSION_CONTROL_OPERATOR_ROLE] } },
    );
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/readonly/i);
    expect(container.workflows.get(run.id, owner).state).toBe('created');

    const contained = await registry.call(
      'workflow_pause',
      { id: run.id, reason: 'Incident containment' },
      {
        principal: {
          id: 'local:dashboard-admin:operator-action',
          role: 'admin',
          roles: ['admin', MISSION_CONTROL_OPERATOR_ROLE],
          sessionId: 'local:dashboard-admin:dashboard-session',
        },
      },
    );
    expect(contained.ok).toBe(true);
    expect(container.workflows.get(run.id, owner).state).toBe('paused');
    expect(
      container.audit
        .recent(20)
        .find((event) => event.type === 'tool_call' && event.tool === 'workflow_pause')
        ?.detail?.containmentAction,
    ).toBe(true);
  });

  it('blocks policy changes while frozen and detects state tampering', () => {
    const { missionControl } = setup(root);
    missionControl.setWriteFreeze(true, 'admin:operator');
    expect(() => missionControl.setPolicyMode('dev', 'admin:operator')).toThrow(/write freeze/i);

    const path = join(root, '.folderforge', 'mission-control.json');
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    persisted.updatedBy = 'attacker';
    writeFileSync(path, `${JSON.stringify(persisted, null, 2)}\n`);

    expect(() => setup(root)).toThrow(/integrity check failed/i);
  });
});
