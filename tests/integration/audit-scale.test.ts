import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../src/audit/event-types.js';
import { createAuditEnvelope } from '../../src/evidence/audit-chain.js';
import { FileAuditStore } from '../../src/evidence/file-audit-store.js';

// Operator-scale regression (production incident: a long-lived control plane
// accumulated a ~64 MB chain, and every append re-read and re-verified it —
// seconds of synchronous CPU per event, starving the dashboard HTTP server).
// Appends must stay fast (O(1) tail cache) and correct at this scale.

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'folderforge-audit-scale-'));
  roots.push(path);
  return path;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function event(index: number): AuditEvent {
  return {
    ts: new Date(index * 1000).toISOString(),
    type: 'tool_call',
    tool: `tool_${index}`,
    detail: { index },
  };
}

describe('FileAuditStore at operator scale', () => {
  it('keeps appends fast and correct on a 20k-record chain', () => {
    const dir = root();
    const auditDir = join(dir, '.folderforge', 'audit');
    mkdirSync(auditDir, { recursive: true });

    // Build a 20,000-record chain in one bulk write (no per-record locking).
    const lines: string[] = [];
    let previousHash: string | null = null;
    for (let index = 1; index <= 20_000; index += 1) {
      const envelope = createAuditEnvelope(
        event(index),
        index,
        previousHash,
        { kind: 'native-v2' },
        undefined,
      );
      previousHash = envelope.recordHash;
      lines.push(JSON.stringify(envelope));
    }
    writeFileSync(join(auditDir, 'audit.v2.jsonl'), `${lines.join('\n')}\n`, { mode: 0o600 });

    const store = new FileAuditStore(dir);
    const startedAt = Date.now();
    let last = 0;
    for (let index = 1; index <= 25; index += 1) {
      last = store.append(event(20_000 + index), { required: false }).sequence;
    }
    const totalMs = Date.now() - startedAt;

    // One full parse for the first append, then O(1) tail-cache appends.
    // The pre-fix O(n)-per-append behaviour would take tens of seconds here.
    expect(totalMs).toBeLessThan(15_000);
    expect(last).toBe(20_025);
    expect(store.verify().ok).toBe(true);
  }, 60_000);
});
