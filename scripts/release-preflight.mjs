import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateReleaseMetadata } from './release-preflight-lib.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

function git(args, { optional = false } = {}) {
  const result = run('git', args);
  if (result.status !== 0) {
    if (optional) return null;
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function fail(errors) {
  throw new Error(`Release preflight failed:\n- ${errors.join('\n- ')}`);
}

try {
  const fetched = run('git', ['fetch', '--prune', 'origin', 'main']);
  if (fetched.status !== 0) {
    const detail = (fetched.stderr || fetched.stdout || '').trim();
    throw new Error(
      `Could not refresh origin/main before release verification${detail ? `: ${detail}` : ''}`,
    );
  }

  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const metadata = validateReleaseMetadata(packageJson, packageLock);
  const errors = [...metadata.errors];

  const head = git(['rev-parse', 'HEAD']);
  const originMain = git(['rev-parse', '--verify', 'refs/remotes/origin/main'], { optional: true });
  if (!originMain) {
    errors.push('origin/main is unavailable; fetch the canonical GitHub remote before publishing.');
  } else if (head !== originMain) {
    errors.push(`checked-out HEAD ${head} is not synchronized with origin/main ${originMain}.`);
  }

  if (errors.length > 0) fail(errors);

  const evidenceDir = resolve(root, '.folderforge-ci', 'release-preflight');
  mkdirSync(evidenceDir, { recursive: true });
  const notesFile = join(evidenceDir, `release-notes-${metadata.version}.md`);
  const verifier = join(root, 'scripts', 'verify-release-ref.mjs');
  const verified = run(process.execPath, [
    verifier,
    '--root',
    root,
    '--tag',
    `v${metadata.version}`,
    '--notes-file',
    notesFile,
  ]);
  if (verified.status !== 0) {
    const detail = (verified.stderr || verified.stdout || '').trim();
    throw new Error(detail || 'Release reference verification failed.');
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        version: metadata.version,
        tag: `v${metadata.version}`,
        commit: head,
        originMain,
        tarMinimum: metadata.safeTarVersion,
        tarLocked: packageLock.packages['node_modules/tar'].version,
        notesFile,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
