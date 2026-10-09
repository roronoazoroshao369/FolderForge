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
    if (result.status === 1 && args[0] === "show-ref") return "";
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
  try {
    const ref = `refs/heads/${record.branch}`;
    const refs = probe(gitProbe, ["show-ref", "--verify", ref], record.sourceRoot);
    branchRef = refs ? "present" : "absent";
  } catch {
    branchRef = "unverifiable";
  }

  let rootExists = true;
  try {
    lstatSync(record.worktreeRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") rootExists = false;
    else return { observedHealth: "unverifiable", branchRef, observedAt, diagnosticCode: "ISOLATION_HEALTH_UNVERIFIABLE" };
  }
  if (!rootExists) {
    try {
      const sourceTop = probe(gitProbe, ["rev-parse", "--show-toplevel"], record.sourceRoot);
      const listing = probe(gitProbe, ["worktree", "list", "--porcelain"], record.sourceRoot);
      const registered = listing.split(/\\r?\\n/).some(line => line === `worktree ${record.worktreeRoot}`);
      if (!sourceTop || registered) return { observedHealth: "identity_mismatch", branchRef, observedAt, diagnosticCode: "ISOLATION_IDENTITY_MISMATCH" };
      return { observedHealth: "missing_worktree", branchRef, observedAt, diagnosticCode: "ISOLATION_WORKTREE_MISSING" };
    } catch {
      return { observedHealth: "unverifiable", branchRef: "unverifiable", observedAt, diagnosticCode: "ISOLATION_HEALTH_UNVERIFIABLE" };
    }
  }
  try {
    const stats = lstatSync(record.worktreeRoot);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return { observedHealth: "identity_mismatch", branchRef, observedAt, diagnosticCode: "ISOLATION_IDENTITY_MISMATCH" };
    }
  } catch {
    return { observedHealth: "unverifiable", branchRef, observedAt, diagnosticCode: "ISOLATION_HEALTH_UNVERIFIABLE" };
  }
  try {
    const stats = lstatSync(record.worktreeRoot);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return { observedHealth: "identity_mismatch", branchRef, observedAt, diagnosticCode: "ISOLATION_IDENTITY_MISMATCH" };
    }
    const canonicalRoot = realpathSync.native(record.worktreeRoot);
    const sourceTop = probe(gitProbe, ["rev-parse", "--show-toplevel"], record.sourceRoot);
    const worktreeTop = probe(gitProbe, ["-C", canonicalRoot, "rev-parse", "--show-toplevel"], record.sourceRoot);
    const sourceCommon = probe(gitProbe, ["rev-parse", "--git-common-dir"], record.sourceRoot);
    const listing = probe(gitProbe, ["worktree", "list", "--porcelain"], record.sourceRoot);
    const expectedBranch = `branch refs/heads/${record.branch}`;
    const registered = listing.split(/\r?\n\r?\n/).some(block =>
      block.split(/\r?\n/).some(line => line === `worktree ${canonicalRoot}`) &&
      block.split(/\r?\n/).includes(expectedBranch),
    );
    const worktreeBranch = probe(gitProbe, ["-C", canonicalRoot, "symbolic-ref", "-q", "HEAD"], record.sourceRoot);
    const worktreeCommon = probe(gitProbe, ["-C", canonicalRoot, "rev-parse", "--git-common-dir"], record.sourceRoot);
    const resolvedCommon = resolve(record.sourceRoot, sourceCommon);
    const resolvedWorktreeCommon = isAbsolute(worktreeCommon) ? worktreeCommon : resolve(canonicalRoot, worktreeCommon);
    if (!registered || worktreeTop !== canonicalRoot || worktreeBranch !== expectedBranch || resolve(resolvedCommon) !== resolve(resolvedWorktreeCommon) || !sourceTop) {
      return { observedHealth: "identity_mismatch", branchRef, observedAt, diagnosticCode: "ISOLATION_IDENTITY_MISMATCH" };
    }
    return { observedHealth: "present_consistent", branchRef, observedAt };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { observedHealth: "missing_worktree", branchRef, observedAt, diagnosticCode: "ISOLATION_WORKTREE_MISSING" };
    }
    return { observedHealth: "unverifiable", branchRef, observedAt, diagnosticCode: "ISOLATION_HEALTH_UNVERIFIABLE" };
  }
}
