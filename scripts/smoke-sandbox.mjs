import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const image = String(process.env.FOLDERFORGE_SANDBOX_IMAGE ?? '').trim();
if (!/@sha256:[a-f0-9]{64}$/i.test(image)) {
  throw new Error('FOLDERFORGE_SANDBOX_IMAGE must name an already-local image@sha256:<digest>.');
}

const project = mkdtempSync(join(tmpdir(), 'folderforge sandbox ünicode-'));
const configPath = join(project, 'sandbox-smoke.json');
const fixtureDir = join(root, 'tests', 'fixtures');
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === 'string')
);
let client;
let transport;
let stderr = '';

try {
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        workspace: { defaultProject: project, allowedDirectories: [project] },
        policy: { defaultMode: 'dev' },
        tools: { preset: 'full' },
        adapters: {
          serena: {
            enabled: true,
            command: 'python',
            args: [],
            env: { SANDBOX_ALLOWED: 'visible-inside-container' },
            inheritEnv: false,
            sandbox: {
              mode: 'docker',
              image,
              command: 'python',
              args: ['/plugin/sandbox-mcp-server.py'],
              workdir: '/plugin',
              network: 'none',
              mounts: [{ source: fixtureDir, target: '/plugin', mode: 'ro' }],
              readOnlyRoot: true,
              memoryMb: 256,
              cpus: 0.5,
              pidsLimit: 64,
              tmpfsMb: 32,
            },
          },
          playwright: { enabled: false },
          desktopCommander: { enabled: false },
        },
        server: { transport: 'stdio', dashboard: { enabled: false } },
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
      'full',
    ],
    cwd: project,
    env: {
      ...inheritedEnv,
      SANDBOX_UNDECLARED_SECRET: 'must-not-cross-container-boundary',
      FOLDERFORGE_APPROVALS_PATH: join(project, '.folderforge', 'approvals-sandbox-smoke.jsonl'),
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-65536);
  });

  client = new Client(
    { name: 'folderforge-sandbox-smoke', version: '1.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport, { timeout: 30_000 });

  const listed = await client.listTools({}, { timeout: 30_000 });
  if (!listed.tools.some((tool) => tool.name === 'serena__inspect_boundary')) {
    throw new Error(`Sandboxed child tool was not advertised: ${JSON.stringify(listed.tools.map((tool) => tool.name))}`);
  }

  const called = await client.callTool(
    { name: 'serena__inspect_boundary', arguments: {} },
    undefined,
    { timeout: 30_000 }
  );
  if (called.isError === true) throw new Error(`Sandboxed child call failed: ${JSON.stringify(called)}`);
  const serialized = JSON.stringify(called);
  let evidence;
  for (const block of called.content ?? []) {
    if (block.type !== 'text') continue;
    try {
      const parsed = JSON.parse(block.text);
      if (parsed && typeof parsed === 'object' && 'undeclaredSecretVisible' in parsed) {
        evidence = parsed;
        break;
      }
    } catch {
      // Compatibility summary blocks are not the child evidence.
    }
  }
  if (!evidence || evidence.allowedEnv !== 'visible-inside-container') {
    throw new Error(`Declared environment value was unavailable: ${serialized}`);
  }
  if (evidence.undeclaredSecretVisible !== false) {
    throw new Error(`Undeclared host secret crossed the container boundary: ${serialized}`);
  }
  if (evidence.cwd !== '/plugin') {
    throw new Error(`Container workdir/mount evidence was unexpected: ${serialized}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        runtime: 'docker',
        image,
        tool: 'serena__inspect_boundary',
        network: 'none',
        readOnlyRoot: true,
        pluginMount: 'read-only',
        resourceBounds: { memoryMb: 256, cpus: 0.5, pidsLimit: 64, tmpfsMb: 32 },
        declaredEnvVisible: true,
        undeclaredSecretVisible: false,
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
