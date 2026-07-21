import { describe, it, expect } from 'vitest';
import { dirname } from 'node:path';
import { loadConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { buildRegistry } from '../../src/tools/index.js';
import type { ToolResult } from '../../src/core/types.js';
import { TS_FIXTURE, PY_FIXTURE } from './fixtures.js';

function setup() {
  const config = loadConfig({ projectRoot: TS_FIXTURE });
  // Allow both fixtures (their common parent) so multiple projects can activate.
  config.workspace.allowedDirectories = [dirname(TS_FIXTURE)];
  config.policy.defaultMode = 'dev';
  const container = new Container(config);
  container.policy.setMode('dev');
  const registry = buildRegistry(container);
  return { container, registry };
}

function data<T = any>(res: ToolResult): T {
  expect(res.ok).toBe(true);
  return res.data as T;
}

describe('multi-project sessions', () => {
  it('activates two workspaces and lists both', async () => {
    const { registry } = setup();
    data(await registry.call('workspace_activate', { path: TS_FIXTURE }));
    data(await registry.call('workspace_activate', { path: PY_FIXTURE }));

    const list = data<{ workspaces: Array<{ root: string; current: boolean }> }>(
      await registry.call('workspace_list', {})
    ).workspaces;
    expect(list.length).toBe(2);
    // The most recently activated (PY) is current.
    const current = list.find((w) => w.current);
    expect(current?.root).toBe(PY_FIXTURE);
  });

  it('switches the current workspace', async () => {
    const { container, registry } = setup();
    await registry.call('workspace_activate', { path: TS_FIXTURE });
    await registry.call('workspace_activate', { path: PY_FIXTURE });

    data(await registry.call('workspace_switch', { path: TS_FIXTURE }));
    expect(container.workspace.projectRoot()).toBe(TS_FIXTURE);
  });

  it('refuses to switch to a non-activated workspace', async () => {
    const { registry } = setup();
    await registry.call('workspace_activate', { path: TS_FIXTURE });
    const res = await registry.call('workspace_switch', { path: PY_FIXTURE });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not activated/i);
  });

  it('deactivating the current workspace falls back to the most recent', async () => {
    const { container, registry } = setup();
    await registry.call('workspace_activate', { path: TS_FIXTURE });
    await registry.call('workspace_activate', { path: PY_FIXTURE });
    // PY is current; deactivate it -> TS becomes current.
    data(await registry.call('workspace_deactivate', { path: PY_FIXTURE }));
    expect(container.workspace.projectRoot()).toBe(TS_FIXTURE);
  });

  it('keeps separate memory stores per workspace', async () => {
    const { container, registry } = setup();
    await registry.call('workspace_activate', { path: TS_FIXTURE });
    await registry.call('workspace_activate', { path: PY_FIXTURE });
    const tsMem = container.workspace.getMemoryFor(TS_FIXTURE);
    const pyMem = container.workspace.getMemoryFor(PY_FIXTURE);
    expect(tsMem).not.toBe(pyMem);
  });
});
