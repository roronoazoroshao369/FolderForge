import { describe, expect, it } from 'vitest';

import {
  stopManagedProcessTrees,
  type ManagedProcessSurface,
} from '../../src/runtime/shutdown.js';

function surface(overrides: Partial<ManagedProcessSurface> = {}): {
  surface: ManagedProcessSurface;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    surface: {
      verifications: {
        stopAllExecutions: async (graceMs?: number) => {
          calls.push(`verifications:${graceMs}`);
        },
      },
      fleet: {
        shutdownAll: () => {
          calls.push('fleet');
        },
      },
      tunnels: {
        stopAll: () => {
          calls.push('tunnels');
        },
      },
      processes: {
        stopAllAndWait: async (graceMs?: number) => {
          calls.push(`processes:${graceMs}`);
        },
      },
      ...overrides,
    },
  };
}

describe('stopManagedProcessTrees', () => {
  it('sweeps verification executors first, then fleet state, tunnel state, then waits on the process manager', async () => {
    const { surface: target, calls } = surface();
    await stopManagedProcessTrees(target, 1_700);
    // Verification children spawn detached outside the process manager, so
    // their run-scoped controllers are aborted first; managers converge their
    // state files next; the process manager is the backstop that waits for
    // exits and escalates stragglers to SIGKILL.
    expect(calls).toEqual(['verifications:1700', 'fleet', 'tunnels', 'processes:1700']);
  });

  it('uses the default grace and still ran fleet/tunnels when waiting fails', async () => {
    const { surface: target, calls } = surface({
      processes: {
        stopAllAndWait: async () => {
          throw new Error('wait blew up');
        },
      },
    });
    await expect(stopManagedProcessTrees(target)).rejects.toThrow('wait blew up');
    expect(calls).toEqual(['verifications:1500', 'fleet', 'tunnels']);
  });

  it('continues the sweep when the verification leg fails (fail-safe)', async () => {
    const { surface: target, calls } = surface({
      verifications: {
        stopAllExecutions: async () => {
          calls.push('verifications:fail');
          throw new Error('evidence store blew up');
        },
      },
    });
    await stopManagedProcessTrees(target, 1_700);
    expect(calls).toEqual(['verifications:fail', 'fleet', 'tunnels', 'processes:1700']);
  });
});
