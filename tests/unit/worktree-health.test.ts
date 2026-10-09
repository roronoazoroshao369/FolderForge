import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WorktreeIsolation } from "../../src/isolation/worktree-manager.js";
import { inspectWorktreeHealth } from "../../src/isolation/worktree-health.js";

const roots: string[] = [];
function gitState(root: string, worktreeRoot: string) {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  return {
    refs: git(root, "show-ref"),
    index: readFileSync(join(root, ".git", "index")),
    worktrees: git(root, "worktree", "list", "--porcelain"),
    sourceFiles: readFileSync(join(root, "tracked.txt")),
    worktreeFiles: readFileSync(join(worktreeRoot, "tracked.txt")),
  };
}
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
      if (args.includes("for-each-ref")) return "refs/heads/main";
      throw new Error("unexpected probe");
    } };
    const result = inspectWorktreeHealth(record(root, missing), probe);
    const afterMetadataBytes = Buffer.from("metadata sentinel");
    expect(result.observedHealth).toBe("missing_worktree");
    expect(result.branchRef).toBe("present");
    expect(result.diagnosticCode).toBe("ISOLATION_WORKTREE_MISSING");
    expect(afterMetadataBytes).toEqual(beforeMetadataBytes);
  });

  it("classifies a registered worktree with a missing path as an identity mismatch", () => {
    const root = repository();
    const worktreeRoot = join(root, "registered worktree");
    execFileSync("git", ["worktree", "add", "-b", "task-registered", worktreeRoot, "HEAD"], { cwd: root });
    const isolation = record(root, worktreeRoot, "task-registered");
    expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" })).toContain(`worktree ${worktreeRoot}`);
    rmSync(worktreeRoot, { recursive: true, force: true });

    const result = inspectWorktreeHealth(isolation);

    expect(result.observedHealth).toBe("identity_mismatch");
    expect(result.diagnosticCode).toBe("ISOLATION_IDENTITY_MISMATCH");
  });

  it("classifies a registered worktree as present and consistent", () => {
    const root = repository();
    const worktreeRoot = join(root, "valid worktree");
    execFileSync("git", ["worktree", "add", "-b", "task-valid", worktreeRoot, "HEAD"], { cwd: root });
    const before = gitState(root, worktreeRoot);
    const result = inspectWorktreeHealth(record(root, worktreeRoot, "task-valid"), {
      run: (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }),
    });
    expect(gitState(root, worktreeRoot)).toEqual(before);
    expect(result.observedHealth).toBe("present_consistent");
    expect(result.branchRef).toBe("present");
  });

  it("reports an absent branch independently from a missing worktree", () => {
    const root = repository();
    const result = inspectWorktreeHealth(record(root, join(root, "absent"), "not-created"));
    expect(result.observedHealth).toBe("missing_worktree");
    expect(result.branchRef).toBe("absent");
  });

  it("returns unverifiable for malformed worktree probe output", () => {
    const root = repository();
    const probe = { run: (args: string[]) => {
      if (args.includes("for-each-ref")) return "refs/heads/main";
      if (args.includes("--show-toplevel")) return root;
      if (args.includes("--git-common-dir")) return ".git";
      if (args.includes("worktree")) return "not porcelain output";
      throw new Error("unexpected probe");
    } };
    const result = inspectWorktreeHealth(record(root, join(root, "absent")), probe);
    expect(result.observedHealth).toBe("unverifiable");
    expect(result.branchRef).toBe("unverifiable");
    expect(result.diagnosticCode).toBe("ISOLATION_HEALTH_UNVERIFIABLE");
  });

  it("treats an empty Git worktree inventory as unverifiable", () => {
    const root = repository();
    const gitProbe = {
      run: (args: string[]) => {
        if (args.includes("for-each-ref")) return "refs/heads/main";
        if (args.includes("--show-toplevel")) return root;
        if (args.includes("--git-common-dir")) return ".git";
        if (args.includes("worktree")) return "";
        throw new Error("unexpected query");
      },
    };
    const result = inspectWorktreeHealth(record(root, join(root, "absent")), gitProbe);
    expect(result.observedHealth).toBe("unverifiable");
    expect(result.diagnosticCode).toBe("ISOLATION_HEALTH_UNVERIFIABLE");
  });

  it("rejects symlink or foreign worktree", () => {
    const root = repository();
    const foreign = repository();
    const link = join(root, "linked");
    symlinkSync(foreign, link);
    const result = inspectWorktreeHealth(record(root, link), { run: args => args.includes("--show-toplevel") ? foreign : args.includes("--git-common-dir") ? ".git" : args.includes("worktree") ? "" : "refs/heads/main" });
    expect(result.observedHealth).toBe("identity_mismatch");
  });

  it("treats an ENOENT Git probe for an existing worktree as unverifiable", () => {
    const root = repository();
    const worktreeRoot = join(root, "healthy worktree");
    execFileSync("git", ["worktree", "add", "-b", "task-healthy", worktreeRoot, "HEAD"], { cwd: root });
    const result = inspectWorktreeHealth(record(root, worktreeRoot, "task-healthy"), {
      run: (args, cwd) => {
        if (args.includes("symbolic-ref")) {
          const failure = new Error("unable to launch git") as NodeJS.ErrnoException;
          failure.code = "ENOENT";
          throw failure;
        }
        return execFileSync("git", args, { cwd, encoding: "utf8" });
      },
    });
    expect(result.observedHealth).toBe("unverifiable");
    expect(result.diagnosticCode).toBe("ISOLATION_HEALTH_UNVERIFIABLE");
  });

  it("rejects a foreign directory even without a symlink", () => {
    const root = repository();
    const foreign = repository();
    const result = inspectWorktreeHealth(record(root, foreign, "main"));
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
