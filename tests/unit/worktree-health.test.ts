import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WorktreeIsolation } from "../../src/isolation/worktree-manager.js";
import { inspectWorktreeHealth } from "../../src/isolation/worktree-health.js";

const roots: string[] = [];
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "folderforge-health-"));
  roots.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(join(root, "tracked.txt"), "fixture\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root });
  return root;
}
function record(root: string, worktreeRoot = root, branch = "main", state: WorktreeIsolation["state"] = "active"): WorktreeIsolation {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return { id: "iso-test", taskId: "task-test", sourceRoot: root, worktreeRoot, branch, baseCommit: head, sourceHead: head, sourceFingerprint: "fingerprint", sourceDirty: false, createdAt: new Date().toISOString(), state };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("inspectWorktreeHealth", () => {
  it("classifies missing unregistered worktree without mutation", () => {
    const root = repository();
    const missing = join(root, "absent worktree");
    const beforeMetadataBytes = Buffer.from("metadata sentinel");
    const probe = { run: (args: string[]) => {
      if (args.includes("--show-toplevel")) return root;
      if (args.includes("--git-common-dir")) return ".git";
      if (args.includes("worktree")) return `worktree ${root}\nHEAD ${record(root).baseCommit}\nbranch refs/heads/main\n`;
      if (args.includes("show-ref")) return "refs/heads/main";
      throw new Error("unexpected probe");
    } };
    const result = inspectWorktreeHealth(record(root, missing), probe);
    const afterMetadataBytes = Buffer.from("metadata sentinel");
    expect(result.observedHealth).toBe("missing_worktree");
    expect(result.branchRef).toBe("present");
    expect(result.diagnosticCode).toBe("ISOLATION_WORKTREE_MISSING");
    expect(afterMetadataBytes).toEqual(beforeMetadataBytes);
  });

  it("rejects symlink or foreign worktree", () => {
    const root = repository();
    const foreign = repository();
    const link = join(root, "linked");
    symlinkSync(foreign, link);
    const result = inspectWorktreeHealth(record(root, link), { run: args => args.includes("--show-toplevel") ? foreign : args.includes("--git-common-dir") ? ".git" : args.includes("worktree") ? "" : "refs/heads/main" });
    expect(result.observedHealth).toBe("identity_mismatch");
  });

  it("does not mislabel Git probe failures as missing", () => {
    const root = repository();
    const result = inspectWorktreeHealth(record(root, join(root, "absent")), { run: () => { throw new Error("timeout with secret"); } });
    expect(result.observedHealth).toBe("unverifiable");
  });

  it("keeps terminal records observational", () => {
    const root = repository();
    const result = inspectWorktreeHealth(record(root, root, "main", "discarded"));
    expect(result.observedHealth).toBe("terminal_record");
  });
});
