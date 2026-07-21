import { createHash } from 'node:crypto';
import type { AuditEvent } from '../audit/event-types.js';
import { createAuditEnvelope } from './audit-chain.js';
import type { AuditEnvelopeV2 } from './ports.js';

export interface LegacyAuditVerificationReport {
  ok: boolean;
  records: number;
  sha256: string;
  issues: Array<{ line: number; message: string }>;
}

export interface LegacyAuditMigrationResult {
  source: LegacyAuditVerificationReport;
  envelopes: AuditEnvelopeV2[];
  jsonl: string;
  historicalIntegrityClaimed: false;
}

export function verifyLegacyAuditLog(raw: string): LegacyAuditVerificationReport {
  const issues: Array<{ line: number; message: string }> = [];
  let records = 0;
  if (raw.length > 0 && !raw.endsWith('\n')) {
    issues.push({
      line: Math.max(1, raw.split(/\r?\n/).length),
      message: 'Legacy audit log ends with an incomplete JSONL record.',
    });
  }
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const lineNumber = index + 1;
    try {
      const event = JSON.parse(line) as Partial<AuditEvent>;
      if (
        !event ||
        typeof event !== 'object' ||
        typeof event.ts !== 'string' ||
        typeof event.type !== 'string'
      ) {
        issues.push({ line: lineNumber, message: 'Legacy audit event schema is invalid.' });
        continue;
      }
      records += 1;
    } catch (error) {
      issues.push({
        line: lineNumber,
        message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return {
    ok: issues.length === 0,
    records,
    sha256: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
    issues,
  };
}

export function migrateLegacyAuditLog(
  raw: string,
  migratedAt = new Date().toISOString(),
): LegacyAuditMigrationResult {
  const source = verifyLegacyAuditLog(raw);
  if (!source.ok) {
    const issue = source.issues[0];
    throw new Error(
      issue
        ? `Legacy audit verification failed at line ${issue.line}: ${issue.message}`
        : 'Legacy audit verification failed.',
    );
  }
  const envelopes: AuditEnvelopeV2[] = [];
  let previousHash: string | null = null;
  let sequence = 1;
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const event = JSON.parse(line) as AuditEvent;
    const envelope = createAuditEnvelope(event, sequence, previousHash, {
      kind: 'legacy-v1-import',
      legacyFileSha256: source.sha256,
      legacyLine: index + 1,
      migratedAt,
    });
    envelopes.push(envelope);
    previousHash = envelope.recordHash;
    sequence += 1;
  }
  return {
    source,
    envelopes,
    jsonl: envelopes.length > 0 ? `${envelopes.map((item) => JSON.stringify(item)).join('\n')}\n` : '',
    historicalIntegrityClaimed: false,
  };
}
