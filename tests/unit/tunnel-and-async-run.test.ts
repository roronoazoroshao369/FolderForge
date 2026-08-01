import { describe, expect, it } from 'vitest';
import {
  detectTunnelExposureFrom,
  detectTunnelExposure,
} from '../../src/server/tunnel-exposure.js';
import { startHttpTransport } from '../../src/server/transports/http.js';
import { loadConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { buildRegistry } from '../../src/tools/index.js';
import { isolatedFixture } from '../integration/fixtures.js';

describe('tunnel exposure detection', () => {
  it('flags known tunnel clients in a process list', () => {
    const exposure = detectTunnelExposureFrom([
      '/usr/bin/node /srv/app/main.js',
      '/usr/local/bin/cloudflared tunnel --url http://127.0.0.1:7331',
    ]);
    expect(exposure.exposed).toBe(true);
    expect(exposure.clients).toContain('cloudflared');
  });

  it('does not flag ordinary processes', () => {
    const exposure = detectTunnelExposureFrom([
      '/usr/bin/node /srv/app/main.js',
      'postgres: writer process',
    ]);
    expect(exposure.exposed).toBe(false);
    expect(exposure.clients).toEqual([]);
  });

  it('never throws when scanning the real host', () => {
    expect(() => detectTunnelExposure()).not.toThrow();
  });

  it('refuses an unauthenticated loopback bind while a tunnel client runs', async () => {
    await expect(
      startHttpTransport((() => undefined) as never, {
        host: '127.0.0.1',
        port: 0,
        authMode: 'none',
        detectTunnelExposure: () => ({ exposed: true, clients: ['cloudflared'] }),
      })
    ).rejects.toThrow(/tunnel client\(s\) cloudflared/);
  });

  it('allows the operator to override the tunnel refusal explicitly', async () => {
    // The override must not be silently ignored, so the server has to come up
    // even though the probe reports an active tunnel.
    const server = await startHttpTransport((() => undefined) as never, {
      host: '127.0.0.1',
      port: 0,
      authMode: 'none',
      allowUnauthenticatedTunnel: true,
      detectTunnelExposure: () => ({ exposed: true, clients: ['cloudflared'] }),
    });
    expect(server.listening).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('long-running build tools in async mode', () => {
  it('returns a pollable session instead of blocking the request', async () => {
    const projectRoot = isolatedFixture();
    const config = loadConfig({ projectRoot });
    const container = new Container(config);
    const registry = buildRegistry(container);

    const res = await registry.call('run_test', { async: true });
    expect(res.ok).toBe(true);
    const data = res.data as { async: boolean; sessionId: string; exitCode: null };
    expect(data.async).toBe(true);
    expect(data.sessionId).toBeTruthy();
    expect(data.exitCode).toBeNull();

    const tail = await registry.call('process_tail', {
      sessionId: data.sessionId,
      timeoutMs: 5000,
    });
    expect(tail.ok).toBe(true);
    await registry.call('process_stop', { sessionId: data.sessionId });
  });

  it('still runs synchronously by default', async () => {
    const projectRoot = isolatedFixture();
    const config = loadConfig({ projectRoot });
    const container = new Container(config);
    const registry = buildRegistry(container);

    const res = await registry.call('run_typecheck', {});
    const data = (res.data ?? {}) as { sessionId?: string };
    expect(data.sessionId).toBeUndefined();
  });
});
