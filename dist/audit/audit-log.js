import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { logger } from '../core/logger.js';
/**
 * Append-only JSONL audit log, also kept in a ring buffer for fast recent reads.
 */
export class AuditLog {
    buffer = [];
    maxBuffer = 500;
    filePath;
    constructor(projectRoot) {
        this.filePath = join(projectRoot, '.folderforge', 'audit', 'audit.jsonl');
        try {
            mkdirSync(dirname(this.filePath), { recursive: true });
        }
        catch (err) {
            logger.warn({ err: String(err) }, 'Could not create audit directory');
        }
    }
    record(event) {
        const full = { ts: new Date().toISOString(), ...event };
        this.buffer.push(full);
        if (this.buffer.length > this.maxBuffer)
            this.buffer.shift();
        try {
            appendFileSync(this.filePath, JSON.stringify(full) + '\n', 'utf8');
        }
        catch (err) {
            logger.warn({ err: String(err) }, 'Failed to append audit event');
        }
        return full;
    }
    recent(limit = 50) {
        return this.buffer.slice(-limit).reverse();
    }
    exportPath() {
        return this.filePath;
    }
    exportRaw() {
        if (existsSync(this.filePath)) {
            return readFileSync(this.filePath, 'utf8');
        }
        return this.buffer.map((e) => JSON.stringify(e)).join('\n');
    }
}
