import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FolderForgeConfig } from '../core/types.js';

interface StoredLimits {
  schemaVersion: 1;
  defaultTimeoutMs: number;
  maxOutputBytes: number;
  updatedAt: string;
  updatedBy: string;
  integritySha256: string;
}

export interface RuntimeSettingsView {
  terminal: {
    defaultTimeoutMs: number;
    maxOutputBytes: number;
    envPolicy: string;
    sandbox: { mode: string; requireInDanger: boolean };
  };
  updatedAt?: string;
  updatedBy?: string;
}

const LIMITS = {
  timeout: { min: 1_000, max: 1_800_000 },
  output: { min: 1_024, max: 2_000_000 },
};

function validInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function checksum(input: Omit<StoredLimits, 'integritySha256'>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/** Operator-owned runtime limits; never changes authentication or sandbox containment. */
export class RuntimeSettings {
  private readonly path: string;
  private stored?: StoredLimits;

  constructor(projectRoot: string, private readonly config: FolderForgeConfig) {
    this.path = resolve(projectRoot, '.folderforge', 'runtime-settings.json');
    if (!existsSync(this.path)) return;
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StoredLimits;
    const { integritySha256, ...payload } = parsed;
    if (
      parsed.schemaVersion !== 1 ||
      !validInteger(parsed.defaultTimeoutMs, LIMITS.timeout.min, LIMITS.timeout.max) ||
      !validInteger(parsed.maxOutputBytes, LIMITS.output.min, LIMITS.output.max) ||
      typeof parsed.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.updatedAt)) ||
      typeof parsed.updatedBy !== 'string' || !parsed.updatedBy.trim() ||
      !/^[a-f0-9]{64}$/.test(integritySha256 ?? '') ||
      checksum(payload) !== integritySha256
    ) {
      throw new Error('Runtime settings integrity or schema validation failed.');
    }
    this.stored = parsed;
    config.terminal.defaultTimeoutMs = parsed.defaultTimeoutMs;
    config.terminal.maxOutputBytes = parsed.maxOutputBytes;
  }

  describe(): RuntimeSettingsView {
    const sandbox = this.config.terminal.sandbox;
    return {
      terminal: {
        defaultTimeoutMs: this.config.terminal.defaultTimeoutMs,
        maxOutputBytes: this.config.terminal.maxOutputBytes,
        envPolicy: this.config.terminal.envPolicy,
        sandbox: {
          mode: sandbox?.mode ?? 'process',
          requireInDanger: sandbox?.requireInDanger !== false,
        },
      },
      ...(this.stored?.updatedAt ? { updatedAt: this.stored.updatedAt } : {}),
      ...(this.stored?.updatedBy ? { updatedBy: this.stored.updatedBy } : {}),
    };
  }

  update(input: { defaultTimeoutMs: unknown; maxOutputBytes: unknown }, actorId: string): RuntimeSettingsView {
    if (
      !validInteger(input.defaultTimeoutMs, LIMITS.timeout.min, LIMITS.timeout.max) ||
      !validInteger(input.maxOutputBytes, LIMITS.output.min, LIMITS.output.max)
    ) {
      throw new Error('Invalid terminal limits: timeout 1000..1800000 ms; output 1024..2000000 bytes.');
    }
    if (!actorId.trim()) throw new Error('Runtime settings actor id is required.');
    const payload = {
      schemaVersion: 1 as const,
      defaultTimeoutMs: input.defaultTimeoutMs,
      maxOutputBytes: input.maxOutputBytes,
      updatedAt: new Date().toISOString(),
      updatedBy: actorId.trim(),
    };
    const next: StoredLimits = { ...payload, integritySha256: checksum(payload) };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
    this.stored = next;
    this.config.terminal.defaultTimeoutMs = next.defaultTimeoutMs;
    this.config.terminal.maxOutputBytes = next.maxOutputBytes;
    return this.describe();
  }
}
