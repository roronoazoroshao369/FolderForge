import { spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Terminate a managed child and, as far as the platform allows, its complete
 * descendant tree.
 *
 * Windows does not provide POSIX process-group signals. A shell-launched command
 * may therefore outlive cmd.exe and keep its working directory locked after
 * ChildProcess.kill(). taskkill /T waits for the requested process tree to be
 * torn down before returning; /F is required for deterministic CI cleanup.
 *
 * On POSIX, children spawned through ProcessManager are their own process-group
 * leaders (spawned detached), so signalling the negative pid reaches the whole
 * tree — including grandchildren a login shell forked without exec'ing them.
 * When the group signal fails (ESRCH: not a group leader, or already gone) we
 * fall back to signalling the child alone, which preserves the previous
 * behavior for children spawned outside ProcessManager.
 */
export function terminateChildProcessTree(
  child: ChildProcess,
  force = false,
  platform: NodeJS.Platform = process.platform
): void {
  if (child.exitCode !== null || child.signalCode !== null) return;

  if (platform === 'win32' && child.pid !== undefined) {
    const result = spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    if (result.error === undefined && result.status === 0) return;
  }

  if (platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
      return;
    } catch {
      // Not a process-group leader (or already gone): signal the child directly.
    }
  }

  try {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // The process may have exited between the state check and termination.
  }
}

/**
 * Terminate a process tree by pid (POSIX process-group kill, Windows
 * taskkill /T). Used to reap ORPHANED FolderForge children whose ChildProcess
 * handle was lost across a control-plane restart.
 *
 * Callers MUST verify the pid's identity first (see `processCommandLine`): a
 * recycled pid can belong to an unrelated process, and a group kill would take
 * down that whole tree. This function deliberately performs no identity check
 * itself so the gate stays explicit at the call site.
 */
export function terminatePidTree(
  pid: number,
  force = false,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', ...(force ? ['/f'] : [])], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
    return;
  } catch {
    // Not a process-group leader; signal the lone process instead.
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // Already gone.
  }
}

/**
 * Best-effort command line for a pid (Linux /proc first, `ps` fallback).
 * Returns undefined when the command line cannot be read on this platform —
 * callers must treat undefined as "unverified" and refuse destructive action.
 */
export function processCommandLine(
  pid: number,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (platform === 'win32') return undefined;
  try {
    // Linux: NUL-separated argv.
    const raw = readFileSync(`/proc/${pid}/cmdline`);
    const line = raw.toString('utf8').replace(/\0/g, ' ').trim();
    if (line) return line;
  } catch {
    // Not Linux, no /proc, or the process just exited: fall through to ps.
  }
  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    });
    if (result.error === undefined && result.status === 0) {
      const line = result.stdout.toString('utf8').trim();
      return line || undefined;
    }
  } catch {
    // ps unavailable.
  }
  return undefined;
}
