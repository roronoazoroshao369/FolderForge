import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MANIFEST = resolve('compatibility/child-mcp-third-party.json');
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const PLACEHOLDER_RE = /\{\{(profileRoot|installRoot)\}\}/g;
const SAFE_ENV_KEYS = [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
  'LANG',
  'LC_ALL',
  'TZ',
];

function usage() {
  return [
    'Usage: node scripts/child-mcp-third-party.mjs [options]',
    '',
    'Options:',
    '  --manifest <path>       Compatibility manifest (default: compatibility/child-mcp-third-party.json)',
    '  --output <path>         Write the JSON report with mode 0600',
    '  --install-root <path>   Reuse or create an explicit package installation root',
    '  --skip-install          Do not run npm install; requires --install-root',
    '  --keep-install          Preserve temporary install/work directories for diagnosis',
    '  --profile <id>          Run one profile; may be repeated',
    '  --validate-only         Validate pins and print the manifest summary without network/process execution',
    '  --help                  Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    manifest: DEFAULT_MANIFEST,
    output: null,
    installRoot: null,
    skipInstall: false,
    keepInstall: false,
    validateOnly: false,
    profiles: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      process.stdout.write(`${usage()}\n`);
      return null;
    }
    if (arg === '--skip-install') {
      options.skipInstall = true;
      continue;
    }
    if (arg === '--keep-install') {
      options.keepInstall = true;
      continue;
    }
    if (arg === '--validate-only') {
      options.validateOnly = true;
      continue;
    }
    if (arg === '--manifest' || arg === '--output' || arg === '--install-root' || arg === '--profile') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value.`);
      index += 1;
      if (arg === '--manifest') options.manifest = resolve(value);
      if (arg === '--output') options.output = resolve(value);
      if (arg === '--install-root') options.installRoot = resolve(value);
      if (arg === '--profile') options.profiles.push(value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.skipInstall && !options.installRoot) {
    throw new Error('--skip-install requires --install-root.');
  }
  return options;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function validateStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings.`);
  }
}

function validateManifest(raw) {
  if (!isPlainObject(raw) || raw.schemaVersion !== 1) {
    throw new Error('Compatibility manifest schemaVersion must equal 1.');
  }
  if (!Array.isArray(raw.profiles) || raw.profiles.length < 1) {
    throw new Error('Compatibility manifest must contain at least one profile.');
  }
  const ids = new Set();
  const packageVersions = new Set();
  for (const [index, profile] of raw.profiles.entries()) {
    const label = `profiles[${index}]`;
    if (!isPlainObject(profile)) throw new Error(`${label} must be an object.`);
    assertString(profile.id, `${label}.id`);
    if (!ID_RE.test(profile.id)) throw new Error(`${label}.id must be lowercase kebab-case.`);
    if (ids.has(profile.id)) throw new Error(`Duplicate profile id: ${profile.id}`);
    ids.add(profile.id);
    assertString(profile.product, `${label}.product`);
    assertString(profile.package, `${label}.package`);
    if (!PACKAGE_RE.test(profile.package)) throw new Error(`${label}.package is not a valid npm package name.`);
    assertString(profile.version, `${label}.version`);
    if (!EXACT_VERSION_RE.test(profile.version)) {
      throw new Error(`${label}.version must be an exact pinned version, not a tag or range.`);
    }
    const packageVersion = `${profile.package}@${profile.version}`;
    if (packageVersions.has(packageVersion)) {
      throw new Error(`Duplicate package/version profile: ${packageVersion}`);
    }
    packageVersions.add(packageVersion);
    assertString(profile.integrity, `${label}.integrity`);
    if (!profile.integrity.startsWith('sha512-')) {
      throw new Error(`${label}.integrity must be an npm sha512 integrity value.`);
    }
    assertString(profile.bin, `${label}.bin`);
    assertString(profile.source, `${label}.source`);
    if (!profile.source.startsWith('https://')) throw new Error(`${label}.source must use HTTPS.`);
    validateStringArray(profile.args ?? [], `${label}.args`);
    validateStringArray(profile.directories ?? [], `${label}.directories`);
    if (profile.env !== undefined) {
      if (!isPlainObject(profile.env)) throw new Error(`${label}.env must be an object.`);
      for (const [key, value] of Object.entries(profile.env)) {
        assertString(key, `${label}.env key`);
        if (typeof value !== 'string') throw new Error(`${label}.env.${key} must be a string.`);
      }
    }
    if (!isPlainObject(profile.expected)) throw new Error(`${label}.expected must be an object.`);
    if (!Number.isSafeInteger(profile.expected.minTools) || profile.expected.minTools < 1) {
      throw new Error(`${label}.expected.minTools must be a positive safe integer.`);
    }
    validateStringArray(profile.expected.requiredTools, `${label}.expected.requiredTools`);
    if (profile.expected.requiredTools.length < 1) {
      throw new Error(`${label}.expected.requiredTools must not be empty.`);
    }
    if (new Set(profile.expected.requiredTools).size !== profile.expected.requiredTools.length) {
      throw new Error(`${label}.expected.requiredTools contains duplicates.`);
    }
    if (profile.safeCall !== undefined) {
      if (!isPlainObject(profile.safeCall)) throw new Error(`${label}.safeCall must be an object.`);
      assertString(profile.safeCall.tool, `${label}.safeCall.tool`);
      if (!profile.expected.requiredTools.includes(profile.safeCall.tool)) {
        throw new Error(`${label}.safeCall.tool must also be listed in expected.requiredTools.`);
      }
      if (!isPlainObject(profile.safeCall.args)) throw new Error(`${label}.safeCall.args must be an object.`);
      if (
        profile.safeCall.expectTextIncludes !== undefined &&
        typeof profile.safeCall.expectTextIncludes !== 'string'
      ) {
        throw new Error(`${label}.safeCall.expectTextIncludes must be a string.`);
      }
    }
  }
  return raw;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return createHash('sha256').update(input).digest('hex');
}

function sha256Json(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function replacePlaceholders(value, roots) {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER_RE, (_match, name) => roots[name]);
  }
  if (Array.isArray(value)) return value.map((entry) => replacePlaceholders(entry, roots));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, replacePlaceholders(entry, roots)]),
    );
  }
  return value;
}

function normalizeEvidenceText(value, roots) {
  let output = String(value ?? '');
  const replacements = [
    [roots.profileRoot, '{{profileRoot}}'],
    [roots.installRoot, '{{installRoot}}'],
  ].sort((left, right) => right[0].length - left[0].length);
  for (const [from, to] of replacements) {
    if (from) output = output.split(from).join(to);
  }
  return output;
}

function normalizeEvidenceValue(value, roots) {
  if (typeof value === 'string') return normalizeEvidenceText(value, roots);
  if (Array.isArray(value)) return value.map((entry) => normalizeEvidenceValue(entry, roots));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeEvidenceValue(entry, roots)]),
    );
  }
  return value;
}

function commandResult(executed) {
  return {
    ok: executed.status === 0 && !executed.error,
    status: executed.status,
    signal: executed.signal,
    stdout: executed.stdout ?? '',
    stderr: executed.stderr ?? '',
    error: executed.error?.message ?? null,
  };
}

function runCommand(command, args, options = {}) {
  return commandResult(
    spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      timeout: options.timeoutMs ?? 180_000,
      windowsHide: true,
    }),
  );
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function gitMetadata() {
  const commit = runCommand('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), timeoutMs: 10_000 });
  const status = runCommand('git', ['status', '--porcelain'], { cwd: process.cwd(), timeoutMs: 10_000 });
  return {
    commit: commit.ok ? commit.stdout.trim() : null,
    workingTreeDirty: status.ok ? status.stdout.trim().length > 0 : null,
  };
}

function sourceInputs(manifestPath) {
  const paths = [
    manifestPath,
    fileURLToPath(import.meta.url),
    resolve('dist/adapters/child-mcp/client.js'),
  ];
  return paths
    .filter((path) => existsSync(path))
    .map((path) => ({
      path: relative(process.cwd(), path).split(sep).join('/'),
      sha256: sha256(readFileSync(path)),
    }));
}

function packageRoot(installRoot, packageName) {
  return join(installRoot, 'node_modules', ...packageName.split('/'));
}

function assertInside(parent, child, label) {
  const parentReal = realpathSync(parent);
  const childReal = realpathSync(child);
  const relativePath = relative(parentReal, childReal);
  if (relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith(`..${sep}`))) {
    return childReal;
  }
  throw new Error(`${label} resolves outside its installed package root.`);
}

function inspectInstalledPackages(manifest, installRoot) {
  const lockPath = join(installRoot, 'package-lock.json');
  if (!existsSync(lockPath)) throw new Error(`Missing package lock at ${lockPath}`);
  const lock = readJson(lockPath);
  const packages = new Map();
  for (const profile of manifest.profiles) {
    const root = packageRoot(installRoot, profile.package);
    const packageJsonPath = join(root, 'package.json');
    if (!existsSync(packageJsonPath)) {
      throw new Error(`Installed package is missing: ${profile.package}@${profile.version}`);
    }
    const packageJson = readJson(packageJsonPath);
    if (packageJson.version !== profile.version) {
      throw new Error(
        `${profile.package} resolved to ${String(packageJson.version)}, expected ${profile.version}.`,
      );
    }
    const lockEntry = lock.packages?.[`node_modules/${profile.package}`];
    if (!lockEntry) throw new Error(`package-lock.json is missing ${profile.package}.`);
    if (lockEntry.version !== profile.version) {
      throw new Error(`${profile.package} lock version does not match ${profile.version}.`);
    }
    if (lockEntry.integrity !== profile.integrity) {
      throw new Error(`${profile.package} integrity does not match the pinned manifest value.`);
    }
    const binMap =
      typeof packageJson.bin === 'string'
        ? { [profile.bin]: packageJson.bin }
        : packageJson.bin;
    const relativeBin = binMap?.[profile.bin];
    if (typeof relativeBin !== 'string' || relativeBin.length === 0) {
      throw new Error(`${profile.package} does not expose the pinned bin ${profile.bin}.`);
    }
    const entry = join(root, relativeBin);
    if (!existsSync(entry)) throw new Error(`${profile.package} bin entry is missing: ${relativeBin}`);
    packages.set(profile.id, {
      entry: assertInside(root, entry, `${profile.package} bin`),
      package: profile.package,
      version: profile.version,
      integrity: profile.integrity,
      bin: profile.bin,
    });
  }
  return {
    packages,
    lockSha256: sha256(readFileSync(lockPath)),
  };
}

function installPackages(manifest, installRoot, skipInstall) {
  mkdirSync(installRoot, { recursive: true });
  let installEvidence;
  if (skipInstall) {
    installEvidence = {
      mode: 'reused',
      lifecycleScripts: 'not-run',
      elapsedMs: 0,
      warnings: [],
    };
  } else {
    const specs = manifest.profiles.map((profile) => `${profile.package}@${profile.version}`);
    const startedAt = performance.now();
    const installed = runCommand(
      npmCommand(),
      [
        'install',
        '--ignore-scripts',
        '--save-exact',
        '--no-audit',
        '--no-fund',
        '--package-lock=true',
        '--loglevel=warn',
        '--prefix',
        installRoot,
        ...specs,
      ],
      { cwd: process.cwd(), timeoutMs: 300_000 },
    );
    if (!installed.ok) {
      throw new Error(
        `Pinned third-party package installation failed: ${installed.error ?? (installed.stderr.trim() || `exit ${installed.status}`)}`,
      );
    }
    installEvidence = {
      mode: 'installed',
      lifecycleScripts: 'disabled (--ignore-scripts)',
      elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
      warnings: installed.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 20),
    };
  }
  const inspected = inspectInstalledPackages(manifest, installRoot);
  return { ...installEvidence, ...inspected };
}

function auditInstall(installRoot) {
  const executed = runCommand(
    npmCommand(),
    ['audit', '--omit=dev', '--json', '--prefix', installRoot],
    { cwd: process.cwd(), timeoutMs: 180_000 },
  );
  let parsed;
  try {
    parsed = JSON.parse(executed.stdout);
  } catch {
    return {
      ok: false,
      status: executed.status,
      error: executed.error ?? (executed.stderr.trim() || 'npm audit did not return JSON.'),
      vulnerabilities: null,
      dependencies: null,
    };
  }
  const vulnerabilities = parsed.metadata?.vulnerabilities ?? null;
  const total = vulnerabilities?.total;
  return {
    ok: executed.status === 0 && total === 0,
    status: executed.status,
    error: executed.error ?? null,
    vulnerabilities,
    dependencies: parsed.metadata?.dependencies ?? null,
  };
}

function profileEnvironment(profileRoot, declaredEnv) {
  const temp = join(profileRoot, 'tmp');
  mkdirSync(temp, { recursive: true });
  const env = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME = profileRoot;
  env.USERPROFILE = profileRoot;
  env.TMPDIR = temp;
  env.TEMP = temp;
  env.TMP = temp;
  env.NO_COLOR = '1';
  env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';
  for (const [key, value] of Object.entries(declaredEnv ?? {})) env[key] = value;
  return env;
}

function summarizeCallResult(result, roots) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter((entry) => entry?.type === 'text' && typeof entry.text === 'string')
    .map((entry) => entry.text)
    .join('\n');
  return {
    isError: result?.isError === true,
    contentTypes: [...new Set(content.map((entry) => entry?.type).filter((type) => typeof type === 'string'))],
    textPreview: normalizeEvidenceText(text, roots).slice(0, 500),
    hasStructuredContent: isPlainObject(result?.structuredContent),
  };
}

async function runProfile(profile, packageInfo, installRoot, workRoot) {
  const profileRoot = join(workRoot, profile.id);
  mkdirSync(profileRoot, { recursive: true });
  const roots = { profileRoot, installRoot };
  for (const directory of replacePlaceholders(profile.directories ?? [], roots)) {
    mkdirSync(directory, { recursive: true });
  }
  const args = replacePlaceholders(profile.args ?? [], roots);
  const declaredEnv = replacePlaceholders(profile.env ?? {}, roots);
  const startedAt = performance.now();
  const { StdioChildClient } = await import('../dist/adapters/child-mcp/client.js');
  const child = new StdioChildClient({
    adapter: `third-party:${profile.id}`,
    command: process.execPath,
    args: [packageInfo.entry, ...args],
    env: profileEnvironment(profileRoot, declaredEnv),
    cwd: profileRoot,
    inheritEnv: false,
    requestTimeoutMs: 20_000,
    heartbeatIntervalMs: 0,
    maxCatalogPages: 100,
    maxCatalogTools: 10_000,
    maxPendingRequests: 64,
  });
  let evidence;
  let errorEvidence = null;
  let shutdownError = null;
  try {
    await child.start();
    const tools = await child.listTools();
    const names = tools.map((tool) => tool.name);
    if (tools.length < profile.expected.minTools) {
      throw new Error(
        `${profile.id} advertised ${tools.length} tools, below minimum ${profile.expected.minTools}.`,
      );
    }
    const missing = profile.expected.requiredTools.filter((name) => !names.includes(name));
    if (missing.length > 0) {
      throw new Error(`${profile.id} is missing required tools: ${missing.join(', ')}`);
    }
    let safeCall = null;
    if (profile.safeCall) {
      const callArgs = replacePlaceholders(profile.safeCall.args, roots);
      const result = await child.callTool(profile.safeCall.tool, callArgs);
      safeCall = {
        tool: profile.safeCall.tool,
        contract: 'manifest-reviewed read-only/idempotent probe',
        result: summarizeCallResult(result, roots),
      };
      if (result?.isError === true) {
        throw new Error(`${profile.id} safe probe ${profile.safeCall.tool} returned isError=true.`);
      }
      if (profile.safeCall.expectTextIncludes !== undefined) {
        const expected = replacePlaceholders(profile.safeCall.expectTextIncludes, roots);
        const actual = Array.isArray(result?.content)
          ? result.content
              .filter((entry) => entry?.type === 'text' && typeof entry.text === 'string')
              .map((entry) => entry.text)
              .join('\n')
          : '';
        if (!actual.includes(expected)) {
          throw new Error(
            `${profile.id} safe probe ${profile.safeCall.tool} did not contain the expected text.`,
          );
        }
      }
    }
    evidence = {
      protocolVersion: child.protocolVersion(),
      toolCount: tools.length,
      requiredTools: profile.expected.requiredTools,
      toolSample: names.slice(0, 25),
      catalogSha256: sha256Json(
        tools
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      ),
      safeCall,
      transport: child.transportStats(),
    };
  } catch (error) {
    errorEvidence = {
      name: error instanceof Error ? error.name : 'Error',
      message: normalizeEvidenceText(error instanceof Error ? error.message : String(error), roots),
      diagnostic: normalizeEvidenceValue(error?.diagnostic ?? null, roots),
    };
  } finally {
    try {
      await child.stopAndWait(3_000);
    } catch (error) {
      shutdownError = normalizeEvidenceText(error instanceof Error ? error.message : String(error), roots);
    }
  }
  return {
    id: profile.id,
    product: profile.product,
    package: profile.package,
    version: profile.version,
    integrity: profile.integrity,
    source: profile.source,
    status: errorEvidence === null && shutdownError === null ? 'pass' : 'fail',
    elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
    evidence,
    error: errorEvidence,
    shutdownError,
  };
}

function selectProfiles(manifest, requested) {
  if (requested.length === 0) return manifest.profiles;
  const wanted = new Set(requested);
  const unknown = requested.filter((id) => !manifest.profiles.some((profile) => profile.id === id));
  if (unknown.length > 0) throw new Error(`Unknown profile id(s): ${unknown.join(', ')}`);
  return manifest.profiles.filter((profile) => wanted.has(profile.id));
}

function emitReport(report, output) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, serialized, { encoding: 'utf8', mode: 0o600 });
  }
  process.stdout.write(serialized);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) return;
  const manifest = validateManifest(readJson(options.manifest));
  const selected = selectProfiles(manifest, options.profiles);
  const manifestSha256 = sha256Json(manifest);
  if (options.validateOnly) {
    emitReport(
      {
        schemaVersion: 1,
        mode: 'validate-only',
        manifest: relative(process.cwd(), options.manifest).split(sep).join('/'),
        manifestSha256,
        profiles: selected.map((profile) => ({
          id: profile.id,
          package: profile.package,
          version: profile.version,
          integrity: profile.integrity,
          bin: profile.bin,
        })),
        summary: { total: selected.length, valid: selected.length, invalid: 0 },
      },
      options.output,
    );
    return;
  }

  const temporaryInstall = options.installRoot === null;
  const installRoot = options.installRoot ?? mkdtempSync(join(tmpdir(), 'folderforge third-party ünicode-'));
  const workRoot = mkdtempSync(join(tmpdir(), 'folderforge child work ünicode-'));
  const startedAt = performance.now();
  let install = null;
  let audit = null;
  const profileResults = [];
  let fatalError = null;
  try {
    install = installPackages({ ...manifest, profiles: selected }, installRoot, options.skipInstall);
    audit = auditInstall(installRoot);
    for (const profile of selected) {
      const packageInfo = install.packages.get(profile.id);
      if (!packageInfo) throw new Error(`Missing inspected package metadata for ${profile.id}.`);
      profileResults.push(await runProfile(profile, packageInfo, installRoot, workRoot));
    }
  } catch (error) {
    fatalError = error instanceof Error ? error.message : String(error);
  }

  const failedProfiles = profileResults.filter((profile) => profile.status !== 'pass');
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    implementation: 'FolderForge StdioChildClient third-party compatibility matrix',
    source: {
      ...gitMetadata(),
      inputs: sourceInputs(options.manifest),
    },
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      arch: arch(),
      logicalCpuCount: cpus().length,
      installPathHasSpaces: /\s/.test(installRoot),
      installPathHasUnicode: [...installRoot].some((character) => character.codePointAt(0) > 127),
    },
    manifest: {
      path: relative(process.cwd(), options.manifest).split(sep).join('/'),
      sha256: manifestSha256,
    },
    installation: install
      ? {
          mode: install.mode,
          lifecycleScripts: install.lifecycleScripts,
          elapsedMs: install.elapsedMs,
          packageLockSha256: install.lockSha256,
          warnings: install.warnings,
        }
      : null,
    audit,
    profiles: profileResults,
    summary: {
      total: selected.length,
      executed: profileResults.length,
      passed: profileResults.length - failedProfiles.length,
      failed: failedProfiles.length,
      fatal: fatalError !== null,
      elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
    },
    fatalError,
    limitations: [
      'Evidence applies only to the exact package versions, integrity pins, FolderForge source inputs, Node version, and operating system recorded in this report.',
      'The matrix proves stdio initialize, bounded tools/list, clean shutdown, and only the explicitly reviewed read-only/idempotent probes; it does not certify every tool or mutation path.',
      'Independent reproduction and additional operating-system runs remain separate evidence gates until their artifacts exist for the same revision.',
    ],
  };
  emitReport(report, options.output);
  if (fatalError !== null || failedProfiles.length > 0 || audit?.ok !== true) process.exitCode = 1;

  if (!options.keepInstall) {
    rmSync(workRoot, { recursive: true, force: true });
    if (temporaryInstall) rmSync(installRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`Third-party child MCP compatibility failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
