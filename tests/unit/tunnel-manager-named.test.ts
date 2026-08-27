import { describe, expect, it } from 'vitest';
import { TunnelManager } from '../../src/tunnels/tunnel-manager.js';

interface FakeCall {
  method: string;
  args: unknown[];
}

function makeFakeCloudflare(options: { failDns?: boolean } = {}) {
  const calls: FakeCall[] = [];
  const config = {
    accountId: 'acc1',
    zoneId: 'zone-1',
    domain: 'example.com',
    apiToken: 'tok_x',
    linkedAt: '2026-08-26T00:00:00.000Z',
  };
  const client = {
    createTunnel: async (accountId: string, name: string, secret: string) => {
      calls.push({ method: 'createTunnel', args: [accountId, name, secret] });
      return { id: 'cfTun1', token: 'tunnel-token-abc' };
    },
    putTunnelIngress: async (accountId: string, tunnelId: string, hostname: string, service: string) => {
      calls.push({ method: 'putTunnelIngress', args: [accountId, tunnelId, hostname, service] });
    },
    createDnsRecord: async (zoneId: string, hostname: string, tunnelId: string) => {
      calls.push({ method: 'createDnsRecord', args: [zoneId, hostname, tunnelId] });
      if (options.failDns) throw new Error('dns exploded');
      return { id: 'dns1' };
    },
    deleteDnsRecord: async (zoneId: string, recordId: string) => {
      calls.push({ method: 'deleteDnsRecord', args: [zoneId, recordId] });
    },
    deleteTunnel: async (accountId: string, tunnelId: string) => {
      calls.push({ method: 'deleteTunnel', args: [accountId, tunnelId] });
    },
  };
  return {
    calls,
    hook: {
      loadConfig: () => config,
      makeClient: () => client,
    },
  };
}

function makeManager(cloudflare?: ReturnType<typeof makeFakeCloudflare>['hook']) {
  const spawned: string[] = [];
  const manager = new TunnelManager({
    spawn: (command) => {
      spawned.push(command);
      return { sessionId: 'sess1', pid: 4321 };
    },
    stopSession: () => undefined,
    readSession: () => 'INF Registered tunnel connection connIndex=0',
    onExit: () => () => undefined,
    cloudflare,
    urlPollMs: 5,
    urlTimeoutMs: 2_000,
  });
  return { manager, spawned };
}

describe('TunnelManager named tunnels', () => {
  it('creates tunnel + ingress + DNS, spawns cloudflared with the token, and reports the stable URL', async () => {
    const cf = makeFakeCloudflare();
    const { manager, spawned } = makeManager(cf.hook);
    const record = await manager.startNamed({ targetPort: 7410, hostname: 'mcp1.example.com', actor: 'test' });
    expect(record.state).toBe('running');
    expect(record.kind).toBe('named');
    expect(record.hostname).toBe('mcp1.example.com');
    expect(record.publicUrl).toBe('https://' + 'mcp1.example.com');
    expect(record.cfTunnelId).toBe('cfTun1');
    expect(record.dnsRecordId).toBe('dns1');
    expect(cf.calls.map((c) => c.method)).toEqual(['createTunnel', 'putTunnelIngress', 'createDnsRecord']);
    expect(spawned[0]).toContain('tunnel --no-autoupdate run --token');
    expect(spawned[0]).toContain('tunnel-token-abc');
  });

  it('rejects hostnames outside the linked domain', async () => {
    const cf = makeFakeCloudflare();
    const { manager } = makeManager(cf.hook);
    await expect(
      manager.startNamed({ targetPort: 7410, hostname: 'mcp1.other.com' }),
    ).rejects.toThrow(/under the linked domain/);
    expect(cf.calls).toHaveLength(0);
  });

  it('rejects a duplicate hostname while one is active', async () => {
    const cf = makeFakeCloudflare();
    const { manager } = makeManager(cf.hook);
    await manager.startNamed({ targetPort: 7410, hostname: 'mcp1.example.com' });
    await expect(
      manager.startNamed({ targetPort: 7411, hostname: 'mcp1.example.com' }),
    ).rejects.toThrow(/already exposed/);
  });

  it('fails cleanly when no Cloudflare account is linked', async () => {
    const { manager } = makeManager(undefined);
    await expect(
      manager.startNamed({ targetPort: 7410, hostname: 'mcp1.example.com' }),
    ).rejects.toThrow(/cloudflare_not_configured/);
  });

  it('rolls back the Cloudflare tunnel when DNS creation fails', async () => {
    const cf = makeFakeCloudflare({ failDns: true });
    const { manager } = makeManager(cf.hook);
    await expect(
      manager.startNamed({ targetPort: 7410, hostname: 'mcp1.example.com' }),
    ).rejects.toThrow(/dns exploded/);
    expect(cf.calls.map((c) => c.method)).toContain('deleteTunnel');
    const record = manager.list().find((t) => t.hostname === 'mcp1.example.com');
    expect(record?.state).toBe('failed');
  });

  it('destroy stops the process and deletes DNS + tunnel on Cloudflare', async () => {
    const cf = makeFakeCloudflare();
    const { manager } = makeManager(cf.hook);
    const record = await manager.startNamed({ targetPort: 7410, hostname: 'mcp1.example.com' });
    const destroyed = await manager.destroy(record.id);
    expect(destroyed.state).toBe('stopped');
    const methods = cf.calls.map((c) => c.method);
    expect(methods).toContain('deleteDnsRecord');
    expect(methods).toContain('deleteTunnel');
  });
});
