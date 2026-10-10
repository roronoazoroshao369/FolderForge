import { describe, expect, it, vi, afterEach } from 'vitest';
import { startTrustedHostRevocationMonitor } from '../../src/operator/trusted-host-monitor.js';

afterEach(() => { vi.useRealTimers(); });
describe('host consent revocation monitor', () => {
  it('reconciles revoked Fleet children periodically and stops polling on shutdown', () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const audit = vi.fn();
    const cancel = startTrustedHostRevocationMonitor({ reconcileRevokedTrustedHosts: report.mockReturnValue(['flt_123']) }, audit, 250);
    vi.advanceTimersByTime(250);
    expect(report).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith('flt_123');
    cancel();
    vi.advanceTimersByTime(1000);
    expect(report).toHaveBeenCalledTimes(1);
  });
  it('does not expose an unhandled error when a reconcile cycle fails', () => {
    vi.useFakeTimers();
    const report = vi.fn().mockImplementation(() => { throw new Error('audit down'); });
    const cancel = startTrustedHostRevocationMonitor({ reconcileRevokedTrustedHosts: report }, () => {}, 250);
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(report).toHaveBeenCalledTimes(2);
    cancel();
  });
});
