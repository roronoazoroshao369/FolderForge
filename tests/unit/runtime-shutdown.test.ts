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
  it('stops fleet state, tunnel state, then waits on the process manager', async () => {
    const { surface: target, calls } = surface();
    await stopManagedProcessTrees(target, 1_700);
    // Managers converge their state files first; the process manager is the
    // backstop that waits for exits and escalates stragglers to SIGKILL.
    expect(calls).toEqual(['fleet', 'tunnels', 'processes:1700']);
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
    expect(calls).toEqual(['fleet', 'tunnels']);
  });
});
