import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  let root = scriptRoot;
  let tag = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      root = resolve(argv[index + 1] ?? '');
      index += 1;
    } else if (arg === '--tag') {
      tag = argv[index + 1] ?? '';
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!tag) throw new Error('Missing required --tag vX.Y.Z argument.');
  return { root, tag };
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

function verify({ root, tag }) {
  const semanticTag = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  if (!semanticTag.test(tag)) {
    throw new Error(`Release tag must be a semantic version prefixed with v: ${tag}`);
  }

  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const version = String(packageJson.version ?? '');
  const expectedTag = `v${version}`;
  const errors = [];

  if (tag !== expectedTag) {
    errors.push(`tag ${tag} does not match package.json version ${version} (${expectedTag})`);
  }

  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\](?:\\s|$)`, 'm');
  if (!heading.test(changelog)) {
    errors.push(`CHANGELOG.md is missing a heading for ${version}`);
  }

  const headCommit = git(root, ['rev-parse', 'HEAD']);
  const tagCommit = git(root, ['rev-list', '-n', '1', `refs/tags/${tag}`]);
  if (headCommit !== tagCommit) {
    errors.push(`tag ${tag} points to ${tagCommit}, but checked-out HEAD is ${headCommit}`);
  }

  if (errors.length > 0) {
    throw new Error(`Release verification failed:\n- ${errors.join('\n- ')}`);
  }

  console.log(`Release ref verified: ${tag} -> ${headCommit}`);
}

try {
  verify(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
