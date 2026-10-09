import { lstatSync, realpathSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { samePath } from "../core/path-identity.js";
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
  diagnosticCode?: IsolationHealthErrorCode;
}
export interface GitHealthProbe {
  run(args: string[], cwd?: string): string;
}

export type IsolationHealthErrorCode =
  | "ISOLATION_WORKTREE_MISSING"
  | "ISOLATION_IDENTITY_MISMATCH"
  | "ISOLATION_HEALTH_UNVERIFIABLE";

export class IsolationHealthError extends Error {
  constructor(
    readonly code: IsolationHealthErrorCode,
    readonly observedHealth: ObservedWorktreeHealth,
  ) {
    super(`${code}: managed worktree health is ${observedHealth}.`);
    this.name = "IsolationHealthError";
  }
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

function expectedCommonDirectory(sourceRoot: string): string {
  const dotGit = resolve(sourceRoot, ".git");
  const stat = lstatSync(dotGit);
  if (stat.isDirectory()) return realpathSync.native(dotGit);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Untrusted source .git");
  const pointer = readFileSync(dotGit, "utf8").trim();
  if (!pointer.startsWith("gitdir: ")) throw new Error("Malformed Git worktree pointer");
  const rawGitDir = pointer.slice("gitdir: ".length).trim();
  if (!rawGitDir) throw new Error("Empty linked Git pointer");
  const gitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(sourceRoot, rawGitDir);
  const commonRef = readFileSync(resolve(gitDir, "commondir"), "utf8").trim();
  if (!commonRef) throw new Error("Missing common dir pointer");
  return realpathSync.native(resolve(gitDir, commonRef));
}

/** Git porcelain requires a final blank line and a complete record per worktree. */
function verifiedWorktreeInventory(gitProbe: GitHealthProbe, sourceRoot: string): string[][] {
  const raw = gitProbe.run(["worktree", "list", "--porcelain"], sourceRoot);
  if (!/\r?\n\r?\n$/.test(raw)) throw new Error("Incomplete worktree inventory");
  const blocks = raw.split(/\r?\n\r?\n/).filter(Boolean).map(block => block.split(/\r?\n/));
  if (!blocks.length) throw new Error("Empty worktree inventory");
  for (const lines of blocks) {
    if (lines.filter(line => line.startsWith("worktree ")).length !== 1 ||
        lines.filter(line => /^HEAD [0-9a-fA-F]{40,64}$/.test(line)).length !== 1 ||
        lines.filter(line => line === "detached" || line.startsWith("branch refs/heads/")).length !== 1) {
      throw new Error("Malformed worktree porcelain entry");
    }
  }
  return blocks;
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
  let candidateBranchRef: ObservedBranchRef = "unverifiable";
  const ref = `refs/heads/${record.branch}`;
  try {
    const refs = probe(gitProbe, ["for-each-ref", "--format=%(refname)", ref], record.sourceRoot);
    candidateBranchRef = refs === ref ? "present" : refs ? "unverifiable" : "absent";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "REF_ABSENT") candidateBranchRef = "absent";
    else candidateBranchRef = "unverifiable";
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
      const blocks = verifiedWorktreeInventory(gitProbe, record.sourceRoot);
      const canonicalSource = realpathSync.native(record.sourceRoot);
      const commonPath = isAbsolute(sourceCommon) ? sourceCommon : resolve(record.sourceRoot, sourceCommon);
      if (!samePath(resolve(record.sourceRoot, sourceTop), canonicalSource) ||
          !sourceCommon || !samePath(realpathSync.native(commonPath), expectedCommonDirectory(record.sourceRoot))) {
        return { observedHealth: "identity_mismatch", branchRef, observedAt, diagnosticCode: "ISOLATION_IDENTITY_MISMATCH" };
      }
      const sourceRegistered = blocks.some(lines => lines.includes(`worktree ${canonicalSource}`));
      if (!sourceRegistered) {
        return { observedHealth: "unverifiable", branchRef: "unverifiable", observedAt, diagnosticCode: "ISOLATION_HEALTH_UNVERIFIABLE" };
      }
      branchRef = candidateBranchRef; // Only trust ref absence after verified source + complete Git inventory.
      const registered = blocks.some(lines => lines.includes(`worktree ${resolve(record.worktreeRoot)}`));
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
    const blocks = verifiedWorktreeInventory(gitProbe, record.sourceRoot);
    const expectedBranch = `branch refs/heads/${record.branch}`;
    const expectedBranchRef = expectedBranch.slice("branch ".length);
    const registered = blocks.some(lines => {
      const branchLine = lines.find(line => line.startsWith("branch "));
      return lines.some(line => line === `worktree ${canonicalRoot}`) &&
        (branchLine === expectedBranch || (branchLine === undefined && lines.includes("detached")));
    });
    const worktreeBranch = probe(gitProbe, ["-C", canonicalRoot, "symbolic-ref", "-q", "HEAD"], record.sourceRoot);
    const worktreeCommon = probe(gitProbe, ["-C", canonicalRoot, "rev-parse", "--git-common-dir"], record.sourceRoot);
    const resolvedCommon = isAbsolute(sourceCommon) ? sourceCommon : resolve(record.sourceRoot, sourceCommon);
    const resolvedWorktreeCommon = isAbsolute(worktreeCommon) ? worktreeCommon : resolve(canonicalRoot, worktreeCommon);
    if (!registered || !samePath(worktreeTop, canonicalRoot) ||
        worktreeBranch !== expectedBranchRef ||
        !samePath(realpathSync.native(resolvedCommon), realpathSync.native(resolvedWorktreeCommon)) ||
        !samePath(realpathSync.native(resolvedCommon), expectedCommonDirectory(record.sourceRoot)) ||
        !samePath(resolve(record.sourceRoot, sourceTop), realpathSync.native(record.sourceRoot))) {
      return { observedHealth: "identity_mismatch", branchRef, observedAt, diagnosticCode: "ISOLATION_IDENTITY_MISMATCH" };
    }
    branchRef = candidateBranchRef;
    return { observedHealth: "present_consistent", branchRef, observedAt };
  } catch {
    // The path passed lstat above. A later ENOENT may be a failed Git probe
    // or concurrent removal; neither proves a safely missing worktree.
    return { observedHealth: "unverifiable", branchRef, observedAt, diagnosticCode: "ISOLATION_HEALTH_UNVERIFIABLE" };
  }
}
