import { isAbsolute, resolve } from 'node:path';
import type { AdapterDef, ChildSandboxConfig, ChildSandboxMount } from '../core/types.js';
import type { ResolvedAdapterLaunch } from '../adapters/child-mcp/resolve.js';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DIGEST_PIN = /@sha256:[a-f0-9]{64}$/i;

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return normalized;
}

function boundedNumber(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized < min || normalized > max) {
    throw new Error(`${label} must be from ${min} to ${max}.`);
  }
  return normalized;
}

function validateContainerPath(path: string, label: string): string {
  if (!path.startsWith('/') || path.includes('\0') || path.includes(',')) {
    throw new Error(`${label} must be an absolute POSIX path without NUL or commas.`);
  }
  const segments = path.split('/');
  if (segments.includes('..')) throw new Error(`${label} must not contain '..'.`);
  return path;
}

function validateMount(mount: ChildSandboxMount): ChildSandboxMount {
  if (!isAbsolute(mount.source) || mount.source.includes('\0') || mount.source.includes(',')) {
    throw new Error('sandbox mount source must be an absolute host path without NUL or commas.');
  }
  if (!['ro', 'rw'].includes(mount.mode)) throw new Error('sandbox mount mode must be ro or rw.');
  return {
    source: resolve(mount.source),
    target: validateContainerPath(mount.target, 'sandbox mount target'),
    mode: mount.mode,
  };
}

export interface SandboxedAdapterLaunch extends ResolvedAdapterLaunch {
  sandboxMode?: 'docker' | 'podman';
  sandboxImage?: string;
}

/**
 * Wrap a resolved child command in a real Docker/Podman isolation boundary.
 * The runtime never pulls images and receives only explicitly forwarded env keys.
 */
export function applySandboxLaunch(
  def: AdapterDef,
  launch: ResolvedAdapterLaunch
): SandboxedAdapterLaunch {
  const sandbox = def.sandbox;
  if (!sandbox || sandbox.mode === 'process') return launch;
  if (!['docker', 'podman'].includes(sandbox.mode)) {
    throw new Error(`Unsupported child sandbox mode: ${String(sandbox.mode)}`);
  }

  const image = String(sandbox.image ?? '').trim();
  if (!image || /\s|\0/.test(image)) throw new Error('sandbox.image is required and must not contain whitespace.');
  if (sandbox.requireImageDigest !== false && !DIGEST_PIN.test(image)) {
    throw new Error('sandbox.image must be pinned with @sha256:<64 hex> unless requireImageDigest=false is explicit.');
  }
  const containerCommand = String(sandbox.command ?? '').trim();
  if (!containerCommand || /\0/.test(containerCommand)) {
    throw new Error('sandbox.command is required for docker/podman runtimes.');
  }

  const mounts = (sandbox.mounts ?? []).map(validateMount);
  const targets = new Set<string>();
  for (const mount of mounts) {
    if (targets.has(mount.target)) throw new Error(`Duplicate sandbox mount target: ${mount.target}`);
    targets.add(mount.target);
  }

  const memoryMb = boundedInteger(sandbox.memoryMb, 512, 64, 65_536, 'sandbox.memoryMb');
  const cpus = boundedNumber(sandbox.cpus, 1, 0.1, 64, 'sandbox.cpus');
  const pidsLimit = boundedInteger(sandbox.pidsLimit, 128, 16, 4096, 'sandbox.pidsLimit');
  const tmpfsMb = boundedInteger(sandbox.tmpfsMb, 64, 8, 4096, 'sandbox.tmpfsMb');
  const network = sandbox.network ?? 'none';
  if (!['none', 'bridge'].includes(network)) throw new Error('sandbox.network must be none or bridge.');

  const args = [
    'run',
    '--rm',
    '-i',
    '--pull=never',
    `--network=${network}`,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--pids-limit=${pidsLimit}`,
    `--memory=${memoryMb}m`,
    `--cpus=${cpus}`,
    '--tmpfs',
    `/tmp:rw,noexec,nosuid,size=${tmpfsMb}m`,
  ];

  if (sandbox.readOnlyRoot !== false) args.push('--read-only');
  if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    args.push('--user', `${process.getuid()}:${process.getgid()}`);
  }
  for (const mount of mounts) {
    args.push(
      '--mount',
      `type=bind,src=${mount.source},dst=${mount.target}${mount.mode === 'ro' ? ',readonly' : ''}`
    );
  }
  if (sandbox.workdir) args.push('--workdir', validateContainerPath(sandbox.workdir, 'sandbox.workdir'));

  for (const key of Object.keys(def.env ?? {}).sort()) {
    if (!ENV_NAME.test(key)) throw new Error(`Invalid sandbox environment key: ${key}`);
    args.push('--env', key);
  }

  args.push(image, containerCommand, ...(sandbox.args ?? []));
  return {
    ...launch,
    command: sandbox.mode,
    args,
    sandboxMode: sandbox.mode,
    sandboxImage: image,
  };
}

export function sandboxSummary(sandbox: ChildSandboxConfig | undefined): Record<string, unknown> {
  if (!sandbox || sandbox.mode === 'process') return { mode: 'process', enforced: false };
  return {
    mode: sandbox.mode,
    enforced: true,
    image: sandbox.image,
    network: sandbox.network ?? 'none',
    readOnlyRoot: sandbox.readOnlyRoot !== false,
    memoryMb: sandbox.memoryMb ?? 512,
    cpus: sandbox.cpus ?? 1,
    pidsLimit: sandbox.pidsLimit ?? 128,
    mounts: (sandbox.mounts ?? []).map((mount) => ({ target: mount.target, mode: mount.mode })),
  };
}
