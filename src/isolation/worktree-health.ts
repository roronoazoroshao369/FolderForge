import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { WorktreeIsolation } from "./worktree-manager.js";

export type ObservedWorktreeHealth =
  | "present_consistent"
  | "missing_worktree"
  | "identity_mismatch"
  | "unverifiable"
  | "terminal_record";
export type ObservedBranchRef = "present" | "absent" | "unverifiable";
export interface IsolationHealthObservation {
  observedHealth: ObservedWorktreeHealth;
  branchRef: ObservedBranchRef;
  observedAt: string;
  diagnosticCode?: string;
}
export interface GitHealthProbe {
  run(args: string[], cwd?: string): string;
}

const defaultProbe: GitHealthProbe = {
  run(args, cwd) {
    const result = spawnSync("git", ["--no-optional-locks", ...args], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Git health probe failed");
    if (result.stdout.length > 1024 * 1024) throw new Error("Git health probe output exceeded limit");
    if (result.stderr.length > 1024 * 1024) throw new Error("Git health probe output exceeded limit");
    return result.stdout;
  },
};

function probe(probe: GitHealthProbe, args: string[], cwd: string): string {
  return probe.run(args, cwd).trim();
}

export function inspectWorktreeHealth(
  record: WorktreeIsolation,
  gitProbe: GitHealthProbe = defaultProbe,
): IsolationHealthObservation {
  const observedAt = new Date().toISOString();
  if (record.state === "discarded") {
    return { observedHealth: "terminal_record", branchRef: "unverifiable", observedAt };
  }

  let branchRef: ObservedBranchRef = "unverifiable";
  const ref = `refs/heads/${record.branch}`;
  try {
    const refs = probe(gitProbe, ["for-each-ref", "--format=%(refname)", ref], record.sourceRoot);
    branchRef = refs === ref ? "present" : refs ? "unverifiable" : "absent";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "REF_ABSENT") branchRef = "absent";
    else branchRef = "unverifiable";
  }

  let stats;
  try {
    stats = lstatSync(record.worktreeRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { observedHealth: "unverifiable", branchRef, observedAt, diagnosticCode: "ISOLATION_HEALTH_UNVERIFIABLE" };
    }
    try {
      const sourceTop = probe(gitProbe, ["rev-parse", "--show-toplevel"], record.sourceRoot);
      const sourceCommon = probe(gitProbe, ["rev-parse", "--git-common-dir"], record.sourceRoot);
      const listing = probe(gitProbe, ["worktree", "list", "--porcelain"], record.sourceRoot);
      const canonicalSource = realpathSync.native(record.sourceRoot);
      const commonPath = isAbsolute(sourceCommon) ? sourceCommon : resolve(record.sourceRoot, sourceCommon);
      if (resolve(record.sourceRoot, sourceTop) !== canonicalSource || !sourceCommon || realpathSync.native(commonPath) !== realpathSync.native(resolve(record.sourceRoot, ".git"))) {
        return { observedHealth: "identity_mismatch", branchRef, observedAt, diagnosticCode: "ISOLATION_IDENTITY_MISMATCH" };
      }
      const blocks = listing.split(/\r?\n\r?\n/).filter(Boolean);
      if (blocks.some(block => !block.split(/\r?\n/).some(line => line.startsWith("worktree ")))) {
        return { observedHealth: "unverifiable", branchRef: "unverifiable", observedAt, diagnosticCode: "ISOLATION_HEALTH_UNVERIFIABLE" };
      }
      const registered = blocks.some(block => block.split(/\r?\n/).some(line => line === `worktree ${resolve(record.worktreeRoot)}`));
      if (registered) return { observedHealth: "identity_mismatch", branchRef, observedAt, diagnosticCode: "ISOLATION_IDENTITY_MISMATCH" };
      return { observedHealth: "missing_worktree", branchRef, observedAt, diagnosticCode: "ISOLATION_WORKTREE_MISSING" };
    } catch {
      return { observedHealth: "unverifiable", branchRef: "unverifiable", observedAt, diagnosticCode: "ISOLATION_HEALTH_UNVERIFIABLE" };
    }
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return { observedHealth: "identity_mismatch", branchRef, observedAt, diagnosticCode: "ISOLATION_IDENTITY_MISMATCH" };
  }
  try {
    const canonicalRoot = realpathSync.native(record.worktreeRoot);
    const sourceTop = probe(gitProbe, ["rev-parse", "--show-toplevel"], record.sourceRoot);
    const worktreeTop = probe(gitProbe, ["-C", canonicalRoot, "rev-parse", "--show-toplevel"], record.sourceRoot);
    const sourceCommon = probe(gitProbe, ["rev-parse", "--git-common-dir"], record.sourceRoot);
    const listing = probe(gitProbe, ["worktree", "list", "--porcelain"], record.sourceRoot);
    const expectedBranch = `branch refs/heads/${record.branch}`;
    const expectedBranchRef = expectedBranch.slice("branch ".length);
    const blocks = listing.split(/\r?\n\r?\n/).filter(Boolean);
    if (blocks.some(block => !block.split(/\r?\n/).some(line => line.startsWith("worktree ")))) {
      return { observedHealth: "unverifiable", branchRef, observedAt, diagnosticCode: "ISOLATION_HEALTH_UNVERIFIABLE" };
    }
    const registered = blocks.some(block => {
      const lines = block.split(/\r?\n/);
      const branchLine = lines.find(line => line.startsWith("branch "));
      return lines.some(line => line === `worktree ${canonicalRoot}`) &&
        (branchLine === expectedBranch || (branchLine === undefined && lines.includes("detached")));
    });
    const worktreeBranch = probe(gitProbe, ["-C", canonicalRoot, "symbolic-ref", "-q", "HEAD"], record.sourceRoot);
    const worktreeCommon = probe(gitProbe, ["-C", canonicalRoot, "rev-parse", "--git-common-dir"], record.sourceRoot);
    const resolvedCommon = isAbsolute(sourceCommon) ? sourceCommon : resolve(record.sourceRoot, sourceCommon);
    const resolvedWorktreeCommon = isAbsolute(worktreeCommon) ? worktreeCommon : resolve(canonicalRoot, worktreeCommon);
    if (!registered || worktreeTop !== canonicalRoot || worktreeBranch !== expectedBranchRef || resolve(resolvedCommon) !== resolve(resolvedWorktreeCommon) || resolve(record.sourceRoot, sourceTop) !== realpathSync.native(record.sourceRoot)) {
      return { observedHealth: "identity_mismatch", branchRef, observedAt, diagnosticCode: "ISOLATION_IDENTITY_MISMATCH" };
    }
    return { observedHealth: "present_consistent", branchRef, observedAt };
  } catch {
    // The path passed lstat above. A later ENOENT may be a failed Git probe
    // or concurrent removal; neither proves a safely missing worktree.
    return { observedHealth: "unverifiable", branchRef, observedAt, diagnosticCode: "ISOLATION_HEALTH_UNVERIFIABLE" };
  }
}
