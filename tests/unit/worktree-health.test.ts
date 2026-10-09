import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WorktreeIsolation } from "../../src/isolation/worktree-manager.js";
import { inspectWorktreeHealth } from "../../src/isolation/worktree-health.js";
import { canonicalCandidatePath } from "../../src/core/path-identity.js";

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
      if (args.includes("worktree")) return `worktree ${root}\nHEAD ${record(root).baseCommit}\nbranch refs/heads/main\n\n`;
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

  it("normalizes symlink-alias paths from the Git inventory before declaring a worktree missing", () => {
    const root = repository();
    const alias = join(root, "alias");
    symlinkSync(root, alias, "dir");
    const missing = join(root, "never-created");
    const source = record(root, missing, "never-created");
    const originalInventory = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" });
    const aliasInventory = originalInventory.replaceAll("worktree " + realpathSync.native(root), "worktree " + alias);
    expect(aliasInventory).not.toBe(originalInventory);

    const result = inspectWorktreeHealth(source, {
      run: (args, cwd) => args.includes("worktree")
        ? aliasInventory
        : execFileSync("git", args, { cwd, encoding: "utf8" }),
    });

    expect(result.observedHealth).toBe("missing_worktree");
    expect(result.branchRef).toBe("absent");
  });

  it("normalizes the registered missing worktree path through a symlinked ancestor", () => {
    const root = repository();
    const alias = join(root, "alias");
    symlinkSync(root, alias, "dir");
    const missing = join(root, "registered-gone");
    const source = record(root, missing, "task-gone");
    const inventory = "worktree " + alias + "\nHEAD " + source.sourceHead + "\nbranch refs/heads/main\n\n" +
      "worktree " + join(alias, "registered-gone") + "\nHEAD " + source.sourceHead + "\nbranch refs/heads/task-gone\n\n";

    const result = inspectWorktreeHealth(source, {
      run: (args, cwd) => args.includes("worktree")
        ? inventory
        : execFileSync("git", args, { cwd, encoding: "utf8" }),
    });

    expect(result.observedHealth).toBe("identity_mismatch");
  });

  it("classifies a registered worktree with a missing path as an identity mismatch", () => {
    const root = repository();
    const worktreeRoot = join(root, "registered worktree");
    execFileSync("git", ["worktree", "add", "-b", "task-registered", worktreeRoot, "HEAD"], { cwd: root });
    const isolation = record(root, worktreeRoot, "task-registered");
    const listed = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" });
    const listedRoots = listed.split(/\r?\n/).filter(line => line.startsWith("worktree "))
      .map(line => canonicalCandidatePath(line.slice("worktree ".length)));
    expect(listedRoots).toContain(canonicalCandidatePath(worktreeRoot));
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

  it("does not classify truncated Git porcelain as a verified missing worktree", () => {
    const root = repository();
    const r = record(root, join(root, "missing-truncated"), "not-created");
    const partialInventory = `worktree ${root}\nHEAD ${r.sourceHead}\nbranch refs/heads/main\n`;
    const observed = inspectWorktreeHealth(r, {
      run: (args, cwd) => {
        if (args.includes("worktree")) return partialInventory; // missing terminal blank line
        return execFileSync("git", args, { cwd, encoding: "utf8" });
      },
    });
    expect(observed.observedHealth).toBe("unverifiable");
    expect(observed.branchRef).toBe("unverifiable");
  });

  it("rejects a complete-looking inventory lacking mandatory source HEAD data", () => {
    const root = repository();
    const r = record(root, join(root, "missing-corrupt-source"), "not-created");
    const malformedInventory = `worktree ${root}\nbranch refs/heads/main\n\n`;
    const observed = inspectWorktreeHealth(r, {
      run: (args, cwd) => args.includes("worktree") ? malformedInventory : execFileSync("git", args, { cwd, encoding: "utf8" }),
    });
    expect(observed.observedHealth).toBe("unverifiable");
  });

  it("does not trust a forged common-directory identity for an existing worktree", () => {
    const root = repository();
    const foreign = repository();
    const path = join(root, "valid-owned-worktree");
    execFileSync("git", ["worktree", "add", "-b", "task-foreign-identity", path, "HEAD"], { cwd: root });
    const observed = inspectWorktreeHealth(record(root, path, "task-foreign-identity"), {
      run: (args, cwd) => args.includes("--git-common-dir")
        ? join(foreign, ".git")
        : execFileSync("git", args, { cwd, encoding: "utf8" }),
    });
    expect(observed.observedHealth).toBe("identity_mismatch");
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

  it("does not assert a missing task ref when source common-directory ownership is false", () => {
    const root = repository();
    const foreign = repository();
    const missing = join(root, "absent-branch-with-forged-source");
    const result = inspectWorktreeHealth(record(root, missing, "not-created"), {
      run: (args, cwd) => args.includes("--git-common-dir")
        ? join(foreign, ".git")
        : execFileSync("git", args, { cwd, encoding: "utf8" }),
    });
    expect(result).toMatchObject({ observedHealth: "identity_mismatch", branchRef: "unverifiable" });
  });

  it("accepts a valid linked source worktree with a separate managed branch", () => {
    const root = repository();
    const linkedSource = join(root, "linked-source");
    const taskRoot = join(root, "managed-task");
    execFileSync("git", ["worktree", "add", "-b", "source-linked", linkedSource, "HEAD"], { cwd: root });
    execFileSync("git", ["worktree", "add", "-b", "task-from-linked", taskRoot, "HEAD"], { cwd: root });
    const result = inspectWorktreeHealth(record(linkedSource, taskRoot, "task-from-linked"));
    expect(result).toMatchObject({ observedHealth: "present_consistent", branchRef: "present" });
  });

  it("does not claim branch absence when the source inventory cannot be verified", () => {
    const root = repository();
    const result = inspectWorktreeHealth(record(root, join(root, "missing-bad-inventory"), "unknown"), {
      run: (args, cwd) => {
        if (args.includes("worktree")) return "partial";
        return execFileSync("git", args, { cwd, encoding: "utf8" });
      },
    });
    expect(result).toMatchObject({ observedHealth: "unverifiable", branchRef: "unverifiable" });
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
