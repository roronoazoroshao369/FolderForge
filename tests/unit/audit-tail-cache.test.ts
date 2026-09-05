import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../src/audit/event-types.js';
import { FileAuditStore } from '../../src/evidence/file-audit-store.js';

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'folderforge-audit-tail-'));
  roots.push(path);
  return path;
}

function event(index: number): AuditEvent {
  return {
    ts: new Date(index * 1000).toISOString(),
    type: 'tool_call',
    tool: `tool_${index}`,
    detail: { index },
  };
}

function auditFile(dir: string): string {
  return join(dir, '.folderforge', 'audit', 'audit.v2.jsonl');
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe('FileAuditStore append tail cache', () => {
  it('re-reads the chain file once, then serves appends from the tail cache', () => {
    const dir = root();
    const seed = new FileAuditStore(dir);
    seed.append(event(1), { required: false });
    seed.append(event(2), { required: false });

    let chainReads = 0;
    const store = new FileAuditStore(dir, {
      fileSystem: {
        readFileSync: ((...args: unknown[]) => {
          const [path, options] = args as [string, 'utf8'];
          if (path.endsWith('audit.v2.jsonl')) chainReads += 1;
          return readFileSync(path, options);
        }) as unknown as typeof readFileSync,
      },
    });

    const third = store.append(event(3), { required: false });
    const fourth = store.append(event(4), { required: false });
    const fifth = store.append(event(5), { required: false });

    expect(third.sequence).toBe(3);
    expect(fourth.sequence).toBe(4);
    expect(fifth.sequence).toBe(5);
    expect(chainReads).toBe(1);
    expect(store.verify().ok).toBe(true);
  });

  it('re-verifies the chain and refuses to append after external tampering', () => {
    const dir = root();
    const store = new FileAuditStore(dir);
    store.append(event(1), { required: false });

    appendFileSync(auditFile(dir), '{"tampered":true}\n');

    expect(() => store.append(event(2), { required: false })).toThrow(
      /Audit chain integrity failed/,
    );
  });

  it('stays correct when another writer instance appends in between', () => {
    const dir = root();
    const first = new FileAuditStore(dir);
    const second = new FileAuditStore(dir);

    const e1 = first.append(event(1), { required: false });
    const e2 = second.append(event(2), { required: false });
    const e3 = first.append(event(3), { required: false });
    const e4 = second.append(event(4), { required: false });

    expect([e1.sequence, e2.sequence, e3.sequence, e4.sequence]).toEqual([1, 2, 3, 4]);
    expect(first.verify().ok).toBe(true);
  });

  it('starts a fresh chain when the file is removed externally', () => {
    const dir = root();
    const store = new FileAuditStore(dir);
    store.append(event(1), { required: false });

    rmSync(auditFile(dir));

    const next = store.append(event(2), { required: false });
    expect(next.sequence).toBe(1);
    expect(store.verify().ok).toBe(true);
  });
});

describe('FileAuditStore size-based rotation', () => {
  it('rotates the live chain aside once it exceeds the size budget and starts fresh', () => {
    const dir = root();
    let tick = 1_700_000_000_000;
    const store = new FileAuditStore(dir, { maxFileBytes: 200, now: () => (tick += 1_000) });

    store.append(event(1), { required: false }); // live chain now exceeds 200 bytes
    const second = store.append(event(2), { required: false }); // rotates first, then appends
    expect(second.sequence).toBe(1);

    const third = store.append(event(3), { required: false }); // exceeds budget again -> second archive
    expect(third.sequence).toBe(1);

    const files = readdirSync(join(dir, '.folderforge', 'audit')).sort();
    const archives = files.filter((name) => /^audit\.v2\.\d{4}-/.test(name));
    expect(archives.length).toBeGreaterThanOrEqual(2);
    expect(files).toContain('audit.v2.jsonl');
    expect(store.verify().ok).toBe(true);
  });

  it('never rotates while the live chain is within budget', () => {
    const dir = root();
    const store = new FileAuditStore(dir, { maxFileBytes: 1_000_000 });
    store.append(event(1), { required: false });
    store.append(event(2), { required: false });
    const third = store.append(event(3), { required: false });

    expect(third.sequence).toBe(3);
    const files = readdirSync(join(dir, '.folderforge', 'audit'));
    expect(files.filter((name) => /^audit\.v2\.\d{4}-/.test(name))).toHaveLength(0);
    expect(store.verify().ok).toBe(true);
  });
});
