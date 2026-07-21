import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyPublishedVersion,
  parseRemoteTags,
} from '../../scripts/release-provenance-lib.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const createBundle = join(root, 'scripts', 'create-release-bundle.mjs');
const verifyBundle = join(root, 'scripts', 'verify-release-bundle.mjs');
const temporaryRoots: string[] = [];

function run(command: string, args: string[], cwd: string) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function mustRun(command: string, args: string[], cwd: string): string {
  const result = run(command, args, cwd);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function createFixture() {
  const path = mkdtempSync(join(tmpdir(), 'folderforge-release-bundle-'));
  temporaryRoots.push(path);
  writeFileSync(
    join(path, 'package.json'),
    JSON.stringify(
      {
        name: '@example/release-fixture',
        version: '1.2.3',
        type: 'module',
        files: ['index.js'],
        engines: { node: '>=22' },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(path, 'index.js'), 'export const value = 123;\n');
  writeFileSync(join(path, 'sbom.json'), '{"bomFormat":"CycloneDX"}\n');
  writeFileSync(join(path, 'release-notes.md'), '### Added\n\n- Fixture.\n');
  mustRun('git', ['init'], path);
  mustRun('git', ['config', 'user.name', 'FolderForge Test'], path);
  mustRun('git', ['config', 'user.email', 'folderforge-test@example.invalid'], path);
  mustRun('git', ['add', '.'], path);
  mustRun('git', ['commit', '-m', 'release fixture'], path);
  mustRun('git', ['tag', '-a', 'v1.2.3', '-m', 'v1.2.3'], path);
  const commit = mustRun('git', ['rev-parse', 'HEAD'], path);
  const packJson = mustRun('npm', ['pack', '--json', '--ignore-scripts'], path);
  writeFileSync(join(path, 'npm-pack.json'), `${packJson}\n`);
  const pack = JSON.parse(packJson)[0];
  return { path, commit, tarball: join(path, pack.filename) };
}

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('release provenance', () => {
  it('parses annotated and lightweight remote tags', () => {
    const tags = parseRemoteTags(
      'aaaa\trefs/tags/v1.0.0\n' +
        'bbbb\trefs/tags/v1.0.0^{}\n' +
        'cccc\trefs/tags/v1.1.0\n',
    );
    expect(tags.get('v1.0.0')).toEqual({
      object: 'aaaa',
      commit: 'bbbb',
      annotated: true,
    });
    expect(tags.get('v1.1.0')).toEqual({
      object: 'cccc',
      commit: 'cccc',
      annotated: false,
    });
  });

  it('classifies public tag conflicts without inferring provenance', () => {
    expect(
      classifyPublishedVersion({
        version: '2.0.0',
        gitHead: 'a'.repeat(40),
        sourceVersion: '2.0.0',
        remoteTag: { commit: 'b'.repeat(40), annotated: true },
        githubRelease: { tag: 'v2.0.0' },
      }),
    ).toEqual({
      status: 'public-tag-conflict',
      reason: expect.stringContaining('not npm gitHead'),
    });
  });

  it('creates and verifies an internally consistent release bundle', () => {
    const fixture = createFixture();
    const bundleDir = join(fixture.path, 'bundle');
    const created = run(
      process.execPath,
      [
        createBundle,
        '--root',
        fixture.path,
        '--tag',
        'v1.2.3',
        '--commit',
        fixture.commit,
        '--tarball',
        fixture.tarball,
        '--sbom',
        join(fixture.path, 'sbom.json'),
        '--notes',
        join(fixture.path, 'release-notes.md'),
        '--pack-json',
        join(fixture.path, 'npm-pack.json'),
        '--output-dir',
        bundleDir,
      ],
      root,
    );
    expect(created.status).toBe(0);
    expect(existsSync(join(bundleDir, 'release-bundle.json'))).toBe(true);
    expect(existsSync(join(bundleDir, 'SHA256SUMS'))).toBe(true);

    const verified = run(
      process.execPath,
      [verifyBundle, '--bundle-dir', bundleDir, '--root', fixture.path],
      root,
    );
    expect(verified.status).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      ok: true,
      package: { name: '@example/release-fixture', version: '1.2.3' },
      localSourceVerified: true,
      registryVerified: false,
    });
  });

  it('detects package-byte tampering', () => {
    const fixture = createFixture();
    const bundleDir = join(fixture.path, 'bundle');
    mustRun(
      process.execPath,
      [
        createBundle,
        '--root',
        fixture.path,
        '--tag',
        'v1.2.3',
        '--commit',
        fixture.commit,
        '--tarball',
        fixture.tarball,
        '--sbom',
        join(fixture.path, 'sbom.json'),
        '--notes',
        join(fixture.path, 'release-notes.md'),
        '--pack-json',
        join(fixture.path, 'npm-pack.json'),
        '--output-dir',
        bundleDir,
      ],
      root,
    );
    const manifest = JSON.parse(readFileSync(join(bundleDir, 'release-bundle.json'), 'utf8'));
    writeFileSync(join(bundleDir, manifest.npmPack.filename), 'tampered');

    const verified = run(
      process.execPath,
      [verifyBundle, '--bundle-dir', bundleDir],
      root,
    );
    expect(verified.status).toBe(1);
    expect(verified.stderr).toMatch(/does not match|fails SHA256SUMS/);
  });

  it('rejects a copied bundle with an unexpected checksum entry', () => {
    const fixture = createFixture();
    const bundleDir = join(fixture.path, 'bundle');
    mustRun(
      process.execPath,
      [
        createBundle,
        '--root',
        fixture.path,
        '--tag',
        'v1.2.3',
        '--commit',
        fixture.commit,
        '--tarball',
        fixture.tarball,
        '--sbom',
        join(fixture.path, 'sbom.json'),
        '--notes',
        join(fixture.path, 'release-notes.md'),
        '--pack-json',
        join(fixture.path, 'npm-pack.json'),
        '--output-dir',
        bundleDir,
      ],
      root,
    );
    const copied = join(fixture.path, 'copied-bundle');
    cpSync(bundleDir, copied, { recursive: true });
    writeFileSync(
      join(copied, 'SHA256SUMS'),
      `${readFileSync(join(copied, 'SHA256SUMS'), 'utf8')}${'0'.repeat(64)}  extra.txt\n`,
    );
    writeFileSync(join(copied, 'extra.txt'), 'unexpected');

    const verified = run(process.execPath, [verifyBundle, '--bundle-dir', copied], root);
    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain('SHA256SUMS contains unexpected files');
  });
});
