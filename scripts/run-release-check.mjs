import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const cache = resolve(
  process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE || resolve(root, '.folderforge-ci', 'npm-cache'),
);
mkdirSync(cache, { recursive: true });

const env = {
  ...process.env,
  npm_config_cache: cache,
  NPM_CONFIG_CACHE: cache,
};
const steps = [
  ['run', 'release:preflight'],
  ['run', 'verify'],
  ['run', 'quality:check'],
  ['run', 'docs:check'],
  ['audit', '--omit=dev'],
  ['audit'],
  ['run', 'smoke:package'],
  ['run', 'smoke:stdio'],
  ['run', 'smoke:http'],
  // Re-run the release ref verification after all generators/smokes so a
  // tracked artifact mutation cannot slip into the published tarball.
  ['run', 'release:preflight'],
];

for (const args of steps) {
  console.log(`\n[release:check] npm ${args.join(' ')}`);
  const result = spawnSync(npmCommand, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\nRelease checks passed with isolated npm cache: ${cache}`);
