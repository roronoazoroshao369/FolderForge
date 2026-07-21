import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const verifier = join(root, 'scripts', 'verify-release-ref.mjs');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function createReleaseRepo({
  version = '2.3.2',
  changelogVersion = version,
  tagVersion = version,
  lockVersion = version,
  commitAfterTag = false,
  emptySection = false,
  lightweightTag = false,
}: {
  version?: string;
  changelogVersion?: string;
  tagVersion?: string;
  lockVersion?: string;
  commitAfterTag?: boolean;
  emptySection?: boolean;
  lightweightTag?: boolean;
} = {}): string {
  const path = mkdtempSync(join(tmpdir(), 'folderforge-release-ref-'));
  temporaryRoots.push(path);
  const section = emptySection
    ? ''
    : '\n### Added\n\n- Canonical first note.\n- Canonical second note.\n';
  writeFileSync(join(path, 'package.json'), JSON.stringify({ version }, null, 2));
  writeFileSync(
    join(path, 'package-lock.json'),
    JSON.stringify(
      {
        name: 'release-fixture',
        version: lockVersion,
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'release-fixture', version: lockVersion } },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(path, 'CHANGELOG.md'),
    `# Changelog\n\n## [Unreleased]\n\n- Future work.\n\n## [${changelogVersion}] - 2026-07-18\n${section}\n## [2.3.1] - 2026-07-17\n\n- Older note.\n`
  );
  run('git', ['init'], path);
  run('git', ['config', 'user.name', 'FolderForge Test'], path);
  run('git', ['config', 'user.email', 'folderforge-test@example.invalid'], path);
  run('git', ['add', 'package.json', 'package-lock.json', 'CHANGELOG.md'], path);
  run('git', ['commit', '-m', 'release fixture'], path);
  run(
    'git',
    lightweightTag
      ? ['tag', `v${tagVersion}`]
      : ['tag', '-a', `v${tagVersion}`, '-m', `v${tagVersion}`],
    path,
  );
  if (commitAfterTag) {
    writeFileSync(join(path, 'after-tag.txt'), 'newer commit\n');
    run('git', ['add', 'after-tag.txt'], path);
    run('git', ['commit', '-m', 'commit after tag'], path);
  }
  return path;
}

function verifyRelease(path: string, tag: string, notesFile = join(path, 'release-notes.md')) {
  return spawnSync(
    process.execPath,
    [verifier, '--root', path, '--tag', tag, '--notes-file', notesFile],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }
  );
}

describe('release integrity', () => {
  it('accepts an exact clean tag/package/changelog/HEAD match and writes canonical notes', () => {
    const path = createReleaseRepo();
    const notesFile = join(path, 'release-notes.md');
    const result = verifyRelease(path, 'v2.3.2', notesFile);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Release ref verified: v2\.3\.2 -> [0-9a-f]{40}/);
    expect(result.stdout).toContain(`Canonical release notes written: ${notesFile}`);
    expect(readFileSync(notesFile, 'utf8')).toBe(
      '### Added\n\n- Canonical first note.\n- Canonical second note.\n'
    );
  });

  it('rejects a tag that does not match package.json without writing notes', () => {
    const path = createReleaseRepo({ tagVersion: '2.3.1' });
    const notesFile = join(path, 'release-notes.md');
    const result = verifyRelease(path, 'v2.3.1', notesFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match package.json version 2.3.2');
    expect(existsSync(notesFile)).toBe(false);
  });

  it('rejects a tag that is not the checked-out HEAD', () => {
    const path = createReleaseRepo({ commitAfterTag: true });
    const result = verifyRelease(path, 'v2.3.2');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('but checked-out HEAD is');
  });

  it('rejects a release without a matching changelog section', () => {
    const path = createReleaseRepo({ changelogVersion: '2.3.1' });
    const result = verifyRelease(path, 'v2.3.2');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CHANGELOG.md is missing a heading for 2.3.2');
  });

  it('rejects an empty matching changelog section', () => {
    const path = createReleaseRepo({ emptySection: true });
    const result = verifyRelease(path, 'v2.3.2');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CHANGELOG.md section for 2.3.2 is empty');
  });

  it('rejects a package-lock version mismatch', () => {
    const path = createReleaseRepo({ lockVersion: '2.3.1' });
    const result = verifyRelease(path, 'v2.3.2');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'package-lock.json version metadata does not match package.json version 2.3.2',
    );
  });

  it('rejects a lightweight release tag', () => {
    const path = createReleaseRepo({ lightweightTag: true });
    const result = verifyRelease(path, 'v2.3.2');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('tag v2.3.2 must be an annotated tag, received commit');
  });

  it('rejects a dirty worktree and leaves the notes path untouched', () => {
    const path = createReleaseRepo();
    const notesFile = join(path, 'release-notes.md');
    writeFileSync(join(path, 'dirty.txt'), 'uncommitted\n');
    const result = verifyRelease(path, 'v2.3.2', notesFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('working tree is not clean');
    expect(result.stderr).toContain('?? dirty.txt');
    expect(existsSync(notesFile)).toBe(false);
  });

  it('requires an explicit notes output path', () => {
    const path = createReleaseRepo();
    const result = spawnSync(process.execPath, [verifier, '--root', path, '--tag', 'v2.3.2'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing required --notes-file path');
  });

  it('keeps the workflow tag-triggered and uses only verified changelog notes', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(workflow).toMatch(/push:\s*\n\s*tags:\s*\n\s*- 'v\*\.\*\.\*'/);
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain(
      'node scripts/verify-release-ref.mjs --tag "${RELEASE_TAG}" --notes-file "${RUNNER_TEMP}/release-notes.md"'
    );
    expect(workflow).toContain("ref: ${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref }}");
    expect(workflow).toContain('--notes-file "${RUNNER_TEMP}/release-notes.md"');
    expect(workflow).not.toContain('--generate-notes');
  });
});
