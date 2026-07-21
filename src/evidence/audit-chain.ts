import {
  createHash,
  sign as signBytes,
  verify as verifyBytes,
  type KeyLike,
} from 'node:crypto';
import type { AuditEvent } from '../audit/event-types.js';
import type {
  AuditEnvelopeV2,
  AuditRecordSource,
  AuditSignature,
  AuditVerificationIssue,
  AuditVerificationReport,
} from './ports.js';

export const AUDIT_SCHEMA_VERSION = 2 as const;
export const AUDIT_GENESIS_HASH = null;

export interface AuditSigner {
  keyId: string;
  sign(payload: Buffer): string;
}

export interface AuditVerificationOptions {
  publicKeys?: ReadonlyMap<string, KeyLike>;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function auditHashPayload(input: {
  schemaVersion: 2;
  sequence: number;
  previousHash: string | null;
  event: AuditEvent;
  source: AuditRecordSource;
}): Buffer {
  return Buffer.from(canonicalJson(input), 'utf8');
}

export function computeAuditRecordHash(input: {
  schemaVersion: 2;
  sequence: number;
  previousHash: string | null;
  event: AuditEvent;
  source: AuditRecordSource;
}): string {
  return `sha256:${createHash('sha256').update(auditHashPayload(input)).digest('hex')}`;
}

export function createEd25519Signer(keyId: string, privateKey: KeyLike): AuditSigner {
  if (!keyId.trim()) throw new Error('Audit signer keyId must not be empty.');
  return {
    keyId,
    sign(payload) {
      return signBytes(null, payload, privateKey).toString('base64');
    },
  };
}

export function createAuditEnvelope(
  event: AuditEvent,
  sequence: number,
  previousHash: string | null,
  source: AuditRecordSource = { kind: 'native-v2' },
  signer?: AuditSigner,
): AuditEnvelopeV2 {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('Audit sequence must be a positive safe integer.');
  }
  const hashInput = {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    sequence,
    previousHash,
    event,
    source,
  };
  const recordHash = computeAuditRecordHash(hashInput);
  const signature: AuditSignature | undefined = signer
    ? {
        algorithm: 'ed25519',
        keyId: signer.keyId,
        value: signer.sign(Buffer.from(recordHash, 'utf8')),
      }
    : undefined;
  return {
    ...hashInput,
    recordHash,
    ...(signature ? { signature } : {}),
  };
}

export function parseAuditChain(
  raw: string,
  options: AuditVerificationOptions = {},
): { envelopes: AuditEnvelopeV2[]; report: AuditVerificationReport } {
  const issues: AuditVerificationIssue[] = [];
  const envelopes: AuditEnvelopeV2[] = [];
  let expectedSequence = 1;
  let previousHash: string | null = AUDIT_GENESIS_HASH;
  let signedRecords = 0;
  let verifiedSignatures = 0;
  let unverifiedSignatures = 0;

  if (raw.length > 0 && !raw.endsWith('\n')) {
    issues.push({
      line: Math.max(1, raw.split(/\r?\n/).length),
      code: 'invalid_json',
      message: 'Audit chain ends with an incomplete JSONL record.',
    });
  }

  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const lineNumber = index + 1;
    let envelope: AuditEnvelopeV2;
    try {
      envelope = JSON.parse(line) as AuditEnvelopeV2;
    } catch (error) {
      issues.push({
        line: lineNumber,
        code: 'invalid_json',
        message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    if (
      envelope.schemaVersion !== AUDIT_SCHEMA_VERSION ||
      !envelope.event ||
      typeof envelope.event.ts !== 'string' ||
      typeof envelope.event.type !== 'string' ||
      !envelope.source ||
      !['native-v2', 'legacy-v1-import'].includes(envelope.source.kind)
    ) {
      issues.push({
        line: lineNumber,
        code: 'invalid_schema',
        message: 'Record does not match the audit envelope v2 schema.',
      });
      continue;
    }
    envelopes.push(envelope);

    if (envelope.sequence !== expectedSequence) {
      issues.push({
        line: lineNumber,
        code: 'invalid_sequence',
        message: `Expected sequence ${expectedSequence}, received ${String(envelope.sequence)}.`,
      });
    }
    if (envelope.previousHash !== previousHash) {
      issues.push({
        line: lineNumber,
        code: 'invalid_previous_hash',
        message: `Expected previousHash ${previousHash ?? 'null'}, received ${String(envelope.previousHash)}.`,
      });
    }

    const expectedHash = computeAuditRecordHash({
      schemaVersion: AUDIT_SCHEMA_VERSION,
      sequence: envelope.sequence,
      previousHash: envelope.previousHash,
      event: envelope.event,
      source: envelope.source,
    });
    if (envelope.recordHash !== expectedHash) {
      issues.push({
        line: lineNumber,
        code: 'invalid_record_hash',
        message: `Record hash mismatch; expected ${expectedHash}.`,
      });
    }

    if (envelope.signature) {
      signedRecords += 1;
      const publicKey = options.publicKeys?.get(envelope.signature.keyId);
      if (!publicKey) {
        unverifiedSignatures += 1;
        issues.push({
          line: lineNumber,
          code: 'unknown_signer',
          message: `No public key was supplied for signer ${envelope.signature.keyId}.`,
        });
      } else {
        let valid = false;
        try {
          valid = verifyBytes(
            null,
            Buffer.from(envelope.recordHash, 'utf8'),
            publicKey,
            Buffer.from(envelope.signature.value, 'base64'),
          );
        } catch {
          valid = false;
        }
        if (valid) verifiedSignatures += 1;
        else {
          issues.push({
            line: lineNumber,
            code: 'invalid_signature',
            message: `Ed25519 signature from ${envelope.signature.keyId} is invalid.`,
          });
        }
      }
    }

    expectedSequence = envelope.sequence + 1;
    previousHash = envelope.recordHash;
  }

  const hardIssues = issues.filter((issue) => issue.code !== 'unknown_signer');
  return {
    envelopes,
    report: {
      ok: hardIssues.length === 0,
      schemaVersion: AUDIT_SCHEMA_VERSION,
      records: envelopes.length,
      headHash: envelopes.at(-1)?.recordHash ?? null,
      signedRecords,
      verifiedSignatures,
      unverifiedSignatures,
      issues,
    },
  };
}

export function verifyAuditChain(
  raw: string,
  options: AuditVerificationOptions = {},
): AuditVerificationReport {
  return parseAuditChain(raw, options).report;
}
