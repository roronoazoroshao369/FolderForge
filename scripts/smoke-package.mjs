import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { commandInvocation } from './command-invocation.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const temp = mkdtempSync(join(tmpdir(), 'folderforge pack ünicode-'));
let tarballPath;

function run(command, args, options = {}) {
  const env = { ...process.env, ...options.env };
  const invocation = commandInvocation(command, args, process.platform, env);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd ?? root,
    env,
    encoding: 'utf8',
    stdio: options.capture === false ? 'inherit' : 'pipe',
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error(
      `${command} ${args.join(' ')} failed with code ${result.status ?? 'unknown'}\n` +
        `${result.stdout ?? ''}\n${result.stderr ?? result.error?.message ?? ''}`
    );
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a temporary TCP port.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
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

  const installedPackageJson = JSON.parse(
    readFileSync(
      join(temp, 'node_modules', '@musashishao', 'folderforge', 'package.json'),
      'utf8'
    )
  );
  if (installedPackageJson.scripts?.postinstall !== undefined) {
    throw new Error('Packed package still declares a postinstall lifecycle script.');
  }

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
  for (const flag of ['doctor', 'setup browser', '--http', '--tools-preset', '--policy']) {
    if (!help.includes(flag)) throw new Error(`CLI help is missing ${flag}.`);
  }

  const setupOutput = run(bin, ['setup', 'browser', '--dry-run', '--json'], { cwd: temp }).stdout;
  const setup = JSON.parse(setupOutput);
  if (
    setup.schemaVersion !== 1 ||
    setup.exitCode !== 0 ||
    setup.browser !== 'chromium' ||
    setup.dryRun !== true ||
    !Array.isArray(setup.args)
  ) {
    throw new Error(`Browser setup dry-run returned an invalid report: ${setupOutput}`);
  }
  if (setup.command !== process.execPath || setup.args.slice(1).join(' ') !== 'install chromium') {
    throw new Error(`Browser setup resolved an unexpected command: ${setupOutput}`);
  }
  const resolvedPlaywrightCli = setup.args[0];
  if (
    typeof resolvedPlaywrightCli !== 'string' ||
    !resolvedPlaywrightCli.includes(`${join('node_modules', 'playwright')}`) ||
    setupOutput.includes('npx')
  ) {
    throw new Error(`Browser setup did not use the installed package-local Playwright CLI: ${setupOutput}`);
  }

  const [httpPort, dashboardPort] = await Promise.all([freePort(), freePort()]);
  writeFileSync(
    join(temp, 'folderforge.yaml'),
    `server:\n  http:\n    host: 127.0.0.1\n    port: ${httpPort}\n  dashboard:\n    host: 127.0.0.1\n    port: ${dashboardPort}\n`
  );
  const doctorOutput = run(bin, ['doctor', '--json', '--project', temp], { cwd: temp }).stdout;
  const doctor = JSON.parse(doctorOutput);
  if (doctor.schemaVersion !== 1 || doctor.exitCode !== 0 || !Array.isArray(doctor.findings)) {
    throw new Error(`Doctor smoke returned an invalid report: ${doctorOutput}`);
  }
  for (const id of ['runtime.node', 'config.discovery', 'playwright.chromium', 'version.consistency']) {
    if (!doctor.findings.some((finding) => finding.id === id)) {
      throw new Error(`Doctor report is missing required finding: ${id}`);
    }
  }
  if (existsSync(join(temp, '.folderforge'))) {
    throw new Error('Doctor created .folderforge state during a read-only package smoke.');
  }

  if (!temp.includes(' ') || !temp.includes('ü')) {
    throw new Error(`Package smoke path did not preserve spaces and Unicode: ${temp}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        package: basename(tarballPath),
        version: packageJson.version,
        files: entry.files.length,
        installedTo: temp,
        pathHasSpaces: temp.includes(' '),
        pathHasUnicode: temp.includes('ü'),
      },
      null,
      2
    )
  );
} finally {
  if (tarballPath) rmSync(tarballPath, { force: true });
  rmSync(temp, { recursive: true, force: true });
}
