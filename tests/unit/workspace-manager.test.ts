import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceManager } from '../../src/workspace/workspace-manager.js';

describe('WorkspaceManager path boundaries', () => {
  it('allows descendants but rejects prefix-sibling directories', () => {
    const temp = mkdtempSync(join(tmpdir(), 'folderforge-workspace-'));
    const allowedRoot = join(temp, 'project');
    const child = join(allowedRoot, 'service');
    const prefixSibling = join(temp, 'project-escape');
    mkdirSync(child, { recursive: true });
    mkdirSync(prefixSibling, { recursive: true });

    try {
      const manager = new WorkspaceManager([allowedRoot]);
      expect(manager.activate(child).projectRoot).toBe(resolve(child));
      expect(() => manager.activate(prefixSibling)).toThrow(/not within allowed directories/i);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('keeps a lexical display path while aliases share one canonical workspace identity', () => {
    const temp = mkdtempSync(join(tmpdir(), 'folderforge-workspace-alias-'));
    const target = join(temp, 'target');
    const alias = join(temp, 'alias');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');

    try {
      const manager = new WorkspaceManager([alias]);
      const first = manager.activate(alias);
      const aliasMemory = manager.getMemoryFor(alias);

      expect(first.projectRoot).toBe(resolve(alias));
      expect(manager.list()).toMatchObject([{ root: resolve(alias), current: true }]);
      expect(manager.getMemoryFor(target)).toBe(aliasMemory);

      manager.activate(target);
      expect(manager.list()).toHaveLength(1);
      expect(manager.list()[0]?.root).toBe(resolve(alias));
      expect(manager.deactivate(target)).toBe(true);
      expect(manager.list()).toEqual([]);
    } finally {
      rmSync(alias, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
