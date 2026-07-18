import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  commitAfterTag = false,
}: {
  version?: string;
  changelogVersion?: string;
  tagVersion?: string;
  commitAfterTag?: boolean;
} = {}): string {
  const path = mkdtempSync(join(tmpdir(), 'folderforge-release-ref-'));
  temporaryRoots.push(path);
  writeFileSync(join(path, 'package.json'), JSON.stringify({ version }, null, 2));
  writeFileSync(join(path, 'CHANGELOG.md'), `# Changelog\n\n## [${changelogVersion}] - 2026-07-18\n`);
  run('git', ['init'], path);
  run('git', ['config', 'user.name', 'FolderForge Test'], path);
  run('git', ['config', 'user.email', 'folderforge-test@example.invalid'], path);
  run('git', ['add', 'package.json', 'CHANGELOG.md'], path);
  run('git', ['commit', '-m', 'release fixture'], path);
  run('git', ['tag', '-a', `v${tagVersion}`, '-m', `v${tagVersion}`], path);
  if (commitAfterTag) {
    writeFileSync(join(path, 'after-tag.txt'), 'newer commit\n');
    run('git', ['add', 'after-tag.txt'], path);
    run('git', ['commit', '-m', 'commit after tag'], path);
  }
  return path;
}

function verifyRelease(path: string, tag: string) {
  return spawnSync(process.execPath, [verifier, '--root', path, '--tag', tag], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
}

describe('release integrity', () => {
  it('accepts only an exact tag/package/changelog/HEAD match', () => {
    const path = createReleaseRepo();
    const result = verifyRelease(path, 'v2.3.2');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Release ref verified: v2\.3\.2 -> [0-9a-f]{40}/);
  });

  it('rejects a tag that does not match package.json', () => {
    const path = createReleaseRepo({ tagVersion: '2.3.1' });
    const result = verifyRelease(path, 'v2.3.1');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match package.json version 2.3.2');
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

  it('keeps the workflow tag-triggered and wired to the verifier', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(workflow).toMatch(/push:\s*\n\s*tags:\s*\n\s*- 'v\*\.\*\.\*'/);
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('node scripts/verify-release-ref.mjs --tag "${RELEASE_TAG}"');
    expect(workflow).toContain("ref: ${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref }}");
  });
});
