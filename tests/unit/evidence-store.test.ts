import { generateKeyPairSync } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../src/audit/event-types.js';
import {
  createAuditEnvelope,
  createEd25519Signer,
  verifyAuditChain,
} from '../../src/evidence/audit-chain.js';
import { FileAuditStore } from '../../src/evidence/file-audit-store.js';
import {
  migrateLegacyAuditLog,
  verifyLegacyAuditLog,
} from '../../src/evidence/migration.js';

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'folderforge-evidence-'));
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

function chain(count = 4): string {
  const records = [];
  let previousHash: string | null = null;
  for (let index = 1; index <= count; index += 1) {
    const record = createAuditEnvelope(event(index), index, previousHash);
    records.push(record);
    previousHash = record.recordHash;
  }
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function lines(raw: string): Array<Record<string, unknown>> {
  return raw
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function jsonl(records: Array<Record<string, unknown>>): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('tamper-evident audit store', () => {
  it('persists a monotonic hash chain through the AuditStore port', () => {
    const projectRoot = root();
    const store = new FileAuditStore(projectRoot);
    store.preflight(true);
    store.append(event(1), { required: true });
    store.append(event(2), { required: true });

    const report = store.verify();
    expect(report).toMatchObject({
      ok: true,
      schemaVersion: 2,
      records: 2,
      headHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    const persisted = lines(readFileSync(store.filePath, 'utf8'));
    expect(persisted[0]).toMatchObject({
      schemaVersion: 2,
      sequence: 1,
      previousHash: null,
      source: { kind: 'native-v2' },
    });
    expect(persisted[1]).toMatchObject({
      sequence: 2,
      previousHash: persisted[0]?.recordHash,
    });
  });

  it('detects modification', () => {
    const records = lines(chain());
    (records[1]?.event as Record<string, unknown>).tool = 'tampered';
    const report = verifyAuditChain(jsonl(records));
    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'invalid_record_hash', line: 2 })]),
    );
  });

  it('detects deletion', () => {
    const records = lines(chain());
    records.splice(1, 1);
    const report = verifyAuditChain(jsonl(records));
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['invalid_sequence', 'invalid_previous_hash']),
    );
  });

  it('detects insertion', () => {
    const records = lines(chain());
    records.splice(2, 0, structuredClone(records[1]!));
    const report = verifyAuditChain(jsonl(records));
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['invalid_sequence', 'invalid_previous_hash']),
    );
  });

  it('detects reordering', () => {
    const records = lines(chain());
    [records[1], records[2]] = [records[2]!, records[1]!];
    const report = verifyAuditChain(jsonl(records));
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['invalid_sequence', 'invalid_previous_hash']),
    );
  });

  it('verifies optional Ed25519 signatures and rejects the wrong key', () => {
    const signing = generateKeyPairSync('ed25519');
    const wrong = generateKeyPairSync('ed25519');
    const signer = createEd25519Signer('operator-1', signing.privateKey);
    const envelope = createAuditEnvelope(event(1), 1, null, { kind: 'native-v2' }, signer);
    const raw = `${JSON.stringify(envelope)}\n`;

    expect(
      verifyAuditChain(raw, {
        publicKeys: new Map([['operator-1', signing.publicKey]]),
      }),
    ).toMatchObject({
      ok: true,
      signedRecords: 1,
      verifiedSignatures: 1,
      unverifiedSignatures: 0,
    });
    const invalid = verifyAuditChain(raw, {
      publicKeys: new Map([['operator-1', wrong.publicKey]]),
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'invalid_signature' })]),
    );
  });

  it('reports an unknown signer without invalidating the hash chain', () => {
    const signing = generateKeyPairSync('ed25519');
    const envelope = createAuditEnvelope(
      event(1),
      1,
      null,
      { kind: 'native-v2' },
      createEd25519Signer('unknown-key', signing.privateKey),
    );
    const report = verifyAuditChain(`${JSON.stringify(envelope)}\n`);
    expect(report).toMatchObject({ ok: true, unverifiedSignatures: 1 });
    expect(report.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'unknown_signer' })]),
    );
  });

  it('migrates legacy JSONL non-destructively without claiming historical integrity', () => {
    const legacy = `${JSON.stringify(event(1))}\n${JSON.stringify(event(2))}\n`;
    const migrated = migrateLegacyAuditLog(legacy, '2026-07-20T00:00:00.000Z');
    expect(migrated).toMatchObject({
      historicalIntegrityClaimed: false,
      source: { ok: true, records: 2 },
    });
    expect(verifyAuditChain(migrated.jsonl)).toMatchObject({ ok: true, records: 2 });
    expect(migrated.envelopes[0]).toMatchObject({
      source: {
        kind: 'legacy-v1-import',
        legacyFileSha256: migrated.source.sha256,
        legacyLine: 1,
        migratedAt: '2026-07-20T00:00:00.000Z',
      },
    });
  });

  it('refuses corrupt legacy input instead of skipping lines', () => {
    const raw = `${JSON.stringify(event(1))}\n{not-json}\n`;
    expect(verifyLegacyAuditLog(raw)).toMatchObject({
      ok: false,
      records: 1,
      issues: [expect.objectContaining({ line: 2 })],
    });
    expect(() => migrateLegacyAuditLog(raw)).toThrow(/line 2/i);
  });

  it('refuses required startup after a persisted envelope is modified', () => {
    const projectRoot = root();
    const store = new FileAuditStore(projectRoot);
    store.preflight(true);
    store.append(event(1), { required: true });
    const records = lines(readFileSync(store.filePath, 'utf8'));
    (records[0]?.event as Record<string, unknown>).tool = 'tampered';
    writeFileSync(store.filePath, jsonl(records));

    expect(() => new FileAuditStore(projectRoot).preflight(true)).toThrow(
      /integrity failed at line 1/i,
    );
  });
});
