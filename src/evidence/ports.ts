import type { AuditEvent } from '../audit/event-types.js';

export interface AuditAppendOptions {
  required: boolean;
}

export interface AuditVerificationIssue {
  line: number;
  code:
    | 'invalid_json'
    | 'invalid_schema'
    | 'invalid_sequence'
    | 'invalid_previous_hash'
    | 'invalid_record_hash'
    | 'unknown_signer'
    | 'invalid_signature';
  message: string;
}

export interface AuditVerificationReport {
  ok: boolean;
  schemaVersion: 2;
  records: number;
  headHash: string | null;
  signedRecords: number;
  verifiedSignatures: number;
  unverifiedSignatures: number;
  issues: AuditVerificationIssue[];
}

export interface AuditRecordSource {
  kind: 'native-v2' | 'legacy-v1-import';
  legacyFileSha256?: string;
  legacyLine?: number;
  migratedAt?: string;
}

export interface AuditSignature {
  algorithm: 'ed25519';
  keyId: string;
  value: string;
}

export interface AuditEnvelopeV2 {
  schemaVersion: 2;
  sequence: number;
  previousHash: string | null;
  event: AuditEvent;
  source: AuditRecordSource;
  recordHash: string;
  signature?: AuditSignature;
}

export interface AuditStore {
  readonly filePath: string;
  preflight(required: boolean): void;
  append(event: AuditEvent, options: AuditAppendOptions): AuditEnvelopeV2;
  verify(): AuditVerificationReport;
  readRaw(): string;
}

export interface SnapshotStore<T extends { id: string }> {
  load(): T[];
  append(record: T): void;
  replaceAll(records: T[]): void;
}

export interface RecordStore<T> {
  load(): T[];
  write(id: string, record: T): void;
  delete(id: string): void;
}

export interface ArtifactStorePort<TMetadata = unknown> {
  put(
    data: Buffer,
    mimeType: string,
    details?: { sourceTool?: string; label?: string },
  ): TMetadata;
  list(limit?: number, offset?: number): TMetadata[];
  metadata(id: string): TMetadata;
  read(id: string): { metadata: TMetadata; data: Buffer };
  delete(id: string): TMetadata;
}
