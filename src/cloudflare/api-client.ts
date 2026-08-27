/**
 * Minimal Cloudflare v4 API client for named tunnels (ADR-0012, Phase 4).
 *
 * Token-only: the operator links an API token with Tunnel+DNS edit rights;
 * no browser `cloudflared login` / cert.pem flow is required. The base URL is
 * overridable (env or option) so tests can point at a local fake.
 */

export class CloudflareApiError extends Error {
  readonly status: number;
  readonly errors: unknown;
  constructor(message: string, status: number, errors: unknown) {
    super(message);
    this.name = 'CloudflareApiError';
    this.status = status;
    this.errors = errors;
  }
}

export interface CloudflareClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface CloudflareClient {
  verifyToken(): Promise<unknown>;
  resolveZoneId(domain: string): Promise<string>;
  createTunnel(
    accountId: string,
    name: string,
    secretB64: string,
  ): Promise<{ id: string; token: string }>;
  putTunnelIngress(
    accountId: string,
    tunnelId: string,
    hostname: string,
    service: string,
  ): Promise<void>;
  createDnsRecord(
    zoneId: string,
    hostname: string,
    tunnelId: string,
  ): Promise<{ id: string }>;
  deleteDnsRecord(zoneId: string, recordId: string): Promise<void>;
  deleteTunnel(accountId: string, tunnelId: string): Promise<void>;
}

export const CLOUDFLARE_API_BASE_URL_ENV = 'FOLDERFORGE_CF_API_BASE_URL';
const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4';

export function makeCloudflareClient(
  apiToken: string,
  options: CloudflareClientOptions = {},
): CloudflareClient {
  const baseUrl = (
    options.baseUrl ??
    process.env[CLOUDFLARE_API_BASE_URL_ENV] ??
    DEFAULT_BASE_URL
  ).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;

  async function call(method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiToken}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
    const json: any = await response.json().catch(() => null);
    if (!response.ok || json?.success === false) {
      const first = Array.isArray(json?.errors) && json.errors[0];
      const message =
        (first && (first.message as string)) ||
        `Cloudflare API ${method} ${path} failed with HTTP ${response.status}.`;
      throw new CloudflareApiError(message, response.status, json?.errors);
    }
    return json?.result;
  }

  return {
    verifyToken: () => call('GET', '/user/tokens/verify'),

    async resolveZoneId(domain: string): Promise<string> {
      const zones = await call(
        'GET',
        `/zones?name=${encodeURIComponent(domain)}&status=active`,
      );
      const zone = Array.isArray(zones) ? zones[0] : undefined;
      if (!zone?.id) {
        throw new CloudflareApiError(
          `No active Cloudflare zone found for "${domain}" on this account.`,
          404,
          undefined,
        );
      }
      return zone.id as string;
    },

    async createTunnel(accountId, name, secretB64) {
      const result = await call('POST', `/accounts/${accountId}/cfd_tunnel`, {
        name,
        tunnel_secret: secretB64,
        config_src: 'cloudflare',
      });
      if (!result?.id || !result?.token) {
        throw new CloudflareApiError(
          'Cloudflare did not return a tunnel id + token.',
          502,
          result,
        );
      }
      return { id: result.id as string, token: result.token as string };
    },

    async putTunnelIngress(accountId, tunnelId, hostname, service) {
      await call('PUT', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
        config: {
          ingress: [{ hostname, service }, { service: 'http_status:404' }],
        },
      });
    },

    async createDnsRecord(zoneId, hostname, tunnelId) {
      const result = await call('POST', `/zones/${zoneId}/dns_records`, {
        type: 'CNAME',
        name: hostname,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
        comment: 'Managed by FolderForge Mission Control',
      });
      if (!result?.id) {
        throw new CloudflareApiError('Cloudflare did not return a DNS record id.', 502, result);
      }
      return { id: result.id as string };
    },

    deleteDnsRecord: (zoneId, recordId) =>
      call('DELETE', `/zones/${zoneId}/dns_records/${recordId}`),
    deleteTunnel: (accountId, tunnelId) =>
      call('DELETE', `/accounts/${accountId}/cfd_tunnel/${tunnelId}`),
  };
}
