import { logger } from '../core/logger.js';

/**
 * Narrow structural surface of the runtime Container for shutdown: every
 * component that owns OS processes spawned on behalf of this plane.
 * Satisfied structurally by `Container` — kept narrow for testability.
 */
export interface ManagedProcessSurface {
  fleet: { shutdownAll: () => void };
  tunnels: { stopAll: () => void };
  processes: { stopAllAndWait: (graceMs?: number) => Promise<unknown> };
}

/**
 * Stop every process this plane manages — fleet instances, OpenAI tunnel
 * supervisors, quick/named tunnels, and any agent-started session — so a
 * SIGTERM/SIGINT never leaves orphans behind holding ports (fleet reconnect
 * recovery; see CHANGELOG Unreleased).
 *
 * Order matters: the fleet and tunnel managers stop their own sessions first
 * (keeping state files consistent), then the process manager acts as the
 * backstop that waits for exits and escalates stragglers to SIGKILL.
 */
export async function stopManagedProcessTrees(
  container: ManagedProcessSurface,
  graceMs = 1_500,
): Promise<void> {
  container.fleet.shutdownAll();
  container.tunnels.stopAll();
  await container.processes.stopAllAndWait(graceMs);
  logger.info({ graceMs }, 'Managed process trees stopped');
}
