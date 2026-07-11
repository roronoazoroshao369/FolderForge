import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/core/config.js';
import { Container } from '../../src/core/container.js';
import { buildRegistry } from '../../src/tools/index.js';
import type { ToolResult, PolicyMode } from '../../src/core/types.js';

/**
 * Q8 - file integration tests.
 *
 * Exercises the read/write/edit/delete file tools end-to-end through
 * `registry.call()` against a throwaway workspace, including the policy gates
 * (readonly blocks writes; delete requires approval in safe mode) and the
 * path-escape guard.
 */

function setup(projectRoot: string, mode: PolicyMode = 'dev') {
  const config = loadConfig({ projectRoot });
  config.policy.defaultMode = mode;
  const container = new Container(config);
  container.policy.setMode(mode);
  const registry = buildRegistry(container);
  return { container, registry };
}

function data<T = Record<string, unknown>>(res: ToolResult): T {
  expect(res.ok).toBe(true);
  return res.data as T;
}

describe('file tools integration (Q8)', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'ff-file-'));
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'src', 'hello.txt'), 'hello world\nline two\n');
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('reads an existing file', async () => {
    const { registry } = setup(ws);
    await registry.call('workspace_activate', { path: ws });
    const res = data<{ content: string }>(
      await registry.call('file_read', { path: 'src/hello.txt' })
    );
    expect(res.content).toContain('hello world');
  });

  it('honors offset/limit when reading', async () => {
    const { registry } = setup(ws);
    await registry.call('workspace_activate', { path: ws });
    const res = data<{ content: string }>(
      await registry.call('file_read', { path: 'src/hello.txt', offset: 1, limit: 1 })
    );
    expect(res.content).toBe('line two');
  });

  it('writes a new file and returns a diff', async () => {
    const { registry } = setup(ws);
    await registry.call('workspace_activate', { path: ws });
    const res = await registry.call('file_write', {
      path: 'src/new.txt',
      content: 'created\n',
    });
    expect(res.ok).toBe(true);
    expect(res.diff).toBeTruthy();
    expect(readFileSync(join(ws, 'src', 'new.txt'), 'utf8')).toBe('created\n');
  });

  it('edits an exact block and refuses on occurrence mismatch', async () => {
    const { registry } = setup(ws);
    await registry.call('workspace_activate', { path: ws });

    const ok = await registry.call('file_edit_block', {
      path: 'src/hello.txt',
      oldText: 'hello world',
      newText: 'goodbye world',
    });
    expect(ok.ok).toBe(true);
    expect(readFileSync(join(ws, 'src', 'hello.txt'), 'utf8')).toContain('goodbye world');

    const mismatch = await registry.call('file_edit_block', {
      path: 'src/hello.txt',
      oldText: 'not present',
      newText: 'x',
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.error).toMatch(/not found/i);
  });

  it('returns nearest-context diagnostics without fuzzy-applying a patch', async () => {
    const { registry } = setup(ws);
    await registry.call('workspace_activate', { path: ws });
    const before = readFileSync(join(ws, 'src', 'hello.txt'), 'utf8');

    const result = await registry.call('file_patch', {
      path: 'src/hello.txt',
      oldText: 'hello   world\nline two',
      newText: 'must not apply',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/whitespace-normalized text matches/i);
    expect(result.data).toMatchObject({
      reason: 'context_not_found',
      diagnostic: {
        whitespaceNormalizedMatch: true,
        nearest: { startLine: 1 },
      },
    });
    expect(readFileSync(join(ws, 'src', 'hello.txt'), 'utf8')).toBe(before);
  });

  it('reads many files in one call', async () => {
    const { registry } = setup(ws);
    await registry.call('workspace_activate', { path: ws });
    writeFileSync(join(ws, 'src', 'second.txt'), 'two\n');
    const res = data<{ files: Record<string, string> }>(
      await registry.call('file_read_many', {
        paths: ['src/hello.txt', 'src/second.txt'],
      })
    );
    expect(res.files['src/hello.txt']).toContain('hello world');
    expect(res.files['src/second.txt']).toContain('two');
  });

  it('blocks writes in readonly mode', async () => {
    const { registry } = setup(ws, 'readonly');
    await registry.call('workspace_activate', { path: ws }).catch(() => undefined);
    const res = await registry.call('file_write', { path: 'src/nope.txt', content: 'x' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/readonly/i);
    expect(existsSync(join(ws, 'src', 'nope.txt'))).toBe(false);
  });

  it('requires approval for delete in safe mode and leaves the file intact', async () => {
    const { registry } = setup(ws, 'safe');
    await registry.call('workspace_activate', { path: ws });
    const res = await registry.call('file_delete', { path: 'src/hello.txt' });
    expect(res.ok).toBe(false);
    expect(res.approvalId).toBeTruthy();
    expect(existsSync(join(ws, 'src', 'hello.txt'))).toBe(true);
  });

  it('deletes a file in danger mode', async () => {
    const { registry } = setup(ws, 'danger');
    await registry.call('workspace_activate', { path: ws });
    data(await registry.call('file_delete', { path: 'src/hello.txt' }));
    expect(existsSync(join(ws, 'src', 'hello.txt'))).toBe(false);
  });

  it('refuses to escape the workspace root', async () => {
    const { registry } = setup(ws);
    await registry.call('workspace_activate', { path: ws });
    const res = await registry.call('file_read', { path: '../../etc/passwd' });
    expect(res.ok).toBe(false);
  });

  it('lists a directory non-recursively', async () => {
    const { registry } = setup(ws);
    await registry.call('workspace_activate', { path: ws });
    const res = data<{ entries: Array<{ path: string; type: string }>; count: number }>(
      await registry.call('list_directory', { path: 'src' })
    );
    const names = res.entries.map((e) => e.path);
    expect(names).toContain('src/hello.txt');
    expect(res.entries.find((e) => e.path === 'src/hello.txt')?.type).toBe('file');
  });

  it('lists a directory recursively and reports directories', async () => {
    const { registry } = setup(ws);
    await registry.call('workspace_activate', { path: ws });
    mkdirSync(join(ws, 'src', 'nested'), { recursive: true });
    writeFileSync(join(ws, 'src', 'nested', 'deep.txt'), 'deep\n');
    const res = data<{ entries: Array<{ path: string; type: string }> }>(
      await registry.call('list_directory', { path: 'src', recursive: true })
    );
    const names = res.entries.map((e) => e.path);
    expect(names).toContain('src/nested');
    expect(names).toContain('src/nested/deep.txt');
    expect(res.entries.find((e) => e.path === 'src/nested')?.type).toBe('dir');
  });

  it('moves a file and refuses to overwrite without the flag', async () => {
    const { registry } = setup(ws);
    await registry.call('workspace_activate', { path: ws });
    data(await registry.call('file_move', { from: 'src/hello.txt', to: 'src/moved.txt' }));
    expect(existsSync(join(ws, 'src', 'hello.txt'))).toBe(false);
    expect(existsSync(join(ws, 'src', 'moved.txt'))).toBe(true);

    writeFileSync(join(ws, 'src', 'other.txt'), 'other\n');
    const blocked = await registry.call('file_move', { from: 'src/other.txt', to: 'src/moved.txt' });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/exists/i);
  });

  it('copies a file and a directory recursively', async () => {
    const { registry } = setup(ws);
    await registry.call('workspace_activate', { path: ws });
    data(await registry.call('file_copy', { from: 'src/hello.txt', to: 'src/copy.txt' }));
    expect(existsSync(join(ws, 'src', 'hello.txt'))).toBe(true);
    expect(readFileSync(join(ws, 'src', 'copy.txt'), 'utf8')).toContain('hello world');

    const dirRes = data<{ directory: boolean }>(
      await registry.call('file_copy', { from: 'src', to: 'src-copy' })
    );
    expect(dirRes.directory).toBe(true);
    expect(existsSync(join(ws, 'src-copy', 'hello.txt'))).toBe(true);
  });

  it('refuses to move outside the workspace root', async () => {
    const { registry } = setup(ws);
    await registry.call('workspace_activate', { path: ws });
    const res = await registry.call('file_move', { from: 'src/hello.txt', to: '../escape.txt' });
    expect(res.ok).toBe(false);
  });
});
