import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetManager } from '../../src/provisioner/fleet-manager.js';
import { provisionTools } from '../../src/tools/provision-tools.js';
import type { ToolContext } from '../../src/core/types.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('Fleet MCP provision_update cannot bypass host authorization', () => {
  it('refuses combined full + danger + trusted-host without persisting the first two fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ff-provision-bypass-'));
    roots.push(root);
    const workspace = join(root, 'project');
    mkdirSync(workspace);
    const fleet = new FleetManager(root);
    const { instance } = fleet.create({ projectPath: workspace, authMode: 'api-key' });
    const before = fleet.get(instance.id);
    const update = provisionTools().find(tool => tool.name === 'provision_update');
    expect(update).toBeDefined();
    const result = await update!.handler(
      { id: instance.id, toolsPreset: 'full', policyMode: 'danger', terminalExecution: 'trusted-host' },
      { container: { fleet, audit: { record: () => {} } } } as unknown as ToolContext,
    );
    expect(result.ok).toBe(false);
    expect(fleet.get(instance.id).toolsPreset).toBe(before.toolsPreset);
    expect(fleet.get(instance.id).policyMode).toBe(before.policyMode);
    expect(fleet.get(instance.id).terminalExecution).toBe(before.terminalExecution);
    expect(new FleetManager(root).get(instance.id).policyMode).toBe(before.policyMode);
  });

  it('retains separately authorized ordinary preset changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ff-provision-safe-'));
    roots.push(root);
    const workspace = join(root, 'project');
    mkdirSync(workspace);
    const fleet = new FleetManager(root);
    const { instance } = fleet.create({ projectPath: workspace });
    const update = provisionTools().find(tool => tool.name === 'provision_update');
    const result = await update!.handler(
      { id: instance.id, toolsPreset: 'full' },
      { container: { fleet, audit: { record: () => {} } } } as unknown as ToolContext,
    );
    expect(result.ok).toBe(true);
    expect(fleet.get(instance.id).toolsPreset).toBe('full');
  });
});
