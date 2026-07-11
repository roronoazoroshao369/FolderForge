import { spawnSync, type ChildProcess } from 'node:child_process';

/**
 * Terminate a managed child and, on Windows, its complete descendant tree.
 *
 * Windows does not provide POSIX process-group signals. A shell-launched command
 * may therefore outlive cmd.exe and keep its working directory locked after
 * ChildProcess.kill(). taskkill /T waits for the requested process tree to be
 * torn down before returning; /F is required for deterministic CI cleanup.
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

  try {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // The process may have exited between the state check and termination.
  }
}
