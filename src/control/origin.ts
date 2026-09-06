/**
 * `origin` — a supervised, boot-persistent plain HTTP MCP origin via a
 * per-user systemd unit (proposal 009, council loop #36).
 *
 * The historical failure mode: an operator runs `folderforge --http …` from a
 * login shell — no supervisor, no boot persistence, and the bearer token sits
 * in argv where any local user can read it via `ps`. One crash (or one shell
 * exit) is a hard 502 outage for every client of the tunnel in front of it.
 *
 * `origin install` renders a `folderforge-origin.service` user unit with
 * Restart=on-failure, reusing the generalized `control service` machinery
 * (service.ts). Secrets never enter the unit or argv: token/API-key values
 * are written to `<project>/.folderforge/origin.env` (mode 0600) and wired as
 * a REQUIRED EnvironmentFile=; the runtime config overlay already honors and
 * scrubs FOLDERFORGE_HTTP_TOKEN / FOLDERFORGE_HTTP_API_KEYS at boot.
 *
 * The installer's PATH is mirrored into the unit as Environment="PATH=…" so
 * children spawned by the supervised origin resolve the same toolchain as a
 * login shell (systemd's default PATH would otherwise hide nvm installs).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

export const ORIGIN_UNIT_NAME = 'folderforge-origin.service';

const ORIGIN_UNIT: UnitSpec = {
  unitName: ORIGIN_UNIT_NAME,
  description: 'FolderForge MCP origin (HTTP MCP server)',
  generatedBy: 'folderforge origin install',
  noun: 'Origin service',
  verifyHint: 'folderforge origin status',
  cliName: 'origin',
};

/** The 0600 env file a supervised origin reads its secrets from. */
export function originEnvPath(project: string): string {
  return join(project, '.folderforge', 'origin.env');
}

export interface OriginInstallOptions {
  project: string;
  port: number;
  host?: string;
  toolsPreset?: string;
  policyMode?: string;
  allowCritical?: boolean;
  authMode: 'none' | 'token' | 'api-key';
  /** Bearer token value (written to origin.env 0600, never to the unit/argv). */
  token?: string;
  /** Read the token from this environment variable at install time. */
  tokenEnv?: string;
  /** Accepted API keys (written to origin.env as FOLDERFORGE_HTTP_API_KEYS). */
  apiKeys?: string[];
  enable: boolean;
  replace: boolean;
  mainJs: string;
}

export function installOrigin(
  options: OriginInstallOptions,
  deps: ServiceDeps,
): ServiceResult {
  if (deps.platform !== 'linux') {
    // Same message shape as the plane's unsupported-platform error.
    return {
      output:
        `origin is only supported on Linux (systemd user units); detected platform: ${deps.platform}. ` +
        'launchd/Windows support is a follow-up.\n',
      exitCode: 1,
    };
  }
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
    return {
      output: `Invalid port: ${options.port} (expected an integer in 1024-65535).\n`,
      exitCode: 1,
    };
  }
  if (!deps.fileExists(options.project)) {
    return {
      output: `Project directory does not exist: ${options.project}.\n`,
      exitCode: 1,
    };
  }
  if (options.allowCritical === true && options.policyMode !== 'danger') {
    return {
      output: '--dangerously-allow-critical requires --policy danger.\n',
      exitCode: 1,
    };
  }
  let token = options.token;
  if (token === undefined && options.tokenEnv !== undefined) {
    token = deps.getEnv(options.tokenEnv);
    if (token === undefined) {
      return {
        output: `Environment variable ${options.tokenEnv} is not set; cannot write the origin secrets file.\n`,
        exitCode: 1,
      };
    }
  }
  if (options.authMode === 'token' && token === undefined) {
    return {
      output: '--auth token requires --token <value> or --token-env <NAME>.\n',
      exitCode: 1,
    };
  }
  if (
    options.authMode === 'api-key' &&
    (options.apiKeys === undefined || options.apiKeys.length === 0)
  ) {
    return {
      output: '--auth api-key requires at least one --api-key <value>.\n',
      exitCode: 1,
    };
  }
  const secretValues = [token, ...(options.apiKeys ?? [])].filter(
    (value): value is string => value !== undefined,
  );
  for (const value of secretValues) {
    if (/[\r\n]/.test(value)) {
      return { output: 'Secrets must be single-line values.\n', exitCode: 1 };
    }
  }
  const host = options.host ?? '127.0.0.1';
  // The secrets file is written before the unit so systemd never references a
  // missing EnvironmentFile= (the line is REQUIRED — a missing file fails the
  // unit loudly instead of booting an unauthenticated origin).
  let environmentFile: string | undefined;
  if (secretValues.length > 0) {
    const envPath = originEnvPath(options.project);
    mkdirSync(join(options.project, '.folderforge'), { recursive: true });
    const lines: string[] = [];
    if (token !== undefined) lines.push(`FOLDERFORGE_HTTP_TOKEN=${token}`);
    if (options.apiKeys !== undefined && options.apiKeys.length > 0) {
      lines.push(`FOLDERFORGE_HTTP_API_KEYS=${options.apiKeys.join(',')}`);
    }
    writeFileSync(envPath, `${lines.join('\n')}\n`, { mode: 0o600 });
    environmentFile = envPath;
  }
  const serveArgs = [
    deps.execPath,
    options.mainJs,
    '--project',
    options.project,
    '--http',
    '--host',
    host,
    '--port',
    String(options.port),
    '--no-dashboard',
    ...(options.toolsPreset !== undefined ? ['--tools-preset', options.toolsPreset] : []),
    ...(options.policyMode !== undefined ? ['--policy', options.policyMode] : []),
    ...(options.allowCritical === true ? ['--dangerously-allow-critical'] : []),
    '--auth',
    options.authMode,
  ];
  // Mirror the operator's login-shell PATH into the unit: systemd starts the
  // origin with a minimal default PATH, so spawned children would otherwise
  // resolve the system toolchain (node 20) instead of the operator's (nvm).
  const operatorPath = deps.getEnv('PATH');
  return installUnit(
    {
      spec: ORIGIN_UNIT,
      serveArgs,
      mainJs: options.mainJs,
      enable: options.enable,
      replace: options.replace,
      detailLine: `Origin at login: project ${options.project}, ${host}:${options.port} (HTTP MCP, auth ${options.authMode}).`,
      ...(environmentFile !== undefined ? { environmentFile } : {}),
      ...(operatorPath !== undefined && operatorPath.trim().length > 0
        ? { environment: { PATH: operatorPath } }
        : {}),
    },
    deps,
  );
}

export function uninstallOrigin(deps: ServiceDeps): ServiceResult {
  // Read the unit first so the note can point at the secrets file of the
  // origin being removed (the file is 0600 but still holds the token).
  const info = serviceStatusInfoFor(deps, ORIGIN_UNIT_NAME);
  const result = uninstallUnit(deps, ORIGIN_UNIT);
  if (
    result.exitCode === 0 &&
    info.projectRoot !== undefined &&
    existsSync(originEnvPath(info.projectRoot))
  ) {
    return {
      output:
        result.output +
        `Secrets file kept at ${originEnvPath(info.projectRoot)}; delete it manually if this origin is retired.\n`,
      exitCode: result.exitCode,
    };
  }
  return result;
}

export function originStatusInfo(deps: ServiceDeps): ServiceStatusInfo {
  return serviceStatusInfoFor(deps, ORIGIN_UNIT_NAME);
}

export function originStatus(deps: ServiceDeps): ServiceResult {
  if (deps.platform !== 'linux') {
    return {
      output:
        `origin is only supported on Linux (systemd user units); detected platform: ${deps.platform}. ` +
        'launchd/Windows support is a follow-up.\n',
      exitCode: 1,
    };
  }
  const info = originStatusInfo(deps);
  if (!info.installed) {
    return {
      output:
        `Origin service is not installed (${info.unitPath}).\n` +
        'Install: folderforge origin install --project <dir> --port <n> --auth token --token-env <NAME>\n',
      exitCode: 0,
    };
  }
  return {
    output:
      `Origin service installed: ${info.unitPath}\n` +
      `Target: project ${info.projectRoot ?? 'unknown'}, port ${info.port ?? 'unknown'}\n` +
      `systemd: enabled=${info.enabled ?? 'unknown'} active=${info.active ?? 'unknown'}\n`,
    exitCode: 0,
  };
}

const ORIGIN_HELP = [
  'folderforge origin — supervised, boot-persistent MCP origin (systemd user unit)',
  '',
  'Usage: folderforge origin <command> [options]',
  '',
  'Commands:',
  '  install    Write folderforge-origin.service (secrets go to a 0600 env file, never argv)',
  '  uninstall  Disable and remove the unit (the secrets file is kept; the message names it)',
  '  status     Show installed/enabled/active and the target project/port (--json supported)',
  '',
  'Install options:',
  '  --project <dir>        Project root the origin serves (required)',
  '  --port <n>             HTTP MCP port (required, 1024-65535)',
  '  --host <addr>          Bind address (default 127.0.0.1)',
  '  --tools-preset <id>    Tool preset (default: server default)',
  '  --policy <mode>        Policy mode (readonly|safe|dev|danger)',
  '  --dangerously-allow-critical  Allow CRITICAL without approval (requires --policy danger)',
  '  --auth <mode>          none|token|api-key (default token)',
  '  --token <value>        Bearer token — stored 0600, never in the unit or argv',
  '  --token-env <NAME>     Read the token from this environment variable instead',
  '  --api-key <csv>        Accepted API keys (repeatable / comma-separated)',
  '  --enable               systemctl --user enable --now after writing the unit',
  '  --replace              Overwrite an origin unit owned by another project',
  '',
].join('\n');

/** Production deps for the origin CLI (this host's systemd user manager). */
export function defaultOriginDeps(): ServiceDeps & { mainJs: string } {
  return {
    execPath: process.execPath,
    // Same derivation as the control CLI: this file ships at dist/control/,
    // so the server entry point sits one directory up.
    mainJs: fileURLToPath(new URL('../main.js', import.meta.url)),
    homeDir: homedir(),
    fileExists: (path) => existsSync(path),
    execSystemctl: (args) => defaultSystemctl(args),
    getEnv: (name) => process.env[name],
    platform: process.platform,
    version: readFolderForgeVersion(),
  };
}

export function executeOriginCli(
  argv: string[],
  deps: ServiceDeps & { mainJs: string },
): ServiceResult {
  const sub = argv[0];
  if (sub === 'uninstall') return uninstallOrigin(deps);
  if (sub === 'status') {
    if (argv.includes('--json')) {
      const info = originStatusInfo(deps);
      return {
        output:
          JSON.stringify({
            installed: info.installed,
            unitPath: info.unitPath,
            projectRoot: info.projectRoot ?? null,
            port: info.port ?? null,
            enabled: info.enabled ?? null,
            active: info.active ?? null,
          }) + '\n',
        exitCode: 0,
      };
    }
    return originStatus(deps);
  }
  if (sub !== 'install') {
    return {
      output: ORIGIN_HELP + '\n',
      exitCode: sub === undefined || sub === '--help' || sub === '-h' ? 0 : 1,
    };
  }
  let project: string | undefined;
  let port: number | undefined;
  let host: string | undefined;
  let toolsPreset: string | undefined;
  let policyMode: string | undefined;
  let allowCritical = false;
  let authMode: 'none' | 'token' | 'api-key' | undefined;
  let token: string | undefined;
  let tokenEnv: string | undefined;
  const apiKeys: string[] = [];
  let enable = false;
  let replace = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--project': {
        const v = next();
        if (v !== undefined) project = v;
        break;
      }
      case '--port': {
        const v = next();
        if (v !== undefined) port = Number(v);
        break;
      }
      case '--host': {
        const v = next();
        if (v !== undefined) host = v;
        break;
      }
      case '--tools-preset': {
        const v = next();
        if (v !== undefined) toolsPreset = v;
        break;
      }
      case '--policy':
      case '--policy-mode': {
        const v = next();
        if (v !== undefined) policyMode = v;
        break;
      }
      case '--dangerously-allow-critical':
        allowCritical = true;
        break;
      case '--auth': {
        const v = next();
        if (v === 'none' || v === 'token' || v === 'api-key') {
          authMode = v;
        } else {
          return {
            output: `Invalid --auth mode: ${String(v)} (expected none|token|api-key).\n`,
            exitCode: 1,
          };
        }
        break;
      }
      case '--token': {
        const v = next();
        if (v !== undefined) token = v;
        break;
      }
      case '--token-env': {
        const v = next();
        if (v !== undefined) tokenEnv = v;
        break;
      }
      case '--api-key': {
        const v = next();
        if (v !== undefined) {
          apiKeys.push(...v.split(',').map((s) => s.trim()).filter(Boolean));
        }
        break;
      }
      case '--enable':
        enable = true;
        break;
      case '--replace':
        replace = true;
        break;
      default:
        return {
          output: `Unknown argument: ${String(a)}. Run \`folderforge origin --help\` for supported flags.\n`,
          exitCode: 1,
        };
    }
  }
  if (project === undefined) {
    return { output: 'origin install requires --project <dir>.\n', exitCode: 1 };
  }
  if (port === undefined) {
    return { output: 'origin install requires --port <n>.\n', exitCode: 1 };
  }
  return installOrigin(
    {
      project,
      port,
      ...(host !== undefined ? { host } : {}),
      ...(toolsPreset !== undefined ? { toolsPreset } : {}),
      ...(policyMode !== undefined ? { policyMode } : {}),
      allowCritical,
      authMode: authMode ?? 'token',
      ...(token !== undefined ? { token } : {}),
      ...(tokenEnv !== undefined ? { tokenEnv } : {}),
      ...(apiKeys.length > 0 ? { apiKeys } : {}),
      enable,
      replace,
      mainJs: deps.mainJs,
    },
    deps,
  );
}
