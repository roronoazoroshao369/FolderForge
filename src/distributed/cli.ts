import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadConfig } from '../runtime/config.js';
import { Container } from '../runtime/container.js';
import { readFolderForgeVersion } from '../core/version.js';
import { buildRegistry, registerAdapterTools } from '../tools/index.js';
import { sha256 } from './coordinator.js';
import { startDistributedHttpServer } from './http-server.js';
import { runRemoteWorkerOnce } from './worker-runtime.js';

interface Parsed {
  command: 'serve' | 'init' | 'run' | 'help';
  project: string;
  config?: string;
  host: string;
  port: number;
  tlsCert?: string;
  tlsKey?: string;
  output?: string;
  coordinator?: string;
  tokenFile?: string;
  privateKey?: string;
  allowTools?: string[];
  once: boolean;
  pollMs: number;
  leaseTtlMs: number;
  heartbeatMs?: number;
  json: boolean;
}

function parse(argv: string[]): Parsed {
  const namespace = argv[0];
  const sub = argv[1];
  let command: Parsed['command'] = 'help';
  let start = 1;
  if (namespace === 'distributed' && sub === 'serve') { command = 'serve'; start = 2; }
  else if (namespace === 'worker' && sub === 'init') { command = 'init'; start = 2; }
  else if (namespace === 'worker' && sub === 'run') { command = 'run'; start = 2; }
  const parsed: Parsed = {
    command,
    project: process.cwd(),
    host: '127.0.0.1',
    port: 7441,
    once: false,
    pollMs: 5_000,
    leaseTtlMs: 60_000,
    json: false,
  };
  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value after ${arg}`);
      return value;
    };
    switch (arg) {
      case '--project': case '-p': parsed.project = next(); break;
      case '--config': case '-c': parsed.config = next(); break;
      case '--host': parsed.host = next(); break;
      case '--port': parsed.port = Number(next()); break;
      case '--tls-cert': parsed.tlsCert = next(); break;
      case '--tls-key': parsed.tlsKey = next(); break;
      case '--output': parsed.output = next(); break;
      case '--coordinator': parsed.coordinator = next(); break;
      case '--token-file': parsed.tokenFile = next(); break;
      case '--private-key': parsed.privateKey = next(); break;
      case '--allow-tools': parsed.allowTools = next().split(',').map((item) => item.trim()).filter(Boolean); break;
      case '--once': parsed.once = true; break;
      case '--poll-ms': parsed.pollMs = Number(next()); break;
      case '--lease-ttl-ms': parsed.leaseTtlMs = Number(next()); break;
      case '--heartbeat-ms': parsed.heartbeatMs = Number(next()); break;
      case '--json': parsed.json = true; break;
      case '--help': case '-h': parsed.command = 'help'; break;
      default: throw new Error(`Unknown distributed/worker option: ${arg}`);
    }
  }
  return parsed;
}

function help(): string {
  return [
    'FolderForge distributed worker control plane',
    '',
    'Commands:',
    '  folderforge distributed serve [--project DIR] [--host 127.0.0.1] [--port 7441]',
    '      [--tls-cert CERT --tls-key KEY]',
    '  folderforge worker init [--output DIR]',
    '  folderforge worker run --coordinator URL --token-file FILE --private-key FILE',
    '      --allow-tools tool1,tool2 [--project DIR] [--once] [--poll-ms 5000]',
    '',
    'Security:',
    '  - non-loopback coordinator binds require TLS;',
    '  - worker bearer tokens are short-lived and loaded from a file;',
    '  - worker private keys never cross the network;',
    '  - workers execute only the explicit --allow-tools set;',
    '  - distributed_* and marketplace_* recursion is always denied.',
    '',
  ].join('\n');
}

function output(value: unknown, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    if (signal.aborted) return resolveSleep();
    const timer = setTimeout(resolveSleep, ms);
    timer.unref();
    signal.addEventListener('abort', () => { clearTimeout(timer); resolveSleep(); }, { once: true });
  });
}

export async function executeDistributedCli(argv: string[]): Promise<void> {
  const args = parse(argv);
  if (args.command === 'help') {
    process.stdout.write(help());
    return;
  }
  const project = resolve(args.project);

  if (args.command === 'init') {
    const directory = resolve(args.output ?? join(project, '.folderforge', 'worker-identity'));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privatePath = join(directory, 'worker-private.pem');
    const publicPath = join(directory, 'worker-public.pem');
    const metadataPath = join(directory, 'worker.json');
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const fingerprint = sha256(createPublicKey(publicPem).export({ type: 'spki', format: 'der' }));
    writeFileSync(privatePath, privatePem, { mode: 0o600, flag: 'wx' });
    writeFileSync(publicPath, publicPem, { mode: 0o600, flag: 'wx' });
    writeFileSync(metadataPath, JSON.stringify({ schemaVersion: 1, publicKeyFingerprint: fingerprint, publicKeyPath: publicPath }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    const ignorePath = join(directory, '.gitignore');
    writeFileSync(ignorePath, '*\n!.gitignore\n', { mode: 0o600, flag: 'wx' });
    chmodSync(directory, 0o700);
    output({ ok: true, directory, privateKeyPath: privatePath, publicKeyPath: publicPath, publicKeyFingerprint: fingerprint }, args.json);
    return;
  }

  const config = loadConfig({ projectRoot: project, ...(args.config ? { configPath: args.config } : {}) });
  const container = new Container(config);

  if (args.command === 'serve') {
    const server = await startDistributedHttpServer(container.distributed, container.artifacts, container.audit, {
      host: args.host,
      port: args.port,
      ...(args.tlsCert ? { tlsCertPath: resolve(args.tlsCert) } : {}),
      ...(args.tlsKey ? { tlsKeyPath: resolve(args.tlsKey) } : {}),
    });
    const address = server.address();
    const actualPort = address && typeof address === 'object' ? address.port : args.port;
    output({
      ok: true,
      service: 'folderforge-distributed',
      host: args.host,
      port: actualPort,
      protocol: args.tlsCert ? 'https' : 'http',
      coordinatorKey: container.distributed.coordinatorPublicKey(),
    }, args.json);
    const controller = new AbortController();
    const shutdown = (): void => controller.abort();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    await new Promise<void>((resolveClosed) => {
      controller.signal.addEventListener('abort', () => server.close(() => resolveClosed()), { once: true });
    });
    await Promise.allSettled([container.adapters.stopAllAndWait(1_500), container.browserEmulation.close()]);
    return;
  }

  if (!args.coordinator || !args.tokenFile || !args.privateKey || !args.allowTools?.length) {
    throw new Error('worker run requires --coordinator, --token-file, --private-key, and non-empty --allow-tools.');
  }
  if (!Number.isSafeInteger(args.pollMs) || args.pollMs < 1_000 || args.pollMs > 60_000) {
    throw new Error('--poll-ms must be an integer from 1000 to 60000.');
  }
  const token = readFileSync(resolve(args.tokenFile), 'utf8').trim();
  const privateKeyPem = readFileSync(resolve(args.privateKey), 'utf8');
  const registry = buildRegistry(container);
  try { await registerAdapterTools(container, registry, true); } catch { /* unavailable optional adapters remain unavailable */ }
  const controller = new AbortController();
  const shutdown = (): void => controller.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  let iterations = 0;
  let jobs = 0;
  try {
    do {
      const result = await runRemoteWorkerOnce({
        coordinatorUrl: args.coordinator,
        token,
        privateKeyPem,
        allowedTools: args.allowTools,
        projectRoot: project,
        workerVersion: readFolderForgeVersion(),
        container,
        registry,
        leaseTtlMs: args.leaseTtlMs,
        ...(args.heartbeatMs !== undefined ? { heartbeatMs: args.heartbeatMs } : {}),
        signal: controller.signal,
      });
      iterations += 1;
      if (result.leased) {
        jobs += 1;
        output({ ok: true, iteration: iterations, ...result }, args.json);
      } else if (args.once) {
        output({ ok: true, iteration: iterations, leased: false }, args.json);
      }
      if (args.once || controller.signal.aborted) break;
      if (!result.leased) await sleep(args.pollMs, controller.signal);
    } while (!controller.signal.aborted);
  } finally {
    await Promise.allSettled([container.adapters.stopAllAndWait(1_500), container.browserEmulation.close()]);
    if (!args.once) output({ ok: true, stopped: true, iterations, jobs }, args.json);
  }
}
