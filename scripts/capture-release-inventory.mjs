import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  RELEASE_INVENTORY_SCHEMA_VERSION,
  classifyPublishedVersion,
  parseRemoteTags,
  stableJson,
} from './release-provenance-lib.mjs';

function parseArgs(argv) {
  let output = '';
  let markdown = '';
  let remote = 'origin';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') output = argv[++index] ?? '';
    else if (arg === '--markdown') markdown = argv[++index] ?? '';
    else if (arg === '--remote') remote = argv[++index] ?? '';
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!output) throw new Error('Missing required --output path');
  if (!markdown) throw new Error('Missing required --markdown path');
  return { output: resolve(output), markdown: resolve(markdown), remote };
}

function execJson(command, args) {
  const raw = execFileSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return raw ? JSON.parse(raw) : null;
}

function localSourceVersion(commit) {
  if (!commit) return null;
  const exists = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], {
    windowsHide: true,
    stdio: 'ignore',
  });
  if (exists.status !== 0) return null;
  const shown = spawnSync('git', ['show', `${commit}:package.json`], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (shown.status !== 0) return null;
  try {
    return String(JSON.parse(shown.stdout).version ?? '') || null;
  } catch {
    return null;
  }
}

async function githubReleases(repository) {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=100`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'folderforge-release-inventory',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub Releases request failed: HTTP ${response.status}`);
  return response.json();
}

function markdownFor(inventory) {
  const statusCounts = Object.create(null);
  for (const item of inventory.versions) {
    statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1;
  }
  const lines = [
    '# Public release provenance inventory',
    '',
    `**Captured:** ${inventory.capturedAt}  `,
    `**Package:** \`${inventory.package.name}\`  `,
    `**Repository:** \`${inventory.repository}\``,
    '',
    'This is a factual snapshot, not a retroactive attestation. npm `gitHead` is a registry claim. A version is not described as cryptographically verified unless its public tag, source version, package bytes, and release evidence align.',
    '',
    '## Summary',
    '',
    `- npm latest: \`${inventory.package.distTags.latest ?? 'none'}\``,
    `- npm next: \`${inventory.package.distTags.next ?? 'none'}\``,
    `- Public npm versions: ${inventory.versions.length}`,
    `- Remote tags: ${inventory.remoteTags.length}`,
    `- GitHub Releases: ${inventory.githubReleases.length}`,
    ...Object.entries(statusCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, count]) => `- ${status}: ${count}`),
    '',
    '## Version inventory',
    '',
    '| Version | Published (UTC) | npm gitHead | Source version | Public tag | GitHub release | Status |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const item of inventory.versions) {
    lines.push(
      `| ${item.version} | ${item.publishedAt ?? 'unknown'} | ${item.gitHead ? `\`${item.gitHead.slice(0, 12)}\`` : 'unknown'} | ${item.sourceVersion ?? 'unknown'} | ${item.remoteTag ? `\`${item.remoteTag.commit.slice(0, 12)}\`` : 'none'} | ${item.githubRelease ? item.githubRelease.tag : 'none'} | **${item.status}** |`,
    );
  }
  lines.push(
    '',
    '## Interpretation',
    '',
    '- `tag-and-release-aligned`: registry commit, source version, remote tag, and GitHub Release align. This still does not prove package-byte identity without a release bundle or attestation.',
    '- `tag-aligned-no-release`: registry commit, source version, and remote tag align, but there is no hosted release.',
    '- `registry-commit-aligned`: npm metadata points to a locally available source commit with the matching version, but no remote tag proves the public mapping.',
    '- `registry-claim-conflict`: npm metadata points to a commit whose source version differs from the published version.',
    '- `public-tag-conflict`: the expected public tag resolves to a different commit than npm `gitHead`.',
    '- `unknown` or `registry-claim-only`: evidence is insufficient; do not infer a source commit.',
    '',
    'The machine-readable snapshot is `docs/release-inventory.json`. Regenerate both files with:',
    '',
    '```bash',
    'npm run release:inventory:capture',
    '```',
    '',
  );
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageJson = execJson('node', ['-p', 'JSON.stringify(require("./package.json"))']);
  const packageName = packageJson.name;
  const repository = String(packageJson.repository?.url ?? '')
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^https:\/\/github\.com\//, '');
  if (!packageName || !repository.includes('/')) throw new Error('Package repository metadata is invalid');

  const npmMetadata = execJson('npm', [
    'view',
    packageName,
    'versions',
    'dist-tags',
    'time',
    '--json',
  ]);
  const versions = Array.isArray(npmMetadata.versions) ? npmMetadata.versions : [];
  const remoteTagRaw = execFileSync('git', ['ls-remote', '--tags', args.remote], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const remoteTags = parseRemoteTags(remoteTagRaw);
  const releasesRaw = await githubReleases(repository);
  const releases = new Map(
    releasesRaw.map((release) => [
      release.tag_name,
      {
        tag: release.tag_name,
        publishedAt: release.published_at,
        immutable: Boolean(release.immutable),
        assets: Array.isArray(release.assets) ? release.assets.map((asset) => asset.name) : [],
      },
    ]),
  );

  const rows = [];
  for (const version of versions) {
    const metadata = execJson('npm', [
      'view',
      `${packageName}@${version}`,
      'gitHead',
      'dist.integrity',
      'dist.shasum',
      '--json',
    ]) ?? {};
    const gitHead = metadata.gitHead ?? null;
    const sourceVersion = localSourceVersion(gitHead);
    const remoteTag = remoteTags.get(`v${version}`) ?? null;
    const githubRelease = releases.get(`v${version}`) ?? null;
    const classification = classifyPublishedVersion({
      version,
      gitHead,
      sourceVersion,
      remoteTag,
      githubRelease,
    });
    rows.push({
      version,
      publishedAt: npmMetadata.time?.[version] ?? null,
      gitHead,
      sourceVersion,
      distIntegrity: metadata['dist.integrity'] ?? null,
      distShasum: metadata['dist.shasum'] ?? null,
      remoteTag,
      githubRelease,
      ...classification,
    });
  }

  const inventory = {
    schemaVersion: RELEASE_INVENTORY_SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    repository,
    package: {
      name: packageName,
      sourceVersion: packageJson.version,
      distTags: npmMetadata['dist-tags'] ?? {},
    },
    remoteTags: [...remoteTags].map(([tag, value]) => ({ tag, ...value })),
    githubReleases: [...releases.values()],
    versions: rows,
    limitations: [
      'npm gitHead is registry metadata and is not a cryptographic attestation.',
      'Historical packages without an aligned public tag and release bundle remain unverified.',
      'This snapshot does not mutate, recreate, or retag historical releases.',
    ],
  };

  mkdirSync(dirname(args.output), { recursive: true });
  mkdirSync(dirname(args.markdown), { recursive: true });
  writeFileSync(args.output, stableJson(inventory), { encoding: 'utf8', mode: 0o600 });
  writeFileSync(args.markdown, `${markdownFor(inventory)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(stableJson({ ok: true, output: args.output, markdown: args.markdown, versions: rows.length }).trim());
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
