import {
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../../src/audit/audit-log.js';
import { AuditUnavailableError } from '../../src/core/errors.js';
import type {
  AuditConfig,
  RiskLevel,
  ToolPrincipal,
} from '../../src/core/types.js';
import { defineTool, ToolRegistry } from '../../src/tools/registry.js';

const roots: string[] = [];

function auditConfig(overrides: Partial<AuditConfig> = {}): AuditConfig {
  return {
    durability: 'best-effort',
    requireForHighRisk: true,
    requireForAuthenticatedHttp: true,
    ...overrides,
  };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-audit-durability-'));
  roots.push(root);
  return root;
}

function blockedAuditRoot(): string {
  const root = tempRoot();
  mkdirSync(join(root, '.folderforge'), { recursive: true });
  // A regular file where the audit directory must be makes every append fail on
  // every supported OS without relying on platform-specific permission behavior.
  writeFileSync(join(root, '.folderforge', 'audit'), 'blocked');
  return root;
}

function auditPath(root: string): string {
  return join(root, '.folderforge', 'audit', 'audit.v2.jsonl');
}

function ioError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function registryFor(
  root: string,
  audit: Pick<AuditLog, 'record' | 'requiresDurability'>,
  options: {
    risk: RiskLevel;
    mutates?: boolean;
    handler: ReturnType<typeof vi.fn>;
  },
): ToolRegistry {
  const container = {
    config: { audit: auditConfig() },
    projectRoot: () => root,
    audit,
    rateLimiter: { hit: () => ({ allowed: true }) },
    policy: {
      evaluate: () => ({ kind: 'allow' as const }),
      command: { classify: () => ({ risk: 'LOW' as const }) },
      secret: { redactValue: (value: unknown) => value },
    },
  };
  const registry = new ToolRegistry(container as never);
  registry.register(
    defineTool({
      name: 'audit_probe',
      description: 'Exercise audit durability behavior',
      group: 'test',
      mutates: options.mutates ?? true,
      risk: options.risk,
      inputSchema: { type: 'object', properties: {} },
      handler: options.handler,
    }),
  );
  return registry;
}

function principal(authMode: ToolPrincipal['authMode']): ToolPrincipal {
  return { id: `agent:${authMode ?? 'none'}`, role: 'agent', authMode };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('audit durability', () => {
  it('keeps best-effort low-risk logging non-fatal when storage is unavailable', () => {
    const audit = new AuditLog(blockedAuditRoot(), auditConfig());
    expect(() =>
      audit.record({ type: 'tool_call', tool: 'read_probe', risk: 'LOW' }),
    ).not.toThrow();
    expect(audit.recent(1)).toMatchObject([
      { type: 'tool_call', tool: 'read_probe', risk: 'LOW' },
    ]);
  });

  it('fails startup preflight when baseline durability is required', () => {
    expect(
      () =>
        new AuditLog(
          blockedAuditRoot(),
          auditConfig({ durability: 'required' }),
        ),
    ).toThrowError(AuditUnavailableError);
  });

  it('does not start a HIGH-risk handler when the required call record cannot persist', async () => {
    const root = blockedAuditRoot();
    const audit = new AuditLog(root, auditConfig());
    const handler = vi.fn(async () => ({ ok: true }));
    const registry = registryFor(root, audit, { risk: 'HIGH', handler });

    const result = await registry.call(
      'audit_probe',
      { apiKey: 'secret-value-that-must-not-leak' },
      { principal: principal('stdio') },
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('AUDIT_UNAVAILABLE'),
    });
    expect(result.error).not.toContain('secret-value-that-must-not-leak');
    expect(handler).not.toHaveBeenCalled();
  });

  it('allows an explicitly best-effort LOW-risk stdio call to continue', async () => {
    const root = blockedAuditRoot();
    const audit = new AuditLog(root, auditConfig());
    const handler = vi.fn(async () => ({ ok: true, data: { ran: true } }));
    const registry = registryFor(root, audit, {
      risk: 'LOW',
      mutates: false,
      handler,
    });

    const result = await registry.call('audit_probe', {}, {
      principal: principal('stdio'),
    });

    expect(result).toEqual({ ok: true, data: { ran: true } });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('fails closed for a LOW-risk token-authenticated HTTP call', async () => {
    const root = blockedAuditRoot();
    const audit = new AuditLog(root, auditConfig());
    const handler = vi.fn(async () => ({ ok: true }));
    const registry = registryFor(root, audit, {
      risk: 'LOW',
      mutates: false,
      handler,
    });

    const result = await registry.call('audit_probe', {}, {
      principal: principal('token'),
    });

    expect(result.error).toContain('AUDIT_UNAVAILABLE');
    expect(handler).not.toHaveBeenCalled();
  });

  it('fails closed on an injected disk-full write', () => {
    const audit = new AuditLog(tempRoot(), auditConfig(), {
      writeSync: () => {
        throw ioError('ENOSPC', 'simulated disk full');
      },
    });

    expect(() =>
      audit.record(
        { type: 'tool_call', tool: 'write_probe', risk: 'HIGH' },
        { required: true },
      ),
    ).toThrowError(AuditUnavailableError);
  });

  it('detects a partial record after restart and refuses required logging', () => {
    const root = tempRoot();
    let writes = 0;
    const audit = new AuditLog(root, auditConfig(), {
      writeSync: (fd, buffer, offset, length) => {
        writes += 1;
        if (writes === 1) {
          const partialLength = Math.max(1, Math.floor(length / 2));
          return writeSync(fd, buffer, offset, partialLength);
        }
        throw ioError('ENOSPC', 'simulated failure after partial write');
      },
    });

    expect(() =>
      audit.record(
        { type: 'tool_call', tool: 'partial_probe', risk: 'HIGH' },
        { required: true },
      ),
    ).toThrowError(AuditUnavailableError);
    expect(readFileSync(auditPath(root), 'utf8')).not.toMatch(/\n$/);

    expect(
      () =>
        new AuditLog(root, auditConfig({ durability: 'required' })),
    ).toThrowError(AuditUnavailableError);
  });

  it('fails a required record when fsync fails', () => {
    let flushes = 0;
    const audit = new AuditLog(tempRoot(), auditConfig(), {
      fsyncSync: (fd) => {
        flushes += 1;
        if (flushes > 1) throw ioError('EIO', 'simulated fsync failure');
        return fsyncSync(fd);
      },
    });

    expect(() =>
      audit.record(
        { type: 'tool_call', tool: 'flush_probe', risk: 'HIGH' },
        { required: true },
      ),
    ).toThrowError(AuditUnavailableError);
  });

  it('fails a required record when close fails', () => {
    let closes = 0;
    const audit = new AuditLog(tempRoot(), auditConfig(), {
      closeSync: (fd) => {
        closes += 1;
        closeSync(fd);
        if (closes > 1) throw ioError('EIO', 'simulated close failure');
      },
    });

    expect(() =>
      audit.record(
        { type: 'tool_call', tool: 'close_probe', risk: 'HIGH' },
        { required: true },
      ),
    ).toThrowError(AuditUnavailableError);
  });

  it('preserves complete records across independent writers sharing one log', async () => {
    const root = tempRoot();
    const writers = Array.from(
      { length: 12 },
      () => new AuditLog(root, auditConfig()),
    );

    await Promise.all(
      writers.map(
        (audit, index) =>
          new Promise<void>((resolve) => {
            setImmediate(() => {
              audit.record(
                {
                  type: 'tool_call',
                  tool: `writer_${index}`,
                  risk: 'HIGH',
                },
                { required: true },
              );
              resolve();
            });
          }),
      ),
    );

    const lines = readFileSync(auditPath(root), 'utf8')
      .trimEnd()
      .split('\n');
    expect(lines).toHaveLength(writers.length);
    expect(lines.map((line) => JSON.parse(line))).toEqual(
      expect.arrayContaining(
        writers.map((_, index) =>
          expect.objectContaining({
            schemaVersion: 2,
            event: expect.objectContaining({ tool: `writer_${index}` }),
          }),
        ),
      ),
    );
  });

  it('marks the outcome uncertain when terminal evidence fails after execution', async () => {
    let writes = 0;
    const audit = {
      requiresDurability: () => true,
      record: () => {
        writes += 1;
        if (writes === 2) throw new AuditUnavailableError();
        return {
          ts: new Date().toISOString(),
          type: 'tool_call' as const,
        };
      },
    };
    const handler = vi.fn(async () => ({ ok: true, data: { changed: true } }));
    const registry = registryFor('/tmp', audit as never, {
      risk: 'HIGH',
      handler,
    });

    const result = await registry.call('audit_probe', {}, {
      principal: principal('stdio'),
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('AUDIT_OUTCOME_UNCERTAIN'),
    });
    expect(result.error).toMatch(/do not retry automatically/i);
  });
});
