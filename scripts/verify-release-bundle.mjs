import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  RELEASE_BUNDLE_SCHEMA_VERSION,
  describeFile,
  readPackedPackageJson,
  sha512Integrity,
  stableJson,
} from './release-provenance-lib.mjs';

function parseArgs(argv) {
  let bundleDir = '';
  let root = '';
  let registry = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--bundle-dir') bundleDir = argv[++index] ?? '';
    else if (arg === '--root') root = argv[++index] ?? '';
    else if (arg === '--registry') registry = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!bundleDir) throw new Error('Missing required --bundle-dir path');
  return {
    bundleDir: resolve(bundleDir),
    root: root ? resolve(root) : '',
    registry,
  };
}

function readChecksums(path) {
  const entries = new Map();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64}) {2}([^/\\]+)$/i.exec(line);
    if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
    if (entries.has(match[2])) throw new Error(`Duplicate checksum entry: ${match[2]}`);
    entries.set(match[2], match[1].toLowerCase());
  }
  return entries;
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function verifyLocalSource(root, manifest) {
  const tagRef = `refs/tags/${manifest.source.tag}`;
  const tagType = git(root, ['cat-file', '-t', tagRef]);
  if (tagType !== 'tag') throw new Error(`${manifest.source.tag} is not an annotated tag`);
  const tagCommit = git(root, ['rev-list', '-n', '1', tagRef]);
  if (tagCommit !== manifest.source.commit) {
    throw new Error(`Local tag resolves to ${tagCommit}, not ${manifest.source.commit}`);
  }
  const packageJson = JSON.parse(git(root, ['show', `${manifest.source.commit}:package.json`]));
  if (
    packageJson.name !== manifest.package.name ||
    packageJson.version !== manifest.package.version
  ) {
    throw new Error('Tagged source package metadata does not match release bundle');
  }
}

function verifyRegistry(manifest, tarballFile) {
  const raw = execFileSync(
    'npm',
    [
      'view',
      `${manifest.package.name}@${manifest.package.version}`,
      'gitHead',
      'dist.integrity',
      'dist.shasum',
      '--json',
    ],
    { encoding: 'utf8', windowsHide: true },
  ).trim();
  const metadata = JSON.parse(raw);
  const actual = describeFile(tarballFile);
  if (metadata.gitHead !== manifest.source.commit) {
    throw new Error(`npm gitHead ${metadata.gitHead ?? '<missing>'} does not match bundle commit`);
  }
  if (metadata['dist.integrity'] !== sha512Integrity(actual.sha512)) {
    throw new Error('npm dist.integrity does not match the bundle tarball');
  }
  if (metadata['dist.shasum'] !== actual.sha1) {
    throw new Error('npm dist.shasum does not match the bundle tarball');
  }
  return metadata;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = resolve(args.bundleDir, 'release-bundle.json');
  const checksumsPath = resolve(args.bundleDir, 'SHA256SUMS');
  if (!existsSync(manifestPath)) throw new Error(`Missing ${manifestPath}`);
  if (!existsSync(checksumsPath)) throw new Error(`Missing ${checksumsPath}`);

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== RELEASE_BUNDLE_SCHEMA_VERSION) {
    throw new Error(`Unsupported release bundle schema: ${manifest.schemaVersion}`);
  }
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.source?.tag ?? '')) {
    throw new Error('Bundle source tag is invalid');
  }
  if (manifest.source.tag !== `v${manifest.package?.version}`) {
    throw new Error('Bundle source tag and package version do not match');
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.source?.commit ?? '')) {
    throw new Error('Bundle source commit is invalid');
  }

  const checksumEntries = readChecksums(checksumsPath);
  const requiredFiles = new Set(['release-bundle.json']);
  for (const [name, expected] of Object.entries(manifest.files ?? {})) {
    requiredFiles.add(name);
    const path = resolve(args.bundleDir, name);
    if (basename(path) !== name || !existsSync(path)) throw new Error(`Missing bundle file: ${name}`);
    const actual = describeFile(path);
    for (const field of ['bytes', 'sha1', 'sha256', 'sha512']) {
      if (actual[field] !== expected[field]) {
        throw new Error(`${name} ${field} does not match release-bundle.json`);
      }
    }
  }
  for (const name of requiredFiles) {
    const path = resolve(args.bundleDir, name);
    const expected = checksumEntries.get(name);
    if (!expected) throw new Error(`SHA256SUMS is missing ${name}`);
    if (describeFile(path).sha256 !== expected) throw new Error(`${name} fails SHA256SUMS`);
  }
  if (checksumEntries.size !== requiredFiles.size) {
    throw new Error('SHA256SUMS contains unexpected files');
  }

  const tarballName = manifest.npmPack?.filename;
  if (!tarballName || !manifest.files[tarballName]) {
    throw new Error('Bundle does not identify the npm tarball');
  }
  const tarballFile = resolve(args.bundleDir, tarballName);
  const packedPackage = await readPackedPackageJson(tarballFile);
  if (
    packedPackage.name !== manifest.package.name ||
    packedPackage.version !== manifest.package.version
  ) {
    throw new Error('Tarball package metadata does not match release-bundle.json');
  }
  const tarballDescription = describeFile(tarballFile);
  if (manifest.npmPack.integrity !== sha512Integrity(tarballDescription.sha512)) {
    throw new Error('Manifest npm integrity does not match the tarball');
  }
  if (manifest.npmPack.shasum !== tarballDescription.sha1) {
    throw new Error('Manifest npm shasum does not match the tarball');
  }

  if (args.root) verifyLocalSource(args.root, manifest);
  const registry = args.registry ? verifyRegistry(manifest, tarballFile) : null;
  console.log(
    stableJson({
      ok: true,
      package: manifest.package,
      source: manifest.source,
      filesVerified: requiredFiles.size,
      localSourceVerified: Boolean(args.root),
      registryVerified: Boolean(registry),
    }).trim(),
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
