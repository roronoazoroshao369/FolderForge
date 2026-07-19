import { createServer } from 'node:http';
import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { ChildMcpRegistry } from '../../src/adapters/child-mcp/registry.js';
import { BrowserEmulationManager } from '../../src/browser/emulation-manager.js';
import { ShapingProxy } from '../../src/browser/network-proxy.js';

function registry(): ChildMcpRegistry {
  return new ChildMcpRegistry({
    serena: { enabled: false, command: 'serena', args: [] },
    playwright: { enabled: true, command: 'node', args: ['playwright.mjs', '--isolated'] },
    desktopCommander: { enabled: false, command: 'npx', args: [] },
  });
}

function proxyGet(proxyPort: number, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: proxyPort,
      path: target,
      method: 'GET',
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.end();
  });
}

describe('browser device and network emulation', () => {
  it('applies and resets Playwright device/network arguments without losing baseline args', async () => {
    const adapters = registry();
    const manager = new BrowserEmulationManager(adapters);
    const applied = await manager.apply({ preset: 'slow3g' });
    expect(applied).toMatchObject({
      active: true,
      preset: 'slow3g',
      viewport: { width: 1365, height: 768 },
      network: { running: true, shape: { latencyMs: 400, downloadBytesPerSecond: 400000 } },
    });
    const args = adapters.definition('playwright')!.args;
    expect(args).toEqual(expect.arrayContaining(['--isolated', '--viewport-size', '1365x768', '--proxy-server']));
    expect(args.some((value) => value.startsWith('http://127.0.0.1:'))).toBe(true);

    const reset = await manager.reset();
    expect(reset).toMatchObject({ active: false, preset: 'none', network: { running: false } });
    expect(adapters.definition('playwright')!.args).toEqual(['playwright.mjs', '--isolated']);
    await manager.close();
  });

  it('rejects conflicting device and viewport settings', async () => {
    const manager = new BrowserEmulationManager(registry());
    await expect(manager.apply({ device: 'iPhone 15', viewport: { width: 390, height: 844 } })).rejects.toThrow(/mutually exclusive/);
    await manager.close();
  });

  it('enforces offline mode and forwards online HTTP requests through loopback proxy', async () => {
    const upstream = createServer((_req, res) => res.end('proxy-ok'));
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address !== 'object') throw new Error('missing upstream address');
    const target = `http://127.0.0.1:${address.port}/test`;
    const proxy = new ShapingProxy();
    const status = await proxy.start({ offline: true });
    expect(await proxyGet(status.port!, target)).toMatchObject({ status: 503, body: expect.stringContaining('offline') });
    proxy.configure({ offline: false, latencyMs: 1 });
    expect(await proxyGet(status.port!, target)).toEqual({ status: 200, body: 'proxy-ok' });
    expect(proxy.status()).toMatchObject({ requests: 2, rejected: 1, bytesDown: expect.any(Number) });
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
});
