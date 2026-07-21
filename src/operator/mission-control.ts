import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PolicyMode, ToolPrincipal } from '../core/types.js';
import type { PolicyEngine } from '../policy/policy-engine.js';

interface PersistedMissionControlState {
  schemaVersion: 1;
  writeFreeze: boolean;
  previousPolicyMode?: PolicyMode;
  updatedAt: string;
  updatedBy: string;
  integritySha256: string;
}

export interface MissionControlStateView {
  writeFreeze: boolean;
  effectivePolicyMode: PolicyMode;
  previousPolicyMode?: PolicyMode;
  updatedAt?: string;
  updatedBy?: string;
  containmentActions: string[];
}

export const MISSION_CONTROL_OPERATOR_ROLE = 'folderforge:mission-control-operator';

const MODES: PolicyMode[] = ['readonly', 'safe', 'dev', 'danger'];
const CONTAINMENT_ACTIONS = new Set([
  'workflow_pause',
  'workflow_cancel',
  'process_stop',
  'process_kill',
  'isolation_rollback',
  'isolation_discard',
]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(state: Omit<PersistedMissionControlState, 'integritySha256'>): string {
  return createHash('sha256').update(canonical(state)).digest('hex');
}

function isPolicyMode(value: unknown): value is PolicyMode {
  return typeof value === 'string' && MODES.includes(value as PolicyMode);
}

export class MissionControlState {
  private readonly path: string;
  private state?: PersistedMissionControlState;

  constructor(
    projectRoot: string,
    private readonly policy: PolicyEngine,
  ) {
    this.path = resolve(projectRoot, '.folderforge', 'mission-control.json');
    this.load();
    if (this.state?.writeFreeze) this.policy.setMode('readonly');
  }

  describe(): MissionControlStateView {
    return {
      writeFreeze: this.state?.writeFreeze ?? false,
      effectivePolicyMode: this.policy.getMode(),
      ...(this.state?.previousPolicyMode
        ? { previousPolicyMode: this.state.previousPolicyMode }
        : {}),
      ...(this.state?.updatedAt ? { updatedAt: this.state.updatedAt } : {}),
      ...(this.state?.updatedBy ? { updatedBy: this.state.updatedBy } : {}),
      containmentActions: [...CONTAINMENT_ACTIONS].sort(),
    };
  }

  isWriteFreezeActive(): boolean {
    return this.state?.writeFreeze === true;
  }

  /**
   * Write-freeze is fail-closed for every normal caller. The only exception is
   * a small, server-generated dashboard role performing an exact containment
   * action that reduces or stops ongoing activity.
   */
  allowsContainmentAction(tool: string, principal: ToolPrincipal): boolean {
    return Boolean(
      this.isWriteFreezeActive() &&
        principal.role === 'admin' &&
        principal.roles?.includes(MISSION_CONTROL_OPERATOR_ROLE) &&
        CONTAINMENT_ACTIONS.has(tool),
    );
  }

  setWriteFreeze(enabled: boolean, actorId: string): MissionControlStateView {
    const actor = actorId.trim();
    if (!actor) throw new Error('Mission Control actor id is required.');
    const current = this.describe();
    if (enabled === current.writeFreeze) return current;

    if (enabled) {
      const next = this.persisted({
        writeFreeze: true,
        previousPolicyMode: this.policy.getMode(),
        updatedBy: actor,
      });
      // Persist first. A crash between persistence and the in-memory mode change
      // restarts fail-closed because constructor load restores readonly.
      this.persistState(next);
      this.state = next;
      this.policy.setMode('readonly');
    } else {
      const restored = this.state?.previousPolicyMode ?? 'safe';
      const next = this.persisted({
        writeFreeze: false,
        updatedBy: actor,
      });
      // Persist the unfreeze decision before changing runtime policy. A crash in
      // between leaves this process readonly, which is the safer failure mode.
      this.persistState(next);
      this.state = next;
      this.policy.setMode(restored);
    }
    return this.describe();
  }

  setPolicyMode(mode: PolicyMode, actorId: string): MissionControlStateView {
    const actor = actorId.trim();
    if (!actor) throw new Error('Mission Control actor id is required.');
    if (!isPolicyMode(mode)) throw new Error(`Unsupported policy mode: ${String(mode)}`);
    if (this.state?.writeFreeze && mode !== 'readonly') {
      throw new Error('Mission Control write freeze is active; disable it before changing policy mode.');
    }

    if (this.state) {
      const next = this.persisted({
        writeFreeze: this.state.writeFreeze,
        ...(this.state.previousPolicyMode
          ? { previousPolicyMode: this.state.previousPolicyMode }
          : {}),
        updatedBy: actor,
      });
      this.persistState(next);
      this.state = next;
    }
    this.policy.setMode(mode);
    return this.describe();
  }

  private persisted(input: {
    writeFreeze: boolean;
    previousPolicyMode?: PolicyMode;
    updatedBy: string;
  }): PersistedMissionControlState {
    const unsigned = {
      schemaVersion: 1 as const,
      writeFreeze: input.writeFreeze,
      ...(input.previousPolicyMode
        ? { previousPolicyMode: input.previousPolicyMode }
        : {}),
      updatedAt: new Date().toISOString(),
      updatedBy: input.updatedBy,
    };
    return { ...unsigned, integritySha256: digest(unsigned) };
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as PersistedMissionControlState;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.writeFreeze !== 'boolean' ||
      !Number.isFinite(Date.parse(parsed.updatedAt)) ||
      typeof parsed.updatedBy !== 'string' ||
      !parsed.updatedBy.trim() ||
      !/^[a-f0-9]{64}$/.test(parsed.integritySha256) ||
      (parsed.previousPolicyMode !== undefined && !isPolicyMode(parsed.previousPolicyMode))
    ) {
      throw new Error('Mission Control state is invalid.');
    }
    const { integritySha256, ...unsigned } = parsed;
    if (digest(unsigned) !== integritySha256) {
      throw new Error('Mission Control state integrity check failed.');
    }
    this.state = parsed;
  }

  private persistState(state: PersistedMissionControlState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }
}
