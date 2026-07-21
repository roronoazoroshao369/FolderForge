import { AuditUnavailableError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { FileAuditStore, } from '../evidence/file-audit-store.js';
const DEFAULT_AUDIT_CONFIG = {
    durability: 'best-effort',
    requireForHighRisk: true,
    requireForAuthenticatedHttp: true,
};
/**
 * Governed audit facade. Runtime callers receive plain AuditEvent objects while
 * the storage port persists versioned, hash-chained envelopes.
 */
export class AuditLog {
    buffer = [];
    maxBuffer = 500;
    config;
    store;
    constructor(projectRoot, config = DEFAULT_AUDIT_CONFIG, fileSystem = {}, store) {
        this.config = { ...config };
        this.store =
            store ?? new FileAuditStore(projectRoot, { fileSystem });
        this.preflight();
    }
    requiresDurability(context = {}) {
        if (this.config.durability === 'required')
            return true;
        if (this.config.requireForHighRisk &&
            (context.risk === 'HIGH' || context.risk === 'CRITICAL')) {
            return true;
        }
        return Boolean(this.config.requireForAuthenticatedHttp &&
            (context.principal?.authMode === 'token' ||
                context.principal?.authMode === 'oauth'));
    }
    preflight(options = {}) {
        const required = options.required ?? this.config.durability === 'required';
        try {
            this.store.preflight(required);
        }
        catch (error) {
            this.handleFailure(error, required, 'Audit storage preflight failed');
        }
    }
    record(event, options = {}) {
        const required = options.required ?? this.config.durability === 'required';
        const full = { ts: new Date().toISOString(), ...event };
        try {
            this.store.append(full, { required });
        }
        catch (error) {
            this.handleFailure(error, required, 'Failed to append audit event');
        }
        this.remember(full);
        return full;
    }
    recent(limit = 50) {
        return this.buffer.slice(-limit).reverse();
    }
    exportPath() {
        return this.store.filePath;
    }
    exportRaw() {
        return this.store.readRaw();
    }
    verify() {
        return this.store.verify();
    }
    remember(event) {
        this.buffer.push(event);
        if (this.buffer.length > this.maxBuffer)
            this.buffer.shift();
    }
    handleFailure(error, required, message) {
        const detail = { err: String(error), auditPath: this.store.filePath };
        if (required) {
            logger.error(detail, message);
            throw new AuditUnavailableError();
        }
        logger.warn(detail, message);
    }
}
