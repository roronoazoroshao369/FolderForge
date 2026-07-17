import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      expect(manager.activate(child).projectRoot).toBe(child);
      expect(() => manager.activate(prefixSibling)).toThrow(/not within allowed directories/i);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
