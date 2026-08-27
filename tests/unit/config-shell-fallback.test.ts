import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/runtime/config.js';
import { defaultShell, resolveExistingShell } from '../../src/core/shell.js';

describe('shell fallback', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('a pinned terminal.shell that does not exist falls back to an installed shell', () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-shell-fallback-'));
    roots.push(root);
    mkdirSync(join(root, '.folderforge'), { recursive: true });
    writeFileSync(
      join(root, '.folderforge', 'config.yaml'),
      'terminal:\n  shell: /bin/definitely-missing-shell-folderforge\n',
      'utf8'
    );
    const cfg = loadConfig({ projectRoot: root });
    expect(cfg.terminal.shell).not.toBe('/bin/definitely-missing-shell-folderforge');
    expect(existsSync(cfg.terminal.shell)).toBe(true);
  });

  it('a pinned shell that exists is kept as-is', () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-shell-keep-'));
    roots.push(root);
    mkdirSync(join(root, '.folderforge'), { recursive: true });
    writeFileSync(join(root, '.folderforge', 'config.yaml'), 'terminal:\n  shell: /bin/sh\n', 'utf8');
    const cfg = loadConfig({ projectRoot: root });
    expect(cfg.terminal.shell).toBe('/bin/sh');
  });

  it('defaultShell ignores a stale SHELL env pointing at a missing binary', () => {
    const shell = defaultShell('linux', { SHELL: '/bin/definitely-missing-shell-folderforge' });
    expect(shell).not.toBe('/bin/definitely-missing-shell-folderforge');
    expect(existsSync(shell)).toBe(true);
  });

  it('resolveExistingShell reports whether it fell back', () => {
    expect(resolveExistingShell('/bin/sh').fellBack).toBe(false);
    const missing = resolveExistingShell('/bin/definitely-missing-shell-folderforge');
    expect(missing.fellBack).toBe(true);
    expect(existsSync(missing.shell)).toBe(true);
  });
});
