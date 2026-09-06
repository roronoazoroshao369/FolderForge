import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function makeManager(
  cloudflare?: ReturnType<typeof makeFakeCloudflare>['hook'],
  overrides: {
    listProcessArgs?: () => Array<{ pid: number; args: string }>;
    platform?: NodeJS.Platform;
  } = {},
) {
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
    ...overrides,
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

  it('refuses to start when an external cloudflared already serves the hostname (proposal 009)', async () => {
    const cf = makeFakeCloudflare();
    const dir = mkdtempSync(join(tmpdir(), 'ff-tunnel-dupe-'));
    try {
      const configPath = join(dir, 'folder-forge.yml');
      writeFileSync(
        configPath,
        `ingress:\n  - hostname: mcp1.example.com\n    service: http://localhost:3112\n  - service: http_status:404\n`,
      );
      const { manager, spawned } = makeManager(cf.hook, {
        listProcessArgs: () => [
          { pid: 4242, args: `cloudflared tunnel --config ${configPath} run folder-forge` },
        ],
      });
      await expect(
        manager.startNamed({ targetPort: 7410, hostname: 'mcp1.example.com' }),
      ).rejects.toThrow(/pid 4242 already serves hostname mcp1\.example\.com/);
      // The guard fires before any Cloudflare call or spawn.
      expect(cf.calls).toHaveLength(0);
      expect(spawned).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('proceeds when the process scan finds no matching config', async () => {
    const cf = makeFakeCloudflare();
    const { manager } = makeManager(cf.hook, { listProcessArgs: () => [] });
    const record = await manager.startNamed({ targetPort: 7410, hostname: 'mcp1.example.com' });
    expect(record.state).toBe('running');
  });

  it('skips the duplicate guard on Windows even when the scanner would throw', async () => {
    const cf = makeFakeCloudflare();
    const { manager } = makeManager(cf.hook, {
      platform: 'win32',
      listProcessArgs: () => {
        throw new Error('ps does not exist here');
      },
    });
    const record = await manager.startNamed({ targetPort: 7410, hostname: 'mcp1.example.com' });
    expect(record.state).toBe('running');
  });
});
