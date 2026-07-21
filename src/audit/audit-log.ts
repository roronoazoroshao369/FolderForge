import type { AuditConfig, RiskLevel, ToolPrincipal } from '../core/types.js';
import { AuditUnavailableError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import type { AuditEvent } from './event-types.js';
import {
  FileAuditStore,
  type AuditFileSystem,
} from '../evidence/file-audit-store.js';
import type {
  AuditStore,
  AuditVerificationReport,
} from '../evidence/ports.js';

export type { AuditFileSystem } from '../evidence/file-audit-store.js';

export interface AuditRecordOptions {
  /** Override the configured baseline for this individual event. */
  required?: boolean;
}

export interface AuditRequirementContext {
  risk?: RiskLevel;
  principal?: ToolPrincipal;
}

const DEFAULT_AUDIT_CONFIG: AuditConfig = {
  durability: 'best-effort',
  requireForHighRisk: true,
  requireForAuthenticatedHttp: true,
};

/**
 * Governed audit facade. Runtime callers receive plain AuditEvent objects while
 * the storage port persists versioned, hash-chained envelopes.
 */
export class AuditLog {
  private readonly buffer: AuditEvent[] = [];
  private readonly maxBuffer = 500;
  private readonly config: AuditConfig;
  private readonly store: AuditStore;

  constructor(
    projectRoot: string,
    config: AuditConfig = DEFAULT_AUDIT_CONFIG,
    fileSystem: Partial<AuditFileSystem> = {},
    store?: AuditStore,
  ) {
    this.config = { ...config };
    this.store =
      store ?? new FileAuditStore(projectRoot, { fileSystem });
    this.preflight();
  }

  requiresDurability(context: AuditRequirementContext = {}): boolean {
    if (this.config.durability === 'required') return true;
    if (
      this.config.requireForHighRisk &&
      (context.risk === 'HIGH' || context.risk === 'CRITICAL')
    ) {
      return true;
    }
    return Boolean(
      this.config.requireForAuthenticatedHttp &&
        (context.principal?.authMode === 'token' ||
          context.principal?.authMode === 'oauth'),
    );
  }

  preflight(options: AuditRecordOptions = {}): void {
    const required = options.required ?? this.config.durability === 'required';
    try {
      this.store.preflight(required);
    } catch (error) {
      this.handleFailure(error, required, 'Audit storage preflight failed');
    }
  }

  record(
    event: Omit<AuditEvent, 'ts'>,
    options: AuditRecordOptions = {},
  ): AuditEvent {
    const required = options.required ?? this.config.durability === 'required';
    const full: AuditEvent = { ts: new Date().toISOString(), ...event };
    try {
      this.store.append(full, { required });
    } catch (error) {
      this.handleFailure(error, required, 'Failed to append audit event');
    }
    this.remember(full);
    return full;
  }

  recent(limit = 50): AuditEvent[] {
    return this.buffer.slice(-limit).reverse();
  }

  exportPath(): string {
    return this.store.filePath;
  }

  exportRaw(): string {
    return this.store.readRaw();
  }

  verify(): AuditVerificationReport {
    return this.store.verify();
  }

  private remember(event: AuditEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.maxBuffer) this.buffer.shift();
  }

  private handleFailure(
    error: unknown,
    required: boolean,
    message: string,
  ): void {
    const detail = { err: String(error), auditPath: this.store.filePath };
    if (required) {
      logger.error(detail, message);
      throw new AuditUnavailableError();
    }
    logger.warn(detail, message);
  }
}
