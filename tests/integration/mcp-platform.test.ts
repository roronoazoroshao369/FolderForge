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
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../../src/runtime/config.js';
import { Container } from '../../src/runtime/container.js';
import { createMcpServer } from '../../src/server/mcp-server.js';
import { buildRegistry } from '../../src/tools/index.js';
import { defineTool } from '../../src/tools/registry.js';

const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-mcp-platform-'));
  roots.push(root);
  writeFileSync(join(root, 'hello.txt'), 'MCP task result\n');
  execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: root });
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
        tools: { listChanged: true },
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

      const toolListChanged = new Promise<void>((resolveNotification) => {
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          resolveNotification();
        });
      });
      registry.register(
        defineTool({
          name: 'dynamic_mcp_probe',
          description: 'Proves parent tool-list change propagation.',
          group: 'test',
          mutates: false,
          inputSchema: { type: 'object', properties: {} },
          handler: async () => ({ ok: true, data: { dynamic: true } }),
        }),
      );
      await toolListChanged;
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
        'dynamic_mcp_probe',
      );

      const taskResource = await client.readResource({ uri: 'folderforge://tasks' });
      expect(taskResource.contents[0]?.text).toContain(created.task.taskId);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it('keeps agent-loop ownership, task-correlated events, and idempotent run claims on MCP', async () => {
    const root = project();
    const config = loadConfig({ projectRoot: root });
    config.policy.defaultMode = 'dev';
    config.adapters.serena.enabled = false;
    config.adapters.playwright.enabled = false;
    config.adapters.desktopCommander.enabled = false;
    const container = new Container(config);
    const registry = buildRegistry(container);
    const principal = {
      id: 'agent:codex-mcp-loop',
      role: 'agent' as const,
      authMode: 'stdio' as const,
      oauthClientId: 'codex-client',
      sessionId: 'codex-session',
      taskId: 'codex-task',
    };
    const server = createMcpServer(registry, {
      name: 'folderforge-loop-test',
      version: '0.0.0-test',
      roots: [root],
      principal,
      container,
    });
    const client = new Client(
      { name: 'folderforge-loop-client', version: '1.0.0' },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const created = await client.callTool({
        name: 'agent_loop_create',
        arguments: {
          title: 'MCP-bound loop',
          goal: 'Prove the public agent-loop surface.',
          acceptanceCriteria: ['MCP ownership is enforced'],
        },
      });
      expect(created.isError).not.toBe(true);
      const createdText = created.content.find((entry) => entry.type === 'text');
      const createdPayload = JSON.parse(createdText?.type === 'text' ? createdText.text : '{}') as {
        data?: { id?: string; clientId?: string; sessionId?: string; taskId?: string };
      };
      const loopId = createdPayload.data?.id;
      if (!loopId) throw new Error(`Unexpected agent_loop_create result: ${JSON.stringify(created)}`);
      expect(loopId).toMatch(/^loop_/);
      expect(createdPayload.data).toMatchObject({
        clientId: 'codex-client',
        sessionId: 'codex-session',
        taskId: 'codex-task',
      });

      const eventsResult = await client.callTool({
        name: 'agent_loop_events',
        arguments: { id: loopId },
      });
      expect(eventsResult.isError).not.toBe(true);
      const eventsText = eventsResult.content.find((entry) => entry.type === 'text');
      const eventsPayload = JSON.parse(eventsText?.type === 'text' ? eventsText.text : '{}') as {
        data?: { events?: Array<{ data?: { taskId?: string } }> };
      };
      expect(eventsPayload.data?.events?.length).toBeGreaterThan(0);
      expect(eventsPayload.data?.events?.every((event) => event.data?.taskId === 'codex-task')).toBe(true);

      const firstRun = await client.callTool({
        name: 'agent_loop_run',
        arguments: { id: loopId, idempotencyKey: 'mcp-run-1' },
      });
      expect(firstRun.isError).not.toBe(true);
      const replay = await client.callTool({
        name: 'agent_loop_run',
        arguments: { id: loopId, idempotencyKey: 'mcp-run-1' },
      });
      expect(replay.isError).not.toBe(true);
      const conflicting = await client.callTool({
        name: 'agent_loop_run',
        arguments: { id: loopId, idempotencyKey: 'mcp-run-2' },
      });
      expect(conflicting.isError).toBe(true);
      expect(JSON.stringify(conflicting.content)).toContain('different idempotency key');

      const mismatchedServer = createMcpServer(registry, {
        name: 'folderforge-loop-test-mismatch',
        version: '0.0.0-test',
        principal: { ...principal, taskId: 'different-task' },
        container,
      });
      const mismatchedClient = new Client(
        { name: 'folderforge-loop-mismatch-client', version: '1.0.0' },
        { capabilities: {} },
      );
      const [mismatchedClientTransport, mismatchedServerTransport] = InMemoryTransport.createLinkedPair();
      try {
        await mismatchedServer.connect(mismatchedServerTransport);
        await mismatchedClient.connect(mismatchedClientTransport);
        const denied = await mismatchedClient.callTool({
          name: 'agent_loop_status',
          arguments: { id: loopId },
        });
        expect(denied.isError).toBe(true);
        expect(JSON.stringify(denied.content)).toContain('task binding mismatch');
      } finally {
        await mismatchedClient.close().catch(() => undefined);
        await mismatchedServer.close().catch(() => undefined);
      }
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});
