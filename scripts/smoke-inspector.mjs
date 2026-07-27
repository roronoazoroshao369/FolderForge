import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const sdkPackage = JSON.parse(
  readFileSync(join(root, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), 'utf8'),
);
const project = mkdtempSync(join(tmpdir(), 'folderforge conformance ünicode-'));
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === 'string'),
);
const configPath = join(project, 'folderforge-conformance.json');
let client;
let transport;
let stderr = '';

function requireNamedEntry(values, name, kind) {
  if (!Array.isArray(values) || !values.some((value) => value.name === name)) {
    throw new Error(`MCP ${kind} did not expose ${name}: ${JSON.stringify(values)}`);
  }
}

try {
  writeFileSync(join(project, 'hello ünicode.txt'), 'FolderForge MCP conformance smoke\n');
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
      2,
    ),
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
      FOLDERFORGE_APPROVALS_PATH: join(project, '.folderforge', 'approvals-conformance.jsonl'),
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-65536);
  });

  client = new Client(
    { name: 'folderforge-protocol-conformance', version: packageJson.version },
    { capabilities: {} },
  );
  await client.connect(transport, { timeout: 15_000 });

  const server = client.getServerVersion();
  if (server?.version !== packageJson.version) {
    throw new Error(`Unexpected server version: ${JSON.stringify(server)}`);
  }

  const listed = await client.listTools({}, { timeout: 15_000 });
  requireNamedEntry(listed.tools, 'file_read', 'tools/list');

  const called = await client.callTool(
    { name: 'file_read', arguments: { path: 'hello ünicode.txt' } },
    undefined,
    { timeout: 15_000 },
  );
  if (
    called.isError === true ||
    !JSON.stringify(called).includes('FolderForge MCP conformance smoke')
  ) {
    throw new Error(`MCP tools/call failed: ${JSON.stringify(called)}`);
  }

  const resources = await client.listResources({}, { timeout: 15_000 });
  if (
    !Array.isArray(resources.resources) ||
    !resources.resources.some((resource) => resource.uri === 'folderforge://workspace/status')
  ) {
    throw new Error(`MCP resources/list did not expose workspace status: ${JSON.stringify(resources)}`);
  }
  const workspace = await client.readResource(
    { uri: 'folderforge://workspace/status' },
    { timeout: 15_000 },
  );
  const workspaceContent = workspace.contents?.find(
    (content) =>
      content.uri === 'folderforge://workspace/status' && typeof content.text === 'string',
  );
  const workspaceState = workspaceContent ? JSON.parse(workspaceContent.text) : null;
  const reportedProjectRoot = workspaceState?.current?.projectRoot;
  if (
    workspaceState?.current?.name !== basename(project) ||
    (reportedProjectRoot !== project && reportedProjectRoot !== '[REDACTED]') ||
    workspaceState?.policyMode !== 'readonly'
  ) {
    throw new Error(`MCP resources/read returned unexpected workspace state: ${JSON.stringify(workspace)}`);
  }

  const prompts = await client.listPrompts({}, { timeout: 15_000 });
  requireNamedEntry(prompts.prompts, 'folderforge/deep-implementation-cycle', 'prompts/list');
  const prompt = await client.getPrompt(
    {
      name: 'folderforge/deep-implementation-cycle',
      arguments: { objective: 'verify MCP protocol conformance' },
    },
    { timeout: 15_000 },
  );
  if (!JSON.stringify(prompt).includes('Discover')) {
    throw new Error(`MCP prompts/get returned unexpected content: ${JSON.stringify(prompt)}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        sdkClient: sdkPackage.version,
        serverVersion: server.version,
        transport: 'stdio',
        advertisedTools: listed.tools.length,
        advertisedResources: resources.resources.length,
        advertisedPrompts: prompts.prompts.length,
        methods: [
          'tools/list',
          'tools/call',
          'resources/list',
          'resources/read',
          'prompts/list',
          'prompts/get',
        ],
        toolCall: 'file_read',
        projectHasSpaces: project.includes(' '),
        projectHasUnicode: project.includes('ü'),
      },
      null,
      2,
    ),
  );
} catch (error) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  throw new Error(`${detail}\nFolderForge stderr:\n${stderr}`);
} finally {
  await client?.close().catch(() => undefined);
  await transport?.close().catch(() => undefined);
  rmSync(project, { recursive: true, force: true });
}
