import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import * as tar from 'tar';
import { StdioChildClient } from '../adapters/child-mcp/client.js';
import { resolveAdapterLaunch } from '../adapters/child-mcp/resolve.js';
import { applySandboxLaunch, sandboxSummary } from '../sandbox/launcher.js';
import { MarketplaceManager, type MarketplaceProvenance } from '../marketplace/marketplace-manager.js';
import { SecretPolicy } from '../policy/secret-policy.js';
import { readFolderForgeVersion } from '../core/version.js';
import {
  PluginManager,
  calculatePluginIntegrity,
  validatePluginManifest,
  type PluginManifest,
} from './plugin-manager.js';

const MAX_FILES = 2_000;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_TIMEOUT_MS = 60_000;
const LIFECYCLE_SCRIPTS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'prepublishOnly',
  'prepare',
]);

interface ParsedArgs {
  command: string;
  positionals: string[];
  options: Map<string, string[]>;
  flags: Set<string>;
}

interface PluginValidationResult {
  source: string;
  manifest: PluginManifest;
  integrity: ReturnType<typeof calculatePluginIntegrity>;
  warnings: string[];
}

export interface PluginSdkCliResult {
  exitCode: number;
  output: string;
}

function parse(argv: string[]): ParsedArgs {
  const command = argv[0] ?? 'help';
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const equal = value.indexOf('=');
    if (equal > 2) {
      const key = value.slice(2, equal);
      const item = value.slice(equal + 1);
      options.set(key, [...(options.get(key) ?? []), item]);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options.set(key, [...(options.get(key) ?? []), next]);
      index += 1;
    } else {
      flags.add(key);
    }
  }
  return { command, positionals, options, flags };
}

function option(args: ParsedArgs, name: string): string | undefined {
  return args.options.get(name)?.at(-1);
}

function requiredOption(args: ParsedArgs, name: string): string {
  const value = option(args, name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function positional(args: ParsedArgs, index: number, label: string): string {
  const value = args.positionals[index]?.trim();
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

function jsonOutput(args: ParsedArgs, value: unknown): string {
  if (args.flags.has('json')) return `${JSON.stringify(value)}\n`;
  return `${JSON.stringify(value, null, 2)}\n`;
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  const candidate = /^[a-z]/.test(normalized) ? normalized : `p-${normalized}`;
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(candidate)) {
    throw new Error('Unable to derive a valid plugin id; pass --id explicitly.');
  }
  return candidate;
}

function title(value: string): string {
  return value
    .split('-')
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

function safeFiles(root: string, excludedAbsolute?: string): string[] {
  let files = 0;
  let bytes = 0;
  const output: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const path = join(directory, entry.name);
      if (excludedAbsolute && resolve(path) === excludedAbsolute) continue;
      const stat = lstatSync(path);
      const rel = relative(root, path).split(sep).join('/');
      if (stat.isSymbolicLink()) throw new Error(`Plugin packages may not contain symlinks: ${rel}`);
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Plugin packages may contain only regular files: ${rel}`);
      files += 1;
      bytes += stat.size;
      if (files > MAX_FILES || bytes > MAX_BYTES) {
        throw new Error(`Plugin package exceeds ${MAX_FILES} files or ${MAX_BYTES} bytes.`);
      }
      output.push(rel);
    }
  };
  walk(root);
  return output.sort();
}

function validateSource(sourceInput: string): PluginValidationResult {
  const source = resolve(sourceInput);
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error(`Plugin source directory does not exist: ${source}`);
  }
  const manifestPath = join(source, 'folderforge.plugin.json');
  if (!existsSync(manifestPath)) throw new Error('Missing folderforge.plugin.json.');
  const manifest = validatePluginManifest(
    JSON.parse(readFileSync(manifestPath, 'utf8')),
    readFolderForgeVersion(),
  );
  const integrity = calculatePluginIntegrity(source);
  if (integrity.files > MAX_FILES || integrity.bytes > MAX_BYTES) {
    throw new Error(`Plugin package exceeds ${MAX_FILES} files or ${MAX_BYTES} bytes.`);
  }
  const warnings: string[] = [];
  if (manifest.runtime.command.startsWith('./')) {
    const executable = resolve(source, manifest.runtime.command);
    const rel = relative(source, executable);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('runtime.command escapes the plugin package.');
    if (!existsSync(executable) || !statSync(executable).isFile()) {
      throw new Error(`Plugin runtime command not found: ${manifest.runtime.command}`);
    }
  }
  const packageJsonPath = join(source, 'package.json');
  if (existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    for (const script of Object.keys(packageJson.scripts ?? {})) {
      if (LIFECYCLE_SCRIPTS.has(script)) {
        warnings.push(`package.json declares ${script}; FolderForge never executes package lifecycle scripts.`);
      }
    }
  }
  safeFiles(source);
  return { source, manifest, integrity, warnings };
}

function generatedServer(): string {
  return `#!/usr/bin/env node
let buffer = '';
function send(value) {
  process.stdout.write(JSON.stringify(value) + '\\n');
}
function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || message.id === undefined) return;
  const id = message.id;
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: message.params?.protocolVersion ?? '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'folderforge-plugin-template', version: '1.0.0' }
    }});
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [
      { name: 'health', description: 'Return plugin health.', inputSchema: { type: 'object', properties: {} } },
      { name: 'echo', description: 'Echo bounded text.', inputSchema: {
        type: 'object', properties: { text: { type: 'string', maxLength: 4000 } }, required: ['text']
      }}
    ] }});
    return;
  }
  if (message.method === 'tools/call') {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    if (name === 'health') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] }});
      return;
    }
    if (name === 'echo' && typeof args.text === 'string' && args.text.length <= 4000) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: args.text }] }});
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool or invalid arguments.' } });
    return;
  }
  if (message.method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found.' } });
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch { /* ignore malformed input */ }
  }
});
process.stdin.resume();
`;
}

function initializePlugin(args: ParsedArgs): Record<string, unknown> {
  const target = resolve(positional(args, 0, 'Plugin directory'));
  const id = slug(option(args, 'id') ?? basename(target));
  const name = option(args, 'name')?.trim() || title(id);
  const sandboxMode = option(args, 'sandbox') ?? 'process';
  if (!['process', 'docker', 'podman'].includes(sandboxMode)) {
    throw new Error('--sandbox must be process, docker, or podman.');
  }
  const image = option(args, 'image');
  if (sandboxMode !== 'process' && !/@sha256:[a-f0-9]{64}$/i.test(image ?? '')) {
    throw new Error('Container templates require --image image@sha256:<64 hex>.');
  }
  if (existsSync(target)) {
    const entries = readdirSync(target);
    if (entries.length > 0 && !args.flags.has('force')) {
      throw new Error(`Target directory is not empty: ${target}. Use --force to replace generated files.`);
    }
  }
  mkdirSync(target, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    id,
    name,
    version: '1.0.0',
    description: `${name} FolderForge MCP plugin`,
    compatibility: {
      folderforge: `>=${readFolderForgeVersion()}`,
      mcpProtocol: '2025-11-25',
    },
    runtime: {
      command: 'node',
      args: ['{pluginDir}/server.mjs'],
      facade: true,
      ...(sandboxMode === 'process'
        ? {}
        : {
            sandbox: {
              mode: sandboxMode,
              image,
              workdir: '/plugin',
              readOnlyRoot: true,
              requireImageDigest: true,
              memoryMb: 256,
              cpus: 0.5,
              pidsLimit: 64,
              tmpfsMb: 32,
            },
          }),
    },
    permissions: { network: false, filesystem: 'none', env: [] },
    risk: {
      default: { risk: 'MEDIUM', mutates: true },
      tools: {
        health: { risk: 'LOW', mutates: false },
        echo: { risk: 'LOW', mutates: false },
      },
    },
  };
  writeFileSync(join(target, 'folderforge.plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(target, 'server.mjs'), generatedServer(), { mode: 0o755 });
  if (process.platform !== 'win32') chmodSync(join(target, 'server.mjs'), 0o755);
  writeFileSync(
    join(target, 'package.json'),
    `${JSON.stringify({ name: id, version: '1.0.0', private: true, type: 'module' }, null, 2)}\n`,
  );
  writeFileSync(
    join(target, 'README.md'),
    `# ${name}\n\nGenerated FolderForge MCP plugin.\n\n` +
      '```bash\n' +
      `folderforge plugin validate ${JSON.stringify(target)}\n` +
      `folderforge plugin test ${JSON.stringify(target)}\n` +
      '```\n\n' +
      'The template has no install or lifecycle scripts. Review permissions and risk declarations before adding tools.\n',
  );
  return { ok: true, command: 'init', target, id, name, sandbox: sandboxMode };
}

async function testPlugin(args: ParsedArgs): Promise<Record<string, unknown>> {
  const source = positional(args, 0, 'Plugin directory');
  const validation = validateSource(source);
  const timeoutMs = Number(option(args, 'timeout-ms') ?? 15_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`--timeout-ms must be an integer from 1000 to ${MAX_TIMEOUT_MS}.`);
  }
  const temp = mkdtempSync(join(tmpdir(), 'folderforge-plugin-sdk-test-'));
  const manager = new PluginManager(temp, readFolderForgeVersion());
  let client: StdioChildClient | undefined;
  try {
    const installed = manager.install(validation.source, true);
    const adapter = manager.adapter(installed.id);
    const launch = applySandboxLaunch(adapter.def, resolveAdapterLaunch(adapter.name, adapter.def));
    client = new StdioChildClient({
      adapter: adapter.name,
      command: launch.command,
      args: launch.args,
      env: adapter.def.env ?? {},
      ...(launch.cwd ? { cwd: launch.cwd } : {}),
      inheritEnv:
        adapter.def.sandbox && adapter.def.sandbox.mode !== 'process'
          ? true
          : adapter.def.inheritEnv !== false,
      requestTimeoutMs: timeoutMs,
    });
    await client.start();
    const tools = await client.listTools({ timeoutMs });
    if (tools.length === 0) throw new Error('Plugin initialized but advertised no tools.');
    let callResult: unknown;
    const call = option(args, 'call');
    if (call) {
      const raw = option(args, 'args-json') ?? '{}';
      const callArgs = JSON.parse(raw) as unknown;
      if (!callArgs || typeof callArgs !== 'object' || Array.isArray(callArgs)) {
        throw new Error('--args-json must decode to an object.');
      }
      callResult = await client.callTool(call, callArgs as Record<string, unknown>, { timeoutMs });
    }
    return {
      ok: true,
      command: 'test',
      plugin: validation.manifest.id,
      protocolVersion: client.protocolVersion(),
      tools: tools.map((tool) => tool.name),
      sandbox: sandboxSummary(adapter.def.sandbox),
      transport: client.transportStats(),
      ...(call ? { call, callResult } : {}),
    };
  } finally {
    await client?.stopAndWait().catch(() => undefined);
    rmSync(temp, { recursive: true, force: true });
  }
}

async function packPlugin(args: ParsedArgs): Promise<Record<string, unknown>> {
  const validation = validateSource(positional(args, 0, 'Plugin directory'));
  const defaultName = `${validation.manifest.id}-${validation.manifest.version}.tgz`;
  const output = resolve(option(args, 'out') ?? join(process.cwd(), defaultName));
  const rel = relative(validation.source, output);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error('--out must be outside the plugin source directory.');
  }
  mkdirSync(dirname(output), { recursive: true });
  const files = safeFiles(validation.source, output);
  await tar.c(
    { gzip: true, cwd: validation.source, file: output, portable: true, noMtime: true },
    files,
  );
  const bytes = readFileSync(output);
  return {
    ok: true,
    command: 'pack',
    plugin: validation.manifest.id,
    version: validation.manifest.version,
    output,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    files: files.length,
    warnings: validation.warnings,
  };
}

function keygen(args: ParsedArgs): Record<string, unknown> {
  const directory = resolve(args.positionals[0] ?? process.cwd());
  mkdirSync(directory, { recursive: true });
  const privatePath = resolve(option(args, 'private-key') ?? join(directory, 'publisher-private.pem'));
  const publicPath = resolve(option(args, 'public-key') ?? join(directory, 'publisher-public.pem'));
  if (privatePath === publicPath) throw new Error('Private and public key paths must be different.');
  mkdirSync(dirname(privatePath), { recursive: true });
  mkdirSync(dirname(publicPath), { recursive: true });
  if ((existsSync(privatePath) || existsSync(publicPath)) && !args.flags.has('force')) {
    throw new Error('Publisher key file already exists. Use --force only after reviewing the destination.');
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  writeFileSync(privatePath, privateKeyPem, { mode: 0o600 });
  writeFileSync(publicPath, publicKeyPem, { mode: 0o644 });
  if (process.platform !== 'win32') {
    chmodSync(privatePath, 0o600);
    chmodSync(publicPath, 0o644);
  }
  const fingerprint = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
  return { ok: true, command: 'keygen', privateKey: privatePath, publicKey: publicPath, fingerprint };
}

function sbomFor(manifest: PluginManifest, sourceDigest: string): Record<string, unknown> {
  const uuid = `${sourceDigest.slice(0, 8)}-${sourceDigest.slice(8, 12)}-${sourceDigest.slice(12, 16)}-${sourceDigest.slice(16, 20)}-${sourceDigest.slice(20, 32)}`;
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${uuid}`,
    version: 1,
    metadata: {
      component: {
        type: 'application',
        'bom-ref': `${manifest.id}@${manifest.version}`,
        name: manifest.id,
        version: manifest.version,
        hashes: [{ alg: 'SHA-256', content: sourceDigest }],
      },
      tools: { components: [{ type: 'application', name: 'FolderForge Plugin SDK', version: readFolderForgeVersion() }] },
    },
    components: [],
  };
}

async function signPlugin(args: ParsedArgs): Promise<Record<string, unknown>> {
  const validation = validateSource(positional(args, 0, 'Plugin directory'));
  const publisherId = requiredOption(args, 'publisher-id');
  const privateKeyPath = resolve(requiredOption(args, 'private-key'));
  const privateKeyPem = readFileSync(privateKeyPath, 'utf8');
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Publisher private key must be Ed25519.');
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const output = resolve(
    option(args, 'out') ??
      join(process.cwd(), `${validation.manifest.id}-${validation.manifest.version}.tgz`),
  );
  const entryOutput = resolve(option(args, 'entry-out') ?? `${output}.entry.json`);
  const repository = requiredOption(args, 'repository');
  const commit = requiredOption(args, 'commit');
  const workflow = requiredOption(args, 'workflow');
  const builder = option(args, 'builder') ?? 'folderforge-plugin-sdk';
  const temp = mkdtempSync(join(tmpdir(), 'folderforge-plugin-sign-'));
  const staging = join(temp, 'source');
  try {
    cpSync(validation.source, staging, {
      recursive: true,
      filter: (path) => basename(path) !== '.git',
    });
    rmSync(join(staging, 'sbom.cdx.json'), { force: true });
    rmSync(join(staging, 'provenance.json'), { force: true });
    const sourceDigest = calculatePluginIntegrity(staging).digest;
    const provenance: MarketplaceProvenance = {
      repository,
      commit,
      workflow,
      sourceDigest,
      builder,
    };
    writeFileSync(join(staging, 'sbom.cdx.json'), `${JSON.stringify(sbomFor(validation.manifest, sourceDigest), null, 2)}\n`);
    writeFileSync(join(staging, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);

    const plugins = new PluginManager(temp, readFolderForgeVersion());
    const scanner = new SecretPolicy({ entropyEnabled: false, minEntropy: 4, minLength: 20 });
    const marketplace = new MarketplaceManager(temp, readFolderForgeVersion(), plugins, {
      secretScan: (text) => scanner.scan(text),
    });
    marketplace.addPublisher({ id: publisherId, name: option(args, 'publisher-name') ?? publisherId, publicKeyPem });
    const created = await marketplace.createPackage({
      sourceDir: staging,
      outputFile: output,
      ...(option(args, 'package-url') ? { packageUrl: option(args, 'package-url')! } : {}),
      publisherId,
      privateKeyPem,
      provenance,
    });
    mkdirSync(dirname(entryOutput), { recursive: true });
    writeFileSync(entryOutput, `${JSON.stringify(created.entry, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(entryOutput, 0o600);
    return {
      ok: true,
      command: 'sign',
      plugin: created.entry.id,
      version: created.entry.version,
      package: created.packagePath,
      entry: entryOutput,
      packageSha256: created.entry.packageDigest,
      publisherId,
      publisherFingerprint: marketplace.listPublishers()[0]?.publicKeyFingerprint,
      sourceDigest,
      scan: created.scan,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function help(): string {
  return [
    'FolderForge Plugin SDK',
    '',
    'Usage: folderforge plugin <command> [directory] [options]',
    '',
    'Commands:',
    '  init <dir>       Create a dependency-free MCP plugin template',
    '  validate <dir>   Validate manifest, paths, limits, and package integrity',
    '  test <dir>       Initialize the child MCP server and list its tools',
    '  pack <dir>       Create a deterministic prepared-package tgz',
    '  keygen [dir]     Generate an Ed25519 publisher key pair',
    '  sign <dir>       Create SBOM/provenance, signed tgz, and index entry',
    '',
    'Common options:',
    '  --json',
    '  --force',
    '',
    'Test options:',
    '  --timeout-ms <1000..60000>',
    '  --call <tool> --args-json <object>   Explicitly call one tool',
    '',
    'Sign options:',
    '  --publisher-id <id> --private-key <pem>',
    '  --repository <url> --commit <sha> --workflow <id>',
    '  --out <tgz> [--entry-out <json>] [--package-url <https-or-file-url>]',
    '',
  ].join('\n');
}

export async function executePluginSdkCli(argv: string[]): Promise<PluginSdkCliResult> {
  const args = parse(argv);
  try {
    let value: unknown;
    switch (args.command) {
      case 'help':
      case '--help':
      case '-h':
        return { exitCode: 0, output: help() };
      case 'init':
        value = initializePlugin(args);
        break;
      case 'validate': {
        const result = validateSource(positional(args, 0, 'Plugin directory'));
        value = {
          ok: true,
          command: 'validate',
          source: result.source,
          manifest: result.manifest,
          integrity: result.integrity,
          warnings: result.warnings,
        };
        break;
      }
      case 'test':
        value = await testPlugin(args);
        break;
      case 'pack':
        value = await packPlugin(args);
        break;
      case 'keygen':
        value = keygen(args);
        break;
      case 'sign':
        value = await signPlugin(args);
        break;
      default:
        throw new Error(`Unknown plugin SDK command: ${args.command}`);
    }
    return { exitCode: 0, output: jsonOutput(args, value) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      output: jsonOutput(args, { ok: false, command: args.command, error: message }),
    };
  }
}
