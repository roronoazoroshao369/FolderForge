import { spawnSync } from 'node:child_process';

/**
 * A loopback bind is normally safe without authentication because only local
 * processes can reach it. That assumption breaks the moment a tunnel client
 * republishes 127.0.0.1 on a public hostname, which is exactly how a
 * "localhost only" server ends up answering anonymous requests from the
 * internet. We therefore look for tunnel clients before allowing authMode
 * "none".
 */
export const TUNNEL_CLIENT_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'cloudflared', pattern: /(^|[/\s])cloudflared(\s|$)/ },
  { name: 'ngrok', pattern: /(^|[/\s])ngrok(\s|$)/ },
  { name: 'localtunnel', pattern: /(^|[/\s])(localtunnel|lt)\s+--port/ },
  { name: 'tailscale-funnel', pattern: /tailscale\s+(funnel|serve)/ },
  { name: 'bore', pattern: /(^|[/\s])bore\s+local/ },
  { name: 'frpc', pattern: /(^|[/\s])frpc(\s|$)/ },
];

export interface TunnelExposure {
  /** True when at least one known tunnel client is running on this host. */
  exposed: boolean;
  /** Names of the detected tunnel clients, sorted and de-duplicated. */
  clients: string[];
}

/** Pure matcher over process command lines, kept separate so it is testable. */
export function detectTunnelExposureFrom(processLines: readonly string[]): TunnelExposure {
  const clients = new Set<string>();
  for (const line of processLines) {
    for (const { name, pattern } of TUNNEL_CLIENT_PATTERNS) {
      if (pattern.test(line)) clients.add(name);
    }
  }
  return { exposed: clients.size > 0, clients: [...clients].sort() };
}

/** Best-effort host scan. Any failure is reported as "no tunnel detected". */
export function detectTunnelExposure(): TunnelExposure {
  try {
    const res =
      process.platform === 'win32'
        ? spawnSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 3000 })
        : spawnSync('ps', ['-eo', 'args='], { encoding: 'utf8', timeout: 3000 });
    if (res.status !== 0 || typeof res.stdout !== 'string') return { exposed: false, clients: [] };
    return detectTunnelExposureFrom(res.stdout.split('\n'));
  } catch {
    return { exposed: false, clients: [] };
  }
}
