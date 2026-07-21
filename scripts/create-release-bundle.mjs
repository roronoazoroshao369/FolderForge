import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  RELEASE_BUNDLE_SCHEMA_VERSION,
  describeFile,
  readPackedPackageJson,
  sha512Integrity,
  stableJson,
} from './release-provenance-lib.mjs';

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) {
      throw new Error(`Invalid argument sequence near ${key ?? '<end>'}`);
    }
    values.set(key.slice(2), value);
  }
  const required = ['tag', 'commit', 'tarball', 'sbom', 'notes', 'pack-json', 'output-dir'];
  for (const name of required) {
    if (!values.get(name)) throw new Error(`Missing required --${name} argument`);
  }
  return Object.fromEntries(values);
}

function assertFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
}

function commitTimestamp(root, commit) {
  try {
    return execFileSync('git', ['show', '-s', '--format=%cI', commit], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root ?? process.cwd());
  const tag = args.tag;
  const commit = args.commit;
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`Invalid semantic release tag: ${tag}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error(`Invalid commit SHA: ${commit}`);

  const tarball = resolve(root, args.tarball);
  const sbom = resolve(root, args.sbom);
  const notes = resolve(root, args.notes);
  const packJsonPath = resolve(root, args['pack-json']);
  const outputDir = resolve(root, args['output-dir']);
  assertFile(tarball, 'Tarball');
  assertFile(sbom, 'SBOM');
  assertFile(notes, 'Release notes');
  assertFile(packJsonPath, 'npm pack JSON');
  mkdirSync(outputDir, { recursive: true });

  const packedPackage = await readPackedPackageJson(tarball);
  const expectedVersion = tag.slice(1);
  if (packedPackage.version !== expectedVersion) {
    throw new Error(
      `Tarball package version ${packedPackage.version} does not match ${expectedVersion}`,
    );
  }
  const packData = JSON.parse(readFileSync(packJsonPath, 'utf8'));
  const pack = Array.isArray(packData) ? packData[0] : packData;
  if (!pack || typeof pack !== 'object') throw new Error('npm pack JSON is invalid');
  if (pack.name !== packedPackage.name || pack.version !== packedPackage.version) {
    throw new Error('npm pack metadata does not match package/package.json');
  }

  const sourceFiles = [tarball, sbom, notes, packJsonPath];
  const names = sourceFiles.map((path) => basename(path));
  if (new Set(names).size !== names.length) {
    throw new Error('Release bundle input basenames must be unique');
  }
  const bundledFiles = sourceFiles.map((path) => {
    const destination = resolve(outputDir, basename(path));
    if (destination !== path) copyFileSync(path, destination);
    return destination;
  });
  const payloads = bundledFiles.map(describeFile);
  const tarballDescription = payloads.find((file) => file.name === basename(tarball));
  if (!tarballDescription) throw new Error('Tarball description missing');
  if (pack.integrity && pack.integrity !== sha512Integrity(tarballDescription.sha512)) {
    throw new Error('npm pack integrity does not match the packed tarball');
  }
  if (pack.shasum && pack.shasum !== tarballDescription.sha1) {
    throw new Error('npm pack shasum does not match the packed tarball');
  }

  const manifest = {
    schemaVersion: RELEASE_BUNDLE_SCHEMA_VERSION,
    source: {
      tag,
      commit: commit.toLowerCase(),
      commitTimestamp: commitTimestamp(root, commit),
    },
    package: {
      name: packedPackage.name,
      version: packedPackage.version,
      nodeEngine: packedPackage.engines?.node ?? null,
    },
    npmPack: {
      filename: pack.filename ?? basename(tarball),
      integrity: pack.integrity ?? sha512Integrity(tarballDescription.sha512),
      shasum: pack.shasum ?? tarballDescription.sha1,
      unpackedSize: pack.unpackedSize ?? null,
      fileCount: Array.isArray(pack.files) ? pack.files.length : null,
    },
    files: Object.fromEntries(payloads.map((file) => [file.name, file])),
    limitations: [
      'This bundle proves the supplied files are internally consistent with the tagged source metadata.',
      'Public registry state and GitHub attestations must be checked separately after publication.',
    ],
  };

  const manifestPath = resolve(outputDir, 'release-bundle.json');
  writeFileSync(manifestPath, stableJson(manifest), { encoding: 'utf8', mode: 0o600 });
  const checksumEntries = [...payloads, describeFile(manifestPath)].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const checksumsPath = resolve(outputDir, 'SHA256SUMS');
  writeFileSync(
    checksumsPath,
    `${checksumEntries.map((file) => `${file.sha256}  ${file.name}`).join('\n')}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );

  console.log(
    stableJson({
      ok: true,
      manifest: manifestPath,
      checksums: checksumsPath,
      package: manifest.package,
      source: manifest.source,
    }).trim(),
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
