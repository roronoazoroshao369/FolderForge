import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const inspectorCwd = mkdtempSync(join(tmpdir(), 'folderforge-inspector-cwd-'));
const project = mkdtempSync(join(tmpdir(), 'folderforge inspector ünicode-'));
const inspectorCli = join(
  root,
  'node_modules',
  '@modelcontextprotocol',
  'inspector',
  'cli',
  'build',
  'index.js'
);
const configPath = join(project, 'folderforge-inspector.json');
const target = [
  process.execPath,
  join(root, 'dist', 'main.js'),
  '--stdio',
  '--config',
  configPath,
  '--project',
  project,
  '--no-dashboard',
  '--tools-preset',
  'readonly',
];

function invoke(methodArgs) {
  const result = spawnSync(
    process.execPath,
    [inspectorCli, target[0], ...methodArgs, '--', ...target.slice(1)],
    {
      // Inspector 0.21.2 resolves its package identity incorrectly when the
      // caller's parent directory happens to contain a package.json. A separate
      // ASCII-only temp cwd selects the intended metadata path without coupling
      // Inspector's own startup to the Unicode/space project under test.
      cwd: inspectorCwd,
      env: {
        ...process.env,
        FOLDERFORGE_APPROVALS_PATH: join(project, '.folderforge', 'approvals-inspector.jsonl'),
      },
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    }
  );
  if (result.status !== 0) {
    throw new Error(
      `MCP Inspector failed (${methodArgs.join(' ')}):\n${result.stdout ?? ''}\n${result.stderr ?? ''}`
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `MCP Inspector returned non-JSON output: ${String(error)}\n${result.stdout}\n${result.stderr}`
    );
  }
}

try {
  writeFileSync(join(project, 'hello ünicode.txt'), 'FolderForge Inspector conformance smoke\n');
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
        server: { transport: 'stdio', dashboard: { enabled: false } },
      },
      null,
      2
    )
  );

  const listed = invoke(['--method', 'tools/list']);
  if (!Array.isArray(listed.tools) || !listed.tools.some((tool) => tool.name === 'file_read')) {
    throw new Error(`Inspector tools/list did not expose file_read: ${JSON.stringify(listed)}`);
  }

  const called = invoke([
    '--method',
    'tools/call',
    '--tool-name',
    'file_read',
    '--tool-arg',
    'path=hello ünicode.txt',
  ]);
  if (called.isError === true || !JSON.stringify(called).includes('FolderForge Inspector conformance smoke')) {
    throw new Error(`Inspector tools/call failed: ${JSON.stringify(called)}`);
  }

  const resources = invoke(['--method', 'resources/list']);
  if (
    !Array.isArray(resources.resources) ||
    !resources.resources.some((resource) => resource.uri === 'folderforge://workspace/status')
  ) {
    throw new Error(`Inspector resources/list did not expose workspace status: ${JSON.stringify(resources)}`);
  }
  const workspace = invoke([
    '--method',
    'resources/read',
    '--uri',
    'folderforge://workspace/status',
  ]);
  if (!JSON.stringify(workspace).includes(project)) {
    throw new Error(`Inspector resources/read returned unexpected workspace state: ${JSON.stringify(workspace)}`);
  }

  const prompts = invoke(['--method', 'prompts/list']);
  if (
    !Array.isArray(prompts.prompts) ||
    !prompts.prompts.some((prompt) => prompt.name === 'folderforge/deep-implementation-cycle')
  ) {
    throw new Error(`Inspector prompts/list did not expose the implementation prompt: ${JSON.stringify(prompts)}`);
  }
  const prompt = invoke([
    '--method',
    'prompts/get',
    '--prompt-name',
    'folderforge/deep-implementation-cycle',
    '--prompt-args',
    'objective=verify Inspector prompts',
  ]);
  if (!JSON.stringify(prompt).includes('Discover')) {
    throw new Error(`Inspector prompts/get returned unexpected content: ${JSON.stringify(prompt)}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        inspector: '0.21.2',
        transport: 'stdio',
        advertisedTools: listed.tools.length,
        advertisedResources: resources.resources.length,
        advertisedPrompts: prompts.prompts.length,
        methods: ['tools/list', 'tools/call', 'resources/list', 'resources/read', 'prompts/list', 'prompts/get'],
        toolCall: 'file_read',
        projectHasSpaces: project.includes(' '),
        projectHasUnicode: project.includes('ü'),
      },
      null,
      2
    )
  );
} finally {
  rmSync(project, { recursive: true, force: true });
  rmSync(inspectorCwd, { recursive: true, force: true });
}
