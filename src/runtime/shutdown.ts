import { logger } from '../core/logger.js';

/**
 * Narrow structural surface of the runtime Container for shutdown: every
 * component that owns OS processes spawned on behalf of this plane.
 * Satisfied structurally by `Container` — kept narrow for testability.
 */
export interface ManagedProcessSurface {
  verifications: { stopAllExecutions: (graceMs?: number) => Promise<unknown> };
  fleet: { shutdownAll: () => void };
  tunnels: { stopAll: () => void };
  processes: { stopAllAndWait: (graceMs?: number) => Promise<unknown> };
}

/**
 * Stop every process this plane manages — in-flight verification checks,
 * fleet instances, OpenAI tunnel supervisors, quick/named tunnels, and any
 * agent-started session — so a SIGTERM/SIGINT never leaves orphans behind
 * holding ports (fleet reconnect recovery; see CHANGELOG Unreleased).
 *
 * Order matters: verification executors are aborted first because their check
 * children spawn detached (their own POSIX process group) outside the process
 * manager — no other leg can reach them (proposal 015). The fleet and tunnel
 * managers stop their own sessions next (keeping state files consistent),
 * then the process manager acts as the backstop that waits for exits and
 * escalates stragglers to SIGKILL.
 */
export async function stopManagedProcessTrees(
  container: ManagedProcessSurface,
  graceMs = 1_500,
): Promise<void> {
  // Failure-isolated: a broken verification evidence store must never hold
  // the rest of the shutdown sweep hostage.
  try {
    await container.verifications.stopAllExecutions(graceMs);
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'Verification executor sweep failed during shutdown; continuing',
    );
  }
  container.fleet.shutdownAll();
  container.tunnels.stopAll();
  await container.processes.stopAllAndWait(graceMs);
  logger.info({ graceMs }, 'Managed process trees stopped');
}
