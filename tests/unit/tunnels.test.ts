import { describe, expect, it } from 'vitest';
import { TunnelManager } from '../../src/tunnels/tunnel-manager.js';

function stubSpawner(calls: string[]) {
  let counter = 0;
  return (command: string, cwd: string) => {
    counter += 1;
    calls.push(`${command} @ ${cwd}`);
    return { sessionId: `proc_tun_${counter}`, pid: 5000 + counter };
  };
}

const READY_LOG = `
2026-08-26 INF +--------------------------------------------------------------------------------------------+
2026-08-26 INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-08-26 INF |  https://brave-fox-123.trycloudflare.com                                                   |
`;

describe('TunnelManager', () => {
  it('starts a tunnel and parses the public URL from output', async () => {
    const calls: string[] = [];
    const manager = new TunnelManager({
      spawn: stubSpawner(calls),
      readSession: () => READY_LOG,
      urlPollMs: 5,
    });
    const tunnel = await manager.start({ targetPort: 7410, actor: 'test' });
    expect(tunnel.state).toBe('running');
    expect(tunnel.publicUrl).toBe('https://brave-fox-123.trycloudflare.com');
    expect(calls[0]).toContain('cloudflared tunnel --url "http://127.0.0.1:7410"');
    expect(calls[0]).toContain('--no-autoupdate');
  });

  it('rejects invalid ports and duplicate exposures', async () => {
    const manager = new TunnelManager({
      spawn: stubSpawner([]),
      readSession: () => READY_LOG,
      urlPollMs: 5,
    });
    await expect(manager.start({ targetPort: 80 })).rejects.toThrow(/Invalid target port/);
    await manager.start({ targetPort: 7410 });
    await expect(manager.start({ targetPort: 7410 })).rejects.toThrow(/already exposed/);
  });

  it('fails clearly when the public URL never appears', async () => {
    const manager = new TunnelManager({
      spawn: stubSpawner([]),
      readSession: () => '',
      urlTimeoutMs: 40,
      urlPollMs: 5,
    });
    await expect(manager.start({ targetPort: 7410 })).rejects.toThrow(/Timed out/);
    expect(manager.list()[0]?.state).toBe('failed');
  });

  it('marks the tunnel failed when the process exits unexpectedly', async () => {
    const exitListeners = new Map<string, () => void>();
    const manager = new TunnelManager({
      spawn: stubSpawner([]),
      readSession: () => READY_LOG,
      urlPollMs: 5,
      onExit: (sessionId, listener) => {
        exitListeners.set(sessionId, listener);
        return () => {
          exitListeners.delete(sessionId);
        };
      },
    });
    const tunnel = await manager.start({ targetPort: 7410 });
    exitListeners.get('proc_tun_1')?.();
    const after = manager.get(tunnel.id);
    expect(after.state).toBe('failed');
    // The public URL stays visible so the operator knows what to revoke/republish.
    expect(after.publicUrl).toBe('https://brave-fox-123.trycloudflare.com');
  });

  it('stops a running tunnel and ignores repeated stops', async () => {
    const stopped: string[] = [];
    const manager = new TunnelManager({
      spawn: stubSpawner([]),
      stopSession: (sessionId) => {
        stopped.push(sessionId);
      },
      readSession: () => READY_LOG,
      urlPollMs: 5,
    });
    const tunnel = await manager.start({ targetPort: 7410 });
    const result = manager.stop(tunnel.id);
    expect(result.state).toBe('stopped');
    expect(stopped).toEqual(['proc_tun_1']);
    expect(manager.stop(tunnel.id).state).toBe('stopped');
    expect(stopped).toHaveLength(1);
  });
});
