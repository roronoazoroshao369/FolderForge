import { describe, it, expect } from 'vitest';
import { dirname } from 'node:path';
import { loadConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { buildRegistry } from '../../src/tools/index.js';
import type { ToolResult } from '../../src/core/types.js';
import { PY_FIXTURE, TS_FIXTURE, isolatedFixture } from './fixtures.js';

function setup() {
  // Activating a workspace writes runtime state into it, so each test gets its
  // own throwaway copy of both fixtures instead of mutating the shared ones.
  const tsRoot = isolatedFixture(TS_FIXTURE);
  const pyRoot = isolatedFixture(PY_FIXTURE);
  const config = loadConfig({ projectRoot: tsRoot });
  // Both copies share the OS temp directory as their common parent.
  config.workspace.allowedDirectories = [dirname(tsRoot)];
  config.policy.defaultMode = 'dev';
  const container = new Container(config);
  container.policy.setMode('dev');
  const registry = buildRegistry(container);
  return { container, registry, tsRoot, pyRoot };
}

function data<T = any>(res: ToolResult): T {
  expect(res.ok).toBe(true);
  return res.data as T;
}

describe('multi-project sessions', () => {
  it('activates two workspaces and lists both', async () => {
    const { registry, tsRoot, pyRoot } = setup();
    data(await registry.call('workspace_activate', { path: tsRoot }));
    data(await registry.call('workspace_activate', { path: pyRoot }));

    const list = data<{ workspaces: Array<{ root: string; current: boolean }> }>(
      await registry.call('workspace_list', {})
    ).workspaces;
    expect(list.length).toBe(2);
    // The most recently activated (PY) is current.
    const current = list.find((w) => w.current);
    expect(current?.root).toBe(pyRoot);
  });

  it('switches the current workspace', async () => {
    const { container, registry, tsRoot, pyRoot } = setup();
    await registry.call('workspace_activate', { path: tsRoot });
    await registry.call('workspace_activate', { path: pyRoot });

    data(await registry.call('workspace_switch', { path: tsRoot }));
    expect(container.workspace.projectRoot()).toBe(tsRoot);
  });

  it('refuses to switch to a non-activated workspace', async () => {
    const { registry, tsRoot, pyRoot } = setup();
    await registry.call('workspace_activate', { path: tsRoot });
    const res = await registry.call('workspace_switch', { path: pyRoot });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not activated/i);
  });

  it('deactivating the current workspace falls back to the most recent', async () => {
    const { container, registry, tsRoot, pyRoot } = setup();
    await registry.call('workspace_activate', { path: tsRoot });
    await registry.call('workspace_activate', { path: pyRoot });
    // PY is current; deactivate it -> TS becomes current.
    data(await registry.call('workspace_deactivate', { path: pyRoot }));
    expect(container.workspace.projectRoot()).toBe(tsRoot);
  });

  it('keeps separate memory stores per workspace', async () => {
    const { container, registry, tsRoot, pyRoot } = setup();
    await registry.call('workspace_activate', { path: tsRoot });
    await registry.call('workspace_activate', { path: pyRoot });
    const tsMem = container.workspace.getMemoryFor(tsRoot);
    const pyMem = container.workspace.getMemoryFor(pyRoot);
    expect(tsMem).not.toBe(pyMem);
  });
});
