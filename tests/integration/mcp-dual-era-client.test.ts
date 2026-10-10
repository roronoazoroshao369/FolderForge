import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as LegacyStdioTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client as ModernClient } from '@modelcontextprotocol/client';
import { StdioClientTransport as ModernStdioTransport } from '@modelcontextprotocol/client/stdio';

const fixtureRoots: string[] = [];
const clients: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'g59-mcp-cli-'));
  fixtureRoots.push(dir);
  writeFileSync(join(dir, 'hello.txt'), 'modern and legacy MCP fixture');
  const configPath = join(dir, 'folderforge.json');
  writeFileSync(configPath, JSON.stringify({
    workspace: { defaultProject: dir, allowedDirectories: [dir] },
    policy: { defaultMode: 'readonly' },
    tools: { preset: 'readonly' },
    server: {
      transport: 'stdio',
      mcpProtocol: { mode: 'dual' },
      dashboard: { enabled: false },
    },
    adapters: {
      serena: { enabled: false }, playwright: { enabled: false }, desktopCommander: { enabled: false },
    },
  }));
  const root = resolve(process.cwd());
  return {
    command: process.execPath,
    args: ['--import', 'tsx', join(root, 'src/main.ts'),
      '--stdio', '--config', configPath, '--project', dir, '--no-dashboard', '--tools-preset', 'readonly'],
    cwd: root,
    env: { ...process.env, FOLDERFORGE_APPROVALS_PATH: join(dir, 'approvals.jsonl') } as Record<string, string>,
  };
}

describe('G59 real CLI stdio dual-era client conformance', () => {
  it('serves the official 2026-07-28 client without legacy initialize', async () => {
    const transport = new ModernStdioTransport(fixture());
    const client = new ModernClient(
      { name: 'g59-modern-client', version: '2.3.1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    clients.push(client);
    await client.connect(transport, { timeout: 25_000 });
    const listed = await client.listTools();
    expect(listed.tools.some(t => t.name === 'file_read')).toBe(true);
    const output = await client.callTool({ name: 'file_read', arguments: { path: 'hello.txt' } });
    expect(output.isError).not.toBe(true);
    expect(JSON.stringify(output)).toContain('modern and legacy MCP fixture');
  }, 45_000);

  it('still serves the official legacy SDK v1 client on the same dual config', async () => {
    const transport = new LegacyStdioTransport(fixture());
    const client = new LegacyClient({ name: 'g59-legacy-client', version: '1.32.1' }, { capabilities: {} });
    clients.push(client);
    await client.connect(transport, { timeout: 25_000 });
    const listed = await client.listTools();
    expect(listed.tools.some(t => t.name === 'file_read')).toBe(true);
    const output = await client.callTool({ name: 'file_read', arguments: { path: 'hello.txt' } });
    expect(output.isError).not.toBe(true);
    expect(JSON.stringify(output)).toContain('modern and legacy MCP fixture');
  }, 45_000);
});
