import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { WorktreeManager } from '../dist/isolation/worktree-manager.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const project = mkdtempSync(join(tmpdir(), 'folderforge stdio ünicode-'));
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === 'string')
);
const configPath = join(project, 'folderforge smoke ü.yaml');
let client;
let transport;
let stderr = '';

try {
  writeFileSync(join(project, 'hello ünicode.txt'), 'FolderForge stdio compatibility smoke\n');
  const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'FolderForge Smoke');
  git('add', 'hello ünicode.txt');
  git('commit', '-m', 'stdio fixture baseline');
  const manager = new WorktreeManager([project], project);
  const isolation = manager.create('stdio-health-contract');
  git('worktree', 'remove', '--force', isolation.worktreeRoot);
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        workspace: { defaultProject: project, allowedDirectories: [project] },
        policy: { defaultMode: 'readonly' },
        tools: { preset: 'readonly' },
        adapters: {
          serena: { enabled: false },
          playwright: { enabled: false },
          desktopCommander: { enabled: false },
        },
        server: {
          transport: 'stdio',
          dashboard: { enabled: false },
        },
      },
      null,
      2
    )
  );

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(root, 'dist', 'main.js'),
      '--stdio',
      '--config',
      configPath,
      '--project',
      project,
      '--no-dashboard',
      '--tools-preset',
      'readonly',
    ],
    cwd: project,
    env: {
      ...inheritedEnv,
      FOLDERFORGE_APPROVALS_PATH: join(project, '.folderforge', 'approvals-stdio-smoke.jsonl'),
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-65536);
  });

  client = new Client(
    { name: 'folderforge-stdio-smoke', version: '1.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport, { timeout: 15_000 });

  const server = client.getServerVersion();
  if (server?.version !== packageJson.version) {
    throw new Error(`Unexpected stdio server version: ${JSON.stringify(server)}`);
  }

  const listed = await client.listTools({}, { timeout: 15_000 });
  if (!Array.isArray(listed.tools) || listed.tools.length === 0) {
    throw new Error('stdio tools/list returned no tools.');
  }
  if (!listed.tools.some((tool) => tool.name === 'file_read')) {
    throw new Error('stdio tools/list did not include file_read.');
  }

  const called = await client.callTool(
    {
      name: 'file_read',
      arguments: { path: 'hello ünicode.txt' },
    },
    undefined,
    { timeout: 15_000 }
  );
  const serialized = JSON.stringify(called);
  if (called.isError === true || !serialized.includes('FolderForge stdio compatibility smoke')) {
    throw new Error(`stdio file_read failed: ${serialized}`);
  }

  // These are MCP calls on the public stdio transport, not direct
  // registry access. A physically missing worktree must stay visible.
  for (const name of ['isolation_list', 'isolation_status', 'isolation_diff']) {
    if (!listed.tools.some((tool) => tool.name === name)) {
      throw new Error('stdio readonly preset did not advertise ' + name);
    }
    const observed = await client.callTool(
      { name, arguments: name === 'isolation_list' ? {} : { id: isolation.id } },
      undefined,
      { timeout: 15_000 }
    );
    const wire = JSON.stringify(observed);
    const expected = name === 'isolation_list' ? 'missing_worktree' : 'ISOLATION_WORKTREE_MISSING';
    if (!wire.includes(expected) || (name === 'isolation_list' && observed.isError)) {
      throw new Error('stdio isolation health mismatch for ' + name + ': ' + wire);
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        version: server.version,
        transport: 'stdio',
        projectHasSpaces: project.includes(' '),
        projectHasUnicode: project.includes('ü'),
        advertisedTools: listed.tools.length,
        toolCall: 'file_read',
        missingIsolationHealth: 'stdio-list-status-diff-verified',
      },
      null,
      2
    )
  );
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  throw new Error(`${message}\nFolderForge stderr:\n${stderr}`);
} finally {
  await client?.close().catch(() => undefined);
  await transport?.close().catch(() => undefined);
  rmSync(project, { recursive: true, force: true });
}
