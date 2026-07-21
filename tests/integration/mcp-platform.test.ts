import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolResultSchema,
  ErrorCode,
  RELATED_TASK_META_KEY,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { createMcpServer } from '../../src/server/mcp-server.js';
import { buildRegistry } from '../../src/tools/index.js';

const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-mcp-platform-'));
  roots.push(root);
  writeFileSync(join(root, 'hello.txt'), 'MCP task result\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'FolderForge Tests'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('MCP platform protocol', () => {
  it('exposes resources, prompts, and governed task-augmented tools end to end', async () => {
    const root = project();
    const config = loadConfig({ projectRoot: root });
    config.policy.defaultMode = 'dev';
    config.adapters.serena.enabled = false;
    config.adapters.playwright.enabled = false;
    config.adapters.desktopCommander.enabled = false;
    const container = new Container(config);
    const registry = buildRegistry(container);
    const principal = { id: 'agent:mcp-platform-test', role: 'agent' as const, authMode: 'stdio' as const };
    const server = createMcpServer(registry, {
      name: 'folderforge-test',
      version: '0.0.0-test',
      roots: [root],
      principal,
      container,
    });
    const client = new Client(
      { name: 'folderforge-test-client', version: '1.0.0' },
      { capabilities: { tasks: { list: {}, cancel: {} } } },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      expect(client.getServerCapabilities()).toMatchObject({
        resources: { subscribe: true, listChanged: false },
        prompts: { listChanged: false },
        tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
      });

      const resourceList = await client.listResources();
      expect(resourceList.resources.map((resource) => resource.uri)).toEqual(
        expect.arrayContaining([
          'folderforge://workspace/status',
          'folderforge://git/status',
          'folderforge://tasks',
        ]),
      );
      const git = await client.readResource({ uri: 'folderforge://git/status' });
      const gitText = git.contents[0]?.text ?? '';
      expect(JSON.parse(gitText)).toMatchObject({ clean: true, branch: 'master' });

      const promptList = await client.listPrompts();
      expect(promptList.prompts.map((prompt) => prompt.name)).toContain(
        'folderforge/deep-implementation-cycle',
      );
      const prompt = await client.getPrompt({
        name: 'folderforge/deep-implementation-cycle',
        arguments: { objective: 'prove MCP task support', scope: 'tests only' },
      });
      expect(prompt.messages[0]?.content).toMatchObject({
        type: 'text',
        text: expect.stringContaining('Discover → Analyze → Plan'),
      });

      const tools = await client.listTools();
      expect(tools.tools.find((tool) => tool.name === 'file_read')?.execution).toEqual({
        taskSupport: 'optional',
      });

      const messages = [];
      const stream = client.experimental.tasks.callToolStream(
        { name: 'file_read', arguments: { path: 'hello.txt' } },
        CallToolResultSchema,
        { task: { ttl: 60_000 }, timeout: 10_000 },
      );
      for await (const message of stream) messages.push(message);

      const created = messages.find((message) => message.type === 'taskCreated');
      const result = messages.find((message) => message.type === 'result');
      expect(created?.type).toBe('taskCreated');
      expect(result?.type).toBe('result');
      if (created?.type !== 'taskCreated' || result?.type !== 'result') {
        throw new Error(`Unexpected task stream: ${JSON.stringify(messages)}`);
      }
      expect(JSON.stringify(result.result)).toContain('MCP task result');

      const task = await client.experimental.tasks.getTask(created.task.taskId);
      expect(task.status).toBe('completed');
      const listed = await client.experimental.tasks.listTasks();
      expect(listed.tasks.map((entry) => entry.taskId)).toContain(created.task.taskId);
      const fetched = await client.experimental.tasks.getTaskResult(
        created.task.taskId,
        CallToolResultSchema,
      );
      expect(JSON.stringify(fetched)).toContain('MCP task result');
      expect(fetched._meta?.[RELATED_TASK_META_KEY]).toEqual({
        taskId: created.task.taskId,
      });
      await expect(
        client.experimental.tasks.cancelTask(created.task.taskId),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });

      const taskResource = await client.readResource({ uri: 'folderforge://tasks' });
      expect(taskResource.contents[0]?.text).toContain(created.task.taskId);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});
