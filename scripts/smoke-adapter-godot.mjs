import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = process.cwd();
const packageRoot = resolve(repositoryRoot, 'packages/adapter-godot');
const tempRoot = mkdtempSync(join(tmpdir(), 'folderforge-adapter-godot-'));
let tarball = '';

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

try {
  run('npm', ['run', 'build'], packageRoot);
  const pack = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts'], packageRoot))[0];
  if (!pack?.filename) throw new Error('npm pack did not return a tarball filename');
  tarball = resolve(packageRoot, pack.filename);
  writeFileSync(
    join(tempRoot, 'package.json'),
    `${JSON.stringify({ name: 'adapter-godot-smoke', private: true, type: 'module' }, null, 2)}\n`,
  );
  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
    tempRoot,
  );
  const installedRoot = join(
    tempRoot,
    'node_modules',
    '@folderforge',
    'adapter-godot',
  );
  const installedPackage = JSON.parse(
    readFileSync(join(installedRoot, 'package.json'), 'utf8'),
  );
  const module = await import(
    pathToFileURL(join(installedRoot, 'dist', 'index.js')).href
  );
  const requiredExports = ['GodotCli', 'GodotRuntime'];
  for (const name of requiredExports) {
    if (typeof module[name] !== 'function') {
      throw new Error(`Installed adapter is missing export ${name}`);
    }
  }
  const cli = new module.GodotCli({
    enabled: true,
    godotPath: '__folderforge_missing_godot__',
    editorPort: 6550,
    runtimePort: 9090,
  });
  const version = await cli.version(250);
  if (!version.ok || version.data?.available !== false) {
    throw new Error('GodotCli did not degrade gracefully when the binary was absent');
  }
  console.log(
    JSON.stringify({
      ok: true,
      package: `${installedPackage.name}@${installedPackage.version}`,
      packedFiles: pack.files?.length ?? null,
      exports: requiredExports,
      missingBinaryHandled: true,
    }),
  );
} finally {
  if (tarball) rmSync(tarball, { force: true });
  rmSync(tempRoot, { recursive: true, force: true });
}
