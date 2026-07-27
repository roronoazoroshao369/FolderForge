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

const publishArgs = process.argv.slice(2);
if (
  publishArgs.some(
    (arg) =>
      arg === '--ignore-scripts' ||
      arg === '--foreground-scripts=false' ||
      arg === '--ignore-scripts=true',
  )
) {
  console.error('Refusing to publish with lifecycle scripts disabled; release:check must run.');
  process.exit(1);
}

const result = spawnSync(npmCommand, ['publish', ...publishArgs], {
  cwd: root,
  env: {
    ...process.env,
    npm_config_cache: cache,
    NPM_CONFIG_CACHE: cache,
  },
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
