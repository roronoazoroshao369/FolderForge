/**
 * `tunnel` — supervise a NAMED cloudflared tunnel with a per-user systemd
 * unit (proposal 012, council loop #39).
 *
 * The historical failure mode: the tunnel in front of a supervised origin
 * runs as a hand-started orphan — no Restart=, no boot persistence, no
 * journal — so one cloudflared crash (or a reboot) 502s every client even
 * though the origin behind it is supervised. TunnelManager children also die
 * with the server that spawned them, so product-started tunnels are not
 * persistent either.
 *
 * `tunnel install` renders `folderforge-tunnel-<name>.service`, reusing the
 * generalized control service machinery (service.ts). No secrets enter the
 * unit: the named tunnel's credentials stay in cloudflared's own 0400 JSON,
 * referenced only via the --config path. systemctl is always invoked with
 * fixed argv (no shell).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { readFolderForgeVersion } from '../core/version.js';
import {
  defaultSystemctl,
  installUnit,
  serviceStatusInfoFor,
  uninstallUnit,
  type ServiceDeps,
  type ServiceResult,
  type ServiceStatusInfo,
  type UnitSpec,
} from './service.js';

/**
 * Named tunnels embed in the unit file name — lowercase DNS-ish plus
 * underscore: Cloudflare allows underscores in tunnel names (operator's
 * repo_vibecode / vibcode-auto-test serve production traffic) and systemd
 * accepts them in unit names. First character stays alphanumeric.
 */
const TUNNEL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const DEFAULT_CLOUDFLARED_BIN = '/usr/local/bin/cloudflared';

export function tunnelUnitName(name: string): string {
  return `folderforge-tunnel-${name}.service`;
}

function tunnelSpec(name: string): UnitSpec {
  return {
    unitName: tunnelUnitName(name),
    description: `FolderForge named tunnel ${name} (cloudflared)`,
    generatedBy: `folderforge tunnel install --name ${name}`,
    noun: 'Tunnel service',
    verifyHint: `folderforge tunnel status --name ${name}`,
    cliName: 'tunnel',
  };
}

function unsupportedTunnelPlatform(deps: ServiceDeps): ServiceResult {
  return {
    output:
      `tunnel is only supported on Linux (systemd user units); detected platform: ${deps.platform}. ` +
      'launchd/Windows support is a follow-up.\n',
    exitCode: 1,
  };
}

function invalidTunnelName(name: string): ServiceResult {
  return {
    output: `Invalid tunnel name: ${name} (expected ${TUNNEL_NAME_RE.source}).\n`,
    exitCode: 1,
  };
}

export interface TunnelInstallOptions {
  /** Named tunnel (lowercase dns-ish); also the `run` argument. */
  name: string;
  /** Absolute path to the existing cloudflared YAML config. */
  configPath: string;
  /** cloudflared binary (default /usr/local/bin/cloudflared). */
  bin?: string;
  /** Run systemctl enable --now after writing the unit. */
  enable: boolean;
  /** Accepted for parity: same-name reinstalls overwrite without it. */
  replace: boolean;
}

export function installTunnel(
  options: TunnelInstallOptions,
  deps: ServiceDeps,
): ServiceResult {
  if (deps.platform !== 'linux') return unsupportedTunnelPlatform(deps);
  if (!TUNNEL_NAME_RE.test(options.name)) return invalidTunnelName(options.name);
  if (!options.configPath.startsWith('/')) {
    return {
      output: `--config must be an absolute path, got: ${options.configPath}.\n`,
      exitCode: 1,
    };
  }
  const bin = options.bin ?? DEFAULT_CLOUDFLARED_BIN;
  return installUnit(
    {
      spec: tunnelSpec(options.name),
      serveArgs: [bin, 'tunnel', '--config', options.configPath, 'run', options.name],
      enable: options.enable,
      replace: options.replace,
      detailLine: `Tunnel at login: ${options.name} via ${options.configPath} (cloudflared, supervised).`,
      // cloudflared units have no node entry point: validate the real runtime
      // files (binary + config) instead of execPath/mainJs.
      runtimeFiles: [bin, options.configPath],
      // Tunnel death 502s every client of the origin behind it: same OOM
      // protection as the origin unit.
      oomScoreAdjust: -500,
    },
    deps,
  );
}

export function uninstallTunnel(deps: ServiceDeps, name: string): ServiceResult {
  if (deps.platform !== 'linux') return unsupportedTunnelPlatform(deps);
  if (!TUNNEL_NAME_RE.test(name)) return invalidTunnelName(name);
  const result = uninstallUnit(deps, tunnelSpec(name));
  if (result.exitCode === 0 && result.output.startsWith('Tunnel service uninstalled:')) {
    return {
      output:
        result.output +
        'The cloudflared config and credentials are kept; delete them manually only if this tunnel is retired.\n',
      exitCode: 0,
    };
  }
  return result;
}

export interface TunnelStatusInfo extends ServiceStatusInfo {
  name: string;
  configPath?: string;
}

export function tunnelStatusInfo(deps: ServiceDeps, name: string): TunnelStatusInfo {
  const info = serviceStatusInfoFor(deps, tunnelUnitName(name));
  const result: TunnelStatusInfo = { ...info, name };
  if (info.installed) {
    const text = readFileSync(info.unitPath, 'utf8');
    const m = /^ExecStart=.*--config\s+(?:"([^"]*)"|(\S+))/m.exec(text);
    const configPath = m?.[1] ?? m?.[2];
    if (configPath !== undefined) result.configPath = configPath;
  }
  return result;
}

export function tunnelStatus(deps: ServiceDeps, name: string): ServiceResult {
  if (deps.platform !== 'linux') return unsupportedTunnelPlatform(deps);
  const info = tunnelStatusInfo(deps, name);
  if (!info.installed) {
    return {
      output:
        `Tunnel service is not installed (${info.unitPath}).\n` +
        `Install: folderforge tunnel install --name ${name} --config <cloudflared.yml>\n`,
      exitCode: 0,
    };
  }
  return {
    output:
      `Tunnel service installed: ${info.unitPath}\n` +
      `Tunnel: ${name} (config ${info.configPath ?? 'unknown'})\n` +
      `systemd: enabled=${info.enabled ?? 'unknown'} active=${info.active ?? 'unknown'}\n`,
    exitCode: 0,
  };
}

const TUNNEL_HELP = [
  'folderforge tunnel — supervise a named cloudflared tunnel (systemd user unit)',
  '',
  'Usage: folderforge tunnel <command> [options]',
  '',
  'Commands:',
  '  install    Write folderforge-tunnel-<name>.service (no secrets — cloudflared reads its own credentials)',
  '  uninstall  Disable and remove the unit (the config and credentials are kept)',
  '  status     Show installed/enabled/active for one tunnel (--json supported)',
  '',
  'Install options:',
  '  --name <name>          Named tunnel to supervise (required; lowercase, digits, dashes, underscores)',
  '  --config <path>        Absolute path to the cloudflared YAML config (required)',
  '  --bin <path>           cloudflared binary (default /usr/local/bin/cloudflared)',
  '  --enable               systemctl --user enable --now after writing the unit',
  '  --replace              Accepted for parity; same-name reinstalls overwrite anyway',
  '',
].join('\n');

/** Production deps for the tunnel CLI (this host's systemd user manager). */
export function defaultTunnelDeps(): ServiceDeps {
  return {
    execPath: process.execPath,
    homeDir: homedir(),
    fileExists: (path) => existsSync(path),
    execSystemctl: (args) => defaultSystemctl(args),
    getEnv: (name) => process.env[name],
    platform: process.platform,
    version: readFolderForgeVersion(),
  };
}

export function executeTunnelCli(argv: string[], deps: ServiceDeps): ServiceResult {
  const sub = argv[0];
  if (sub === 'install' || sub === 'uninstall' || sub === 'status') {
    let name: string | undefined;
    let configPath: string | undefined;
    let bin: string | undefined;
    let enable = false;
    let replace = false;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      const next = () => argv[++i];
      switch (a) {
        case '--name': {
          const v = next();
          if (v !== undefined) name = v;
          break;
        }
        case '--config': {
          const v = next();
          if (v !== undefined) configPath = v;
          break;
        }
        case '--bin': {
          const v = next();
          if (v !== undefined) bin = v;
          break;
        }
        case '--enable':
          enable = true;
          break;
        case '--replace':
          replace = true;
          break;
        case '--json':
          break; // consumed by the status branch below
        default:
          return {
            output: `Unknown argument: ${String(a)}. Run \`folderforge tunnel --help\` for supported flags.\n`,
            exitCode: 1,
          };
      }
    }
    if (name === undefined) {
      return { output: `tunnel ${sub} requires --name <name>.\n`, exitCode: 1 };
    }
    if (sub === 'uninstall') return uninstallTunnel(deps, name);
    if (sub === 'status') {
      if (argv.includes('--json')) {
        const info = tunnelStatusInfo(deps, name);
        return {
          output:
            JSON.stringify({
              installed: info.installed,
              unitPath: info.unitPath,
              name: info.name,
              configPath: info.configPath ?? null,
              enabled: info.enabled ?? null,
              active: info.active ?? null,
            }) + '\n',
          exitCode: 0,
        };
      }
      return tunnelStatus(deps, name);
    }
    if (configPath === undefined) {
      return { output: 'tunnel install requires --config <path>.\n', exitCode: 1 };
    }
    return installTunnel(
      { name, configPath, ...(bin !== undefined ? { bin } : {}), enable, replace },
      deps,
    );
  }
  return {
    output: TUNNEL_HELP + '\n',
    exitCode: sub === undefined || sub === '--help' || sub === '-h' ? 0 : 1,
  };
}
