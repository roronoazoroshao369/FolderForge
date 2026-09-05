import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
  /** Ports positively identified as being published by a running tunnel client. */
  exposedPorts: number[];
  /** True when a client is running but its published ports could not be determined. */
  unknownExposure: boolean;
}

type ConfigReader = (path: string) => string | null;

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

/** Parse a URL and return the loopback port it targets, or null when not loopback. */
function loopbackUrlPort(raw: string): number | null {
  try {
    const url = new URL(raw);
    if (!isLoopbackHostname(url.hostname)) return null;
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

/** Extract the value of a CLI flag: --flag value, --flag=value, quoted forms allowed. */
function readFlagValue(source: string, flag: string): string | undefined {
  const match = new RegExp(`${flag}[=\\s]+(?:"([^"]+)"|'([^']+)'|(\\S+))`).exec(source);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

/** Extract the host ports one tunnel command line publishes (best-effort, per client). */
function extractPublishedPorts(
  name: string,
  line: string,
  readConfig: ConfigReader | undefined,
): { ports: number[]; unknown: boolean } {
  const ports = new Set<number>();
  const addPort = (raw: string | number | undefined): void => {
    const port = Number(raw);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port);
  };

  switch (name) {
    case 'cloudflared': {
      // Quick tunnel: cloudflared tunnel --url http://127.0.0.1:7410
      const urlFlag = readFlagValue(line, '--url');
      if (urlFlag) {
        // A non-loopback or portless target republishes no loopback port.
        const port = loopbackUrlPort(urlFlag);
        if (port !== null) addPort(port);
        return { ports: [...ports], unknown: false };
      }
      // Named tunnel: cloudflared tunnel --config <file> run <name>
      const configPath = readFlagValue(line, '--config');
      if (configPath) {
        const config = readConfig ? readConfig(configPath) : null;
        if (config === null || config === undefined) return { ports: [], unknown: true };
        for (const cfgLine of config.split('\n')) {
          // ingress rules: "  - service: http://127.0.0.1:7410" (http_status:404 catch-alls yield nothing)
          const idx = cfgLine.indexOf('service:');
          if (idx === -1) continue;
          const port = loopbackUrlPort(cfgLine.slice(idx + 'service:'.length).trim());
          if (port !== null) addPort(port);
        }
        return { ports: [...ports], unknown: false };
      }
      // `cloudflared tunnel run --token …`: routing is decided server-side; cannot inspect.
      return { ports: [], unknown: true };
    }
    case 'ngrok': {
      const target = /\bngrok\s+(?:http|tcp|tls)\s+(\S+)/i.exec(line);
      const arg = target?.[1];
      if (arg) {
        if (/^\d+$/.test(arg)) {
          addPort(arg);
          return { ports: [...ports], unknown: false };
        }
        const hostPort = /:(\d+)$/.exec(arg);
        if (hostPort) {
          addPort(hostPort[1]);
          return { ports: [...ports], unknown: false };
        }
      }
      return { ports: [], unknown: true };
    }
    case 'localtunnel': {
      const port = /--port\s+(\d+)/.exec(line);
      if (port) {
        addPort(port[1]);
        return { ports: [...ports], unknown: false };
      }
      return { ports: [], unknown: true };
    }
    case 'bore': {
      const port = /\bbore\s+local\s+(\d+)/.exec(line);
      if (port) {
        addPort(port[1]);
        return { ports: [...ports], unknown: false };
      }
      return { ports: [], unknown: true };
    }
    case 'tailscale-funnel': {
      for (const token of line.split(/\s+/)) {
        const port = token.startsWith('http') ? loopbackUrlPort(token) : null;
        if (port !== null) {
          addPort(port);
          return { ports: [...ports], unknown: false };
        }
      }
      return { ports: [], unknown: true };
    }
    case 'frpc': {
      const configPath = readFlagValue(line, '-c') ?? readFlagValue(line, '--config');
      if (configPath) {
        const config = readConfig ? readConfig(configPath) : null;
        if (config === null || config === undefined) return { ports: [], unknown: true };
        for (const cfgLine of config.split('\n')) {
          const localPort = /^\s*(?:localPort|local_port)\s*=\s*(\d+)/.exec(cfgLine);
          if (localPort) addPort(localPort[1]);
        }
        return { ports: [...ports], unknown: false };
      }
      return { ports: [], unknown: true };
    }
    default:
      return { ports: [], unknown: true };
  }
}

/** Pure matcher over process command lines, kept separate so it is testable. */
export function detectTunnelExposureFrom(
  processLines: readonly string[],
  readConfig?: ConfigReader,
): TunnelExposure {
  const clients = new Set<string>();
  const exposedPorts = new Set<number>();
  let unknownExposure = false;
  for (const line of processLines) {
    for (const { name, pattern } of TUNNEL_CLIENT_PATTERNS) {
      if (pattern.test(line)) {
        clients.add(name);
        const { ports, unknown } = extractPublishedPorts(name, line, readConfig);
        for (const port of ports) exposedPorts.add(port);
        if (unknown) unknownExposure = true;
      }
    }
  }
  return {
    exposed: clients.size > 0,
    clients: [...clients].sort(),
    exposedPorts: [...exposedPorts].sort((a, b) => a - b),
    unknownExposure,
  };
}

function readConfigSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Best-effort host scan. Any failure is reported as "no tunnel detected". */
export function detectTunnelExposure(): TunnelExposure {
  const empty: TunnelExposure = { exposed: false, clients: [], exposedPorts: [], unknownExposure: false };
  try {
    const res =
      process.platform === 'win32'
        ? spawnSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 3000 })
        : spawnSync('ps', ['-eo', 'args='], { encoding: 'utf8', timeout: 3000 });
    if (res.status !== 0 || typeof res.stdout !== 'string') return empty;
    // Windows tasklist yields image names without arguments, so published ports
    // cannot be determined there and any detected client stays conservative.
    return detectTunnelExposureFrom(
      res.stdout.split('\n'),
      process.platform === 'win32' ? undefined : readConfigSafe,
    );
  } catch {
    return empty;
  }
}
