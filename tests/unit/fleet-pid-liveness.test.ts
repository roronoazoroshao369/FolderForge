import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultPidAlive } from '../../src/provisioner/fleet-manager.js';

afterEach(() => vi.restoreAllMocks());

describe('fail-closed Fleet PID liveness', () => {
  it('treats permission failures and ambiguous OS errors as possibly alive', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });
    expect(defaultPidAlive(424242)).toBe(true);
    kill.mockImplementation(() => {
      throw Object.assign(new Error('unknown error'), { code: 'EIO' });
    });
    expect(defaultPidAlive(424242)).toBe(true);
    kill.mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    expect(defaultPidAlive(424242)).toBe(false);
  });
});
