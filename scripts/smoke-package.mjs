import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const temp = mkdtempSync(join(tmpdir(), 'folderforge-pack-smoke-'));
let tarballPath;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: options.capture === false ? 'inherit' : 'pipe',
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with code ${result.status}\n` +
        `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    );
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

try {
  const packed = run(npm, ['pack', '--json', '--ignore-scripts']);
  const jsonStart = packed.stdout.indexOf('[');
  const jsonEnd = packed.stdout.lastIndexOf(']');
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    throw new Error(`npm pack did not return JSON:\n${packed.stdout}`);
  }
  const packReport = JSON.parse(packed.stdout.slice(jsonStart, jsonEnd + 1));
  const entry = packReport[0];
  if (!entry?.filename || !Array.isArray(entry.files)) {
    throw new Error('npm pack report is missing filename/files metadata.');
  }

  tarballPath = join(root, entry.filename);
  const packagedFiles = new Set(entry.files.map((file) => file.path));
  for (const required of ['package.json', 'README.md', 'LICENSE', 'dist/main.js']) {
    if (!packagedFiles.has(required)) {
      throw new Error(`Packed tarball is missing required file: ${required}`);
    }
  }

  writeFileSync(
    join(temp, 'package.json'),
    JSON.stringify({ name: 'folderforge-package-smoke', version: '0.0.0', private: true }, null, 2)
  );
  run(
    npm,
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath],
    { cwd: temp }
  );

  const bin = join(
    temp,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'folderforge.cmd' : 'folderforge'
  );
  const version = run(bin, ['--version'], { cwd: temp }).stdout.trim();
  const expected = `folderforge ${packageJson.version}`;
  if (version !== expected) {
    throw new Error(`CLI version mismatch: expected "${expected}", got "${version}".`);
  }

  const help = run(bin, ['--help'], { cwd: temp }).stdout;
  for (const flag of ['--http', '--tools-preset', '--policy']) {
    if (!help.includes(flag)) throw new Error(`CLI help is missing ${flag}.`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        package: basename(tarballPath),
        version: packageJson.version,
        files: entry.files.length,
        installedTo: temp,
      },
      null,
      2
    )
  );
} finally {
  if (tarballPath) rmSync(tarballPath, { force: true });
  rmSync(temp, { recursive: true, force: true });
}
