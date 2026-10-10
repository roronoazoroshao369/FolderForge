import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../packages/mission-control/src/api.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('Mission Control high-risk API requests', () => {
  it('uses Authorization bearer header, never query token, for a sensitive Fleet intent request', async () => {
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:7410', search: '?token=dashboard-secret' });
    vi.stubGlobal('localStorage', { getItem: () => null });
    const sent = vi.fn(async () => new Response(JSON.stringify({ status: 'pending' }), { status: 202 }));
    vi.stubGlobal('fetch', sent);
    await api('/fleet/flt_12345678/profile-intents', {
      method: 'POST',
      body: { toolsPreset: 'full', policyMode: 'danger', terminalExecution: 'trusted-host' },
      sensitive: true,
    });
    const [url, opts] = sent.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).searchParams.has('token')).toBe(false);
    expect((opts.headers as Record<string, string>).authorization).toBe('Bearer dashboard-secret');
    expect(opts.method).toBe('POST');
  });
});
