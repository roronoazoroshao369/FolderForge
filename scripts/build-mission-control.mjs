/**
 * Builds the Mission Control SPA (packages/mission-control) when its
 * dependencies are installed. Skips cleanly otherwise so `npm run build`
 * stays self-contained; CI/release workflows install the package first so
 * the published npm tarball ships the built assets.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'packages', 'mission-control');

if (!existsSync(join(pkg, 'node_modules'))) {
  console.log('[mission-control] skipped (install deps: npm --prefix packages/mission-control install)');
  process.exit(0);
}

const result = spawnSync('npm', ['run', 'build'], {
  cwd: pkg,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
