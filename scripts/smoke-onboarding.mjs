import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repositoryRoot = process.cwd();
const cli = resolve(repositoryRoot, 'dist/main.js');
const projectRoot = mkdtempSync(join(tmpdir(), 'folderforge-onboarding-smoke-'));

function run(args) {
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
  });
  if (result.status !== 0) {
    throw new Error(
      `folderforge ${args.join(' ')} failed with ${result.status}:\n${result.stderr || result.stdout}`,
    );
  }
  return {
    args,
    elapsedMs: performance.now() - startedAt,
    stdout: result.stdout,
  };
}

async function proveStartupDoesNotWriteConfig() {
  const child = spawn(
    process.execPath,
    [cli, '--stdio', '--project', projectRoot, '--no-dashboard'],
    {
      cwd: repositoryRoot,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
    },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(resolvePromise, 750);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `stdio startup exited before observation (code=${code}, signal=${signal}):\n${stderr}`,
        ),
      );
    });
  });
  const unexpected = [
    join(projectRoot, 'folderforge.yaml'),
    join(projectRoot, '.folderforge.yaml'),
    join(projectRoot, '.folderforge', 'config.yaml'),
  ].filter(existsSync);
  child.kill('SIGTERM');
  await new Promise((resolvePromise) => child.once('exit', resolvePromise));
  if (unexpected.length > 0) {
    throw new Error(`Ordinary startup created configuration: ${unexpected.join(', ')}`);
  }
  return true;
}

try {
  await proveStartupDoesNotWriteConfig();
  const startedAt = performance.now();
  const commands = [
    run(['init', '--project', projectRoot, '--profile', 'develop', '--json']),
    run(['doctor', '--project', projectRoot, '--json']),
    run(['connect', 'cursor', '--project', projectRoot, '--write', '--json']),
  ];
  const elapsedMs = performance.now() - startedAt;
  const configPath = join(projectRoot, '.folderforge', 'config.yaml');
  const clientPath = join(projectRoot, '.cursor', 'mcp.json');
  if (!existsSync(configPath)) throw new Error('init did not create explicit config');
  if (!existsSync(clientPath)) throw new Error('connect did not create Cursor config');
  const client = JSON.parse(readFileSync(clientPath, 'utf8'));
  if (!client.mcpServers?.folderforge) {
    throw new Error('Cursor config is missing the FolderForge server');
  }
  if (commands.length > 3) throw new Error('Onboarding exceeded the three-command target');
  if (elapsedMs >= 300_000) throw new Error('Onboarding exceeded the five-minute target');

  console.log(
    JSON.stringify({
      ok: true,
      startupCreatedConfig: false,
      commands: commands.map((command) => ({
        command: `folderforge ${command.args.join(' ')}`,
        elapsedMs: Number(command.elapsedMs.toFixed(2)),
      })),
      commandCount: commands.length,
      elapsedMs: Number(elapsedMs.toFixed(2)),
      configPath,
      clientPath,
    }),
  );
} finally {
  rmSync(projectRoot, { recursive: true, force: true });
}
