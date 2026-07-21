import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  let root = scriptRoot;
  let tag = '';
  let notesFileRaw = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      root = resolve(argv[index + 1] ?? '');
      index += 1;
    } else if (arg === '--tag') {
      tag = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--notes-file') {
      notesFileRaw = argv[index + 1] ?? '';
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!tag) throw new Error('Missing required --tag vX.Y.Z argument.');
  if (!notesFileRaw) throw new Error('Missing required --notes-file path.');
  return { root, tag, notesFile: resolve(root, notesFileRaw) };
}

function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractReleaseNotes(changelog, version) {
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\](?:\\s.*)?$`, 'm');
  const match = heading.exec(changelog);
  if (!match) return null;

  let bodyStart = match.index + match[0].length;
  if (changelog.startsWith('\r\n', bodyStart)) bodyStart += 2;
  else if (changelog.startsWith('\n', bodyStart)) bodyStart += 1;

  const remainder = changelog.slice(bodyStart);
  const nextHeading = /^## \[/m.exec(remainder);
  const body = remainder.slice(0, nextHeading?.index ?? remainder.length).trim();
  return body;
}

function verify({ root, tag, notesFile }) {
  const semanticTag = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  if (!semanticTag.test(tag)) {
    throw new Error(`Release tag must be a semantic version prefixed with v: ${tag}`);
  }

  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const version = String(packageJson.version ?? '');
  const expectedTag = `v${version}`;
  const errors = [];

  if (packageLock.version !== version || packageLock.packages?.['']?.version !== version) {
    errors.push(
      `package-lock.json version metadata does not match package.json version ${version}`,
    );
  }

  if (tag !== expectedTag) {
    errors.push(`tag ${tag} does not match package.json version ${version} (${expectedTag})`);
  }

  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const releaseNotes = extractReleaseNotes(changelog, version);
  if (releaseNotes === null) {
    errors.push(`CHANGELOG.md is missing a heading for ${version}`);
  } else if (releaseNotes.length === 0) {
    errors.push(`CHANGELOG.md section for ${version} is empty`);
  }

  const worktree = git(root, ['status', '--porcelain', '--untracked-files=all']);
  if (worktree) {
    errors.push(`working tree is not clean:\n${worktree}`);
  }

  const headCommit = git(root, ['rev-parse', 'HEAD']);
  const tagRef = `refs/tags/${tag}`;
  const tagType = git(root, ['cat-file', '-t', tagRef]);
  if (tagType !== 'tag') {
    errors.push(`tag ${tag} must be an annotated tag, received ${tagType}`);
  }
  const tagCommit = git(root, ['rev-list', '-n', '1', tagRef]);
  if (headCommit !== tagCommit) {
    errors.push(`tag ${tag} points to ${tagCommit}, but checked-out HEAD is ${headCommit}`);
  }

  if (errors.length > 0) {
    throw new Error(`Release verification failed:\n- ${errors.join('\n- ')}`);
  }

  writeFileSync(notesFile, `${releaseNotes}\n`, 'utf8');
  console.log(`Release ref verified: ${tag} -> ${headCommit}`);
  console.log(`Canonical release notes written: ${notesFile}`);
}

try {
  verify(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
