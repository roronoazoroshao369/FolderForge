import {
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLog } from "../../src/audit/audit-log.js";
import { AuditUnavailableError } from "../../src/core/errors.js";
import { FileAuditStore } from "../../src/evidence/file-audit-store.js";
import type {
  AuditConfig,
  RiskLevel,
  ToolPrincipal,
} from "../../src/core/types.js";
import { defineTool, ToolRegistry } from "../../src/tools/registry.js";

const roots: string[] = [];

function auditConfig(overrides: Partial<AuditConfig> = {}): AuditConfig {
  return {
    durability: "best-effort",
    requireForHighRisk: true,
    requireForAuthenticatedHttp: true,
    ...overrides,
  };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "folderforge-audit-durability-"));
  roots.push(root);
  return root;
}

function blockedAuditRoot(): string {
  const root = tempRoot();
  mkdirSync(join(root, ".folderforge"), { recursive: true });
  // A regular file where the audit directory must be makes every append fail on
  // every supported OS without relying on platform-specific permission behavior.
  writeFileSync(join(root, ".folderforge", "audit"), "blocked");
  return root;
}

function auditPath(root: string): string {
  return join(root, ".folderforge", "audit", "audit.v2.jsonl");
}

function ioError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function registryFor(
  root: string,
  audit: Pick<AuditLog, "record" | "requiresDurability">,
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
      evaluate: () => ({ kind: "allow" as const }),
      command: { classify: () => ({ risk: "LOW" as const }) },
      secret: { redactValue: (value: unknown) => value },
    },
  };
  const registry = new ToolRegistry(container as never);
  registry.register(
    defineTool({
      name: "audit_probe",
      description: "Exercise audit durability behavior",
      group: "test",
      mutates: options.mutates ?? true,
      risk: options.risk,
      inputSchema: { type: "object", properties: {} },
      handler: options.handler,
    }),
  );
  return registry;
}

function principal(authMode: ToolPrincipal["authMode"]): ToolPrincipal {
  return { id: `agent:${authMode ?? "none"}`, role: "agent", authMode };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("audit durability", () => {
  it("keeps best-effort low-risk logging non-fatal when storage is unavailable", () => {
    const audit = new AuditLog(blockedAuditRoot(), auditConfig());
    expect(() =>
      audit.record({ type: "tool_call", tool: "read_probe", risk: "LOW" }),
    ).not.toThrow();
    expect(audit.recent(1)).toMatchObject([
      { type: "tool_call", tool: "read_probe", risk: "LOW" },
    ]);
  });

  it("fails startup preflight when baseline durability is required", () => {
    expect(
      () =>
        new AuditLog(
          blockedAuditRoot(),
          auditConfig({ durability: "required" }),
        ),
    ).toThrowError(AuditUnavailableError);
  });

  it("does not start a HIGH-risk handler when the required call record cannot persist", async () => {
    const root = blockedAuditRoot();
    const audit = new AuditLog(root, auditConfig());
    const handler = vi.fn(async () => ({ ok: true }));
    const registry = registryFor(root, audit, { risk: "HIGH", handler });

    const result = await registry.call(
      "audit_probe",
      { apiKey: "secret-value-that-must-not-leak" },
      { principal: principal("stdio") },
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("AUDIT_UNAVAILABLE"),
    });
    expect(result.error).not.toContain("secret-value-that-must-not-leak");
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows an explicitly best-effort LOW-risk stdio call to continue", async () => {
    const root = blockedAuditRoot();
    const audit = new AuditLog(root, auditConfig());
    const handler = vi.fn(async () => ({ ok: true, data: { ran: true } }));
    const registry = registryFor(root, audit, {
      risk: "LOW",
      mutates: false,
      handler,
    });

    const result = await registry.call(
      "audit_probe",
      {},
      {
        principal: principal("stdio"),
      },
    );

    expect(result).toEqual({ ok: true, data: { ran: true } });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("fails closed for a LOW-risk token-authenticated HTTP call", async () => {
    const root = blockedAuditRoot();
    const audit = new AuditLog(root, auditConfig());
    const handler = vi.fn(async () => ({ ok: true }));
    const registry = registryFor(root, audit, {
      risk: "LOW",
      mutates: false,
      handler,
    });

    const result = await registry.call(
      "audit_probe",
      {},
      {
        principal: principal("token"),
      },
    );

    expect(result.error).toContain("AUDIT_UNAVAILABLE");
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed on an injected disk-full write", () => {
    const audit = new AuditLog(tempRoot(), auditConfig(), {
      writeSync: () => {
        throw ioError("ENOSPC", "simulated disk full");
      },
    });

    expect(() =>
      audit.record(
        { type: "tool_call", tool: "write_probe", risk: "HIGH" },
        { required: true },
      ),
    ).toThrowError(AuditUnavailableError);
  });

  it("quarantines a torn final record after a crash and resumes required logging", () => {
    const root = tempRoot();
    let writes = 0;
    const audit = new AuditLog(root, auditConfig(), {
      writeSync: (fd, buffer, offset, length) => {
        writes += 1;
        if (writes === 1) {
          const partialLength = Math.max(1, Math.floor(length / 2));
          return writeSync(fd, buffer, offset, partialLength);
        }
        throw ioError("ENOSPC", "simulated failure after partial write");
      },
    });

    // The interrupted append still fails the in-flight call...
    expect(() =>
      audit.record(
        { type: "tool_call", tool: "partial_probe", risk: "HIGH" },
        { required: true },
      ),
    ).toThrowError(AuditUnavailableError);
    expect(readFileSync(auditPath(root), "utf8")).not.toMatch(/\n$/);

    // ...but after a restart with healthy storage, the torn tail is
    // quarantined (evidence preserved) instead of locking operators out with
    // AUDIT_UNAVAILABLE, and the repaired chain resumes with a marker event.
    const recovered = new AuditLog(
      root,
      auditConfig({ durability: "required" }),
    );
    expect(() =>
      recovered.record(
        { type: "tool_call", tool: "after_repair_probe", risk: "HIGH" },
        { required: true },
      ),
    ).not.toThrow();

    const auditDir = join(root, ".folderforge", "audit");
    const quarantines = readdirSync(auditDir).filter((name) =>
      /^audit\.v2\.torn-.*\.jsonl$/.test(name),
    );
    expect(quarantines).toHaveLength(1);
    const raw = readFileSync(auditPath(root), "utf8");
    expect(raw).toMatch(/\n$/);
    const events = raw
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: { type: string } });
    expect(events[0]?.event.type).toBe("audit_repair");
    expect(recovered.verify()).toMatchObject({ ok: true });
  });

  it("quarantines a torn tail after complete records and keeps sequence and hashes intact", () => {
    const root = tempRoot();
    const audit = new AuditLog(root, auditConfig());
    audit.record(
      { type: "tool_call", tool: "one", risk: "HIGH" },
      { required: true },
    );
    audit.record(
      { type: "tool_call", tool: "two", risk: "HIGH" },
      { required: true },
    );
    // Simulated power cut mid-append: a partial third record, no newline.
    const tornFragment = '{"schemaVersion":2,"sequence":3,"prev';
    writeFileSync(auditPath(root), tornFragment, { flag: "a" });

    const recovered = new AuditLog(
      root,
      auditConfig({ durability: "required" }),
    );
    recovered.record(
      { type: "tool_call", tool: "three", risk: "HIGH" },
      { required: true },
    );

    expect(recovered.verify()).toMatchObject({ ok: true });
    const entries = readFileSync(auditPath(root), "utf8")
      .trimEnd()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            sequence: number;
            event: { type: string; tool?: string };
          },
      );
    expect(
      entries.map((entry) =>
        entry.event.type === "audit_repair" ? "audit_repair" : entry.event.tool,
      ),
    ).toEqual(["one", "two", "audit_repair", "three"]);
    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4]);
    const auditDir = join(root, ".folderforge", "audit");
    const quarantines = readdirSync(auditDir).filter((name) =>
      name.startsWith("audit.v2.torn-"),
    );
    expect(quarantines).toHaveLength(1);
    expect(readFileSync(join(auditDir, quarantines[0]!), "utf8")).toBe(
      tornFragment,
    );
  });

  it("still fails closed when a complete record was tampered with (no crash tear)", () => {
    const root = tempRoot();
    const audit = new AuditLog(root, auditConfig());
    audit.record(
      { type: "tool_call", tool: "one", risk: "HIGH" },
      { required: true },
    );
    audit.record(
      { type: "tool_call", tool: "two", risk: "HIGH" },
      { required: true },
    );
    const raw = readFileSync(auditPath(root), "utf8");
    const tampered = raw.replace('"one"', '"tampered"');
    expect(tampered).not.toBe(raw);
    writeFileSync(auditPath(root), tampered);

    // Read-only verification reports the damage without repairing it...
    expect(new FileAuditStore(root).verify().ok).toBe(false);
    // ...and required startup still fails closed.
    expect(
      () => new AuditLog(root, auditConfig({ durability: "required" })),
    ).toThrowError(AuditUnavailableError);
  });

  it("refuses to repair when the intact-looking prefix was also tampered with", () => {
    const root = tempRoot();
    const audit = new AuditLog(root, auditConfig());
    audit.record(
      { type: "tool_call", tool: "one", risk: "HIGH" },
      { required: true },
    );
    audit.record(
      { type: "tool_call", tool: "two", risk: "HIGH" },
      { required: true },
    );
    // Tamper with a complete record AND leave a torn tail (crash + modification):
    // the prefix no longer verifies, so nothing is quarantined or rewritten.
    const tampered = readFileSync(auditPath(root), "utf8").replace(
      '"one"',
      '"tampered"',
    );
    writeFileSync(auditPath(root), tampered);
    writeFileSync(auditPath(root), '{"schemaVersion":2,"sequence":3,"prev', {
      flag: "a",
    });
    const before = readFileSync(auditPath(root), "utf8");

    expect(
      () => new AuditLog(root, auditConfig({ durability: "required" })),
    ).toThrowError(AuditUnavailableError);
    // Fail-closed means untouched: the file is byte-identical and nothing was quarantined.
    expect(readFileSync(auditPath(root), "utf8")).toBe(before);
    const auditDir = join(root, ".folderforge", "audit");
    expect(
      readdirSync(auditDir).filter((name) => name.startsWith("audit.v2.torn-")),
    ).toHaveLength(0);
  });

  it("fails a required record when a write makes no forward progress", () => {
    const audit = new AuditLog(tempRoot(), auditConfig(), {
      writeSync: () => 0,
    });

    expect(() =>
      audit.record(
        { type: "tool_call", tool: "zero_progress_probe", risk: "HIGH" },
        { required: true },
      ),
    ).toThrowError(AuditUnavailableError);
  });

  it("reclaims a stale lock owned by a dead process before appending", () => {
    const root = tempRoot();
    const store = new FileAuditStore(root);
    store.preflight(false);
    const lockPath = join(root, ".folderforge", "audit", "audit.v2.lock");
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 2_147_483_647, createdAt: "2000-01-01T00:00:00.000Z" })}\n`,
    );
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockPath, stale, stale);

    const appended = store.append(
      {
        ts: new Date().toISOString(),
        type: "tool_call",
        tool: "stale_lock_probe",
        risk: "HIGH",
      },
      { required: true },
    );

    expect(appended).toMatchObject({
      schemaVersion: 2,
      sequence: 1,
      event: { tool: "stale_lock_probe" },
    });
    expect(store.verify()).toMatchObject({ ok: true, records: 1 });
  });

  it("fails a required record when fsync fails", () => {
    let flushes = 0;
    const audit = new AuditLog(tempRoot(), auditConfig(), {
      fsyncSync: (fd) => {
        flushes += 1;
        if (flushes > 1) throw ioError("EIO", "simulated fsync failure");
        return fsyncSync(fd);
      },
    });

    expect(() =>
      audit.record(
        { type: "tool_call", tool: "flush_probe", risk: "HIGH" },
        { required: true },
      ),
    ).toThrowError(AuditUnavailableError);
  });

  it("fails a required record when close fails", () => {
    let closes = 0;
    const audit = new AuditLog(tempRoot(), auditConfig(), {
      closeSync: (fd) => {
        closes += 1;
        closeSync(fd);
        if (closes > 1) throw ioError("EIO", "simulated close failure");
      },
    });

    expect(() =>
      audit.record(
        { type: "tool_call", tool: "close_probe", risk: "HIGH" },
        { required: true },
      ),
    ).toThrowError(AuditUnavailableError);
  });

  it("preserves complete records across independent writers sharing one log", async () => {
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
                  type: "tool_call",
                  tool: `writer_${index}`,
                  risk: "HIGH",
                },
                { required: true },
              );
              resolve();
            });
          }),
      ),
    );

    const lines = readFileSync(auditPath(root), "utf8").trimEnd().split("\n");
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

  it("marks the outcome uncertain when terminal evidence fails after execution", async () => {
    let writes = 0;
    const audit = {
      requiresDurability: () => true,
      record: () => {
        writes += 1;
        if (writes === 2) throw new AuditUnavailableError();
        return {
          ts: new Date().toISOString(),
          type: "tool_call" as const,
        };
      },
    };
    const handler = vi.fn(async () => ({ ok: true, data: { changed: true } }));
    const registry = registryFor("/tmp", audit as never, {
      risk: "HIGH",
      handler,
    });

    const result = await registry.call(
      "audit_probe",
      {},
      {
        principal: principal("stdio"),
      },
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("AUDIT_OUTCOME_UNCERTAIN"),
    });
    expect(result.error).toMatch(/do not retry automatically/i);
  });
});
