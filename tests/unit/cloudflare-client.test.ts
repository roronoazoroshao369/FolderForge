import { describe, expect, it } from 'vitest';
import {
  CloudflareApiError,
  makeCloudflareClient,
} from '../../src/cloudflare/api-client.js';

interface CapturedCall {
  url: string;
  method: string;
  body?: unknown;
  auth?: string;
}

function fakeFetch(result: unknown, status = 200): { calls: CapturedCall[]; fetchImpl: typeof fetch } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: unknown, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body) : undefined,
      auth: init?.headers?.authorization,
    });
    const ok = status >= 200 && status < 300;
    return {
      ok,
      status,
      json: async () => (ok ? { success: true, result } : { success: false, errors: [{ message: 'cf says no' }] }),
    } as Response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const client = (fetchImpl: typeof fetch) =>
  makeCloudflareClient('tok_test_1234567890', { baseUrl: 'https://cf.test/v4', fetchImpl });

describe('cloudflare api client', () => {
  it('verifyToken calls the verify endpoint with the bearer token', async () => {
    const { calls, fetchImpl } = fakeFetch({ id: 'tok' });
    await client(fetchImpl).verifyToken();
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe('https://cf.test/v4/user/tokens/verify');
    expect(calls[0]?.auth).toBe('Bearer tok_test_1234567890');
  });

  it('resolveZoneId returns the first active zone and errors when none', async () => {
    const { calls, fetchImpl } = fakeFetch([{ id: 'zone-42' }]);
    const zoneId = await client(fetchImpl).resolveZoneId('example.com');
    expect(zoneId).toBe('zone-42');
    expect(calls[0]?.url).toContain('/zones?name=example.com');

    const empty = fakeFetch([]);
    await expect(client(empty.fetchImpl).resolveZoneId('nope.com')).rejects.toThrow(/No active Cloudflare zone/);
  });

  it('createTunnel posts name + secret and unwraps id/token', async () => {
    const { calls, fetchImpl } = fakeFetch({ id: 'cfTun1', token: 'tunnel-token' });
    const created = await client(fetchImpl).createTunnel('acc1', 'ff-mcp1.example.com', 'c2VjcmV0');
    expect(created).toEqual({ id: 'cfTun1', token: 'tunnel-token' });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://cf.test/v4/accounts/acc1/cfd_tunnel');
    expect(calls[0]?.body).toEqual({
      name: 'ff-mcp1.example.com',
      tunnel_secret: 'c2VjcmV0',
      config_src: 'cloudflare',
    });
  });

  it('putTunnelIngress writes hostname ingress with 404 fallback', async () => {
    const { calls, fetchImpl } = fakeFetch({});
    await client(fetchImpl).putTunnelIngress('acc1', 'cfTun1', 'mcp1.example.com', 'http://127.0.0.1:7410');
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toBe('https://cf.test/v4/accounts/acc1/cfd_tunnel/cfTun1/configurations');
    expect(calls[0]?.body).toEqual({
      config: {
        ingress: [
          { hostname: 'mcp1.example.com', service: 'http://127.0.0.1:7410' },
          { service: 'http_status:404' },
        ],
      },
    });
  });

  it('createDnsRecord posts a proxied CNAME to the tunnel domain', async () => {
    const { calls, fetchImpl } = fakeFetch({ id: 'dns1' });
    const record = await client(fetchImpl).createDnsRecord('zone-42', 'mcp1.example.com', 'cfTun1');
    expect(record).toEqual({ id: 'dns1' });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://cf.test/v4/zones/zone-42/dns_records');
    const body = calls[0]?.body as { type: string; name: string; content: string; proxied: boolean };
    expect(body.type).toBe('CNAME');
    expect(body.name).toBe('mcp1.example.com');
    expect(body.content).toBe('cfTun1.cfargotunnel.com');
    expect(body.proxied).toBe(true);
  });

  it('maps API failures to CloudflareApiError with the first message', async () => {
    const { fetchImpl } = fakeFetch(undefined, 403);
    const err = await client(fetchImpl).verifyToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudflareApiError);
    expect((err as CloudflareApiError).message).toBe('cf says no');
    expect((err as CloudflareApiError).status).toBe(403);
  });
});
