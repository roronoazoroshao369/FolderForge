import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { AuditLog } from '../../src/audit/audit-log.js';
import type { ToolPrincipal, ToolResult } from '../../src/core/types.js';
import { McpTaskManager } from '../../src/server/mcp-task-manager.js';
import type { ToolRegistry } from '../../src/tools/registry.js';

const roots: string[] = [];
const owner: ToolPrincipal = { id: 'agent:owner', role: 'agent', authMode: 'stdio' };
const stranger: ToolPrincipal = { id: 'agent:stranger', role: 'agent', authMode: 'stdio' };

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'folderforge-mcp-task-'));
  roots.push(value);
  return value;
}

function registry(
  call: (
    args: Record<string, unknown>,
    signal: AbortSignal,
    reportProgress?: (progress: number, total?: number, message?: string) => Promise<void>,
  ) => Promise<ToolResult>,
): ToolRegistry {
  return {
    get: vi.fn((name: string) =>
      name === 'demo'
        ? {
            name: 'demo',
            description: 'demo',
            audience: 'agent',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' },
          }
        : undefined,
    ),
    callAgent: vi.fn(
      async (
        _name: string,
        args: Record<string, unknown>,
        control: { signal: AbortSignal; reportProgress?: (progress: number, total?: number, message?: string) => Promise<void> },
      ) => call(args, control.signal, control.reportProgress),
    ),
  } as unknown as ToolRegistry;
}

async function terminal(
  manager: McpTaskManager,
  taskId: string,
  principal: ToolPrincipal = owner,
): Promise<ReturnType<McpTaskManager['get']>> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const task = manager.get(taskId, principal);
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Task ${taskId} did not reach a terminal status.`);
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('McpTaskManager', () => {
  it('persists a redacted bounded result and emits lifecycle notifications', async () => {
    const project = root();
    const notifications: string[] = [];
    const manager = new McpTaskManager(
      project,
      (text) => text.replaceAll('secret-token', '[REDACTED]'),
      new AuditLog(project),
    );
    const tools = registry(async (_args, _signal, progress) => {
      await progress?.(1, 2, 'halfway secret-token');
      return { ok: true, data: { value: 'secret-token', done: true } };
    });

    const created = await manager.createToolTask({
      registry: tools,
      principal: owner,
      tool: 'demo',
      args: { apiKey: 'secret-token' },
      notify: async (task) => {
        notifications.push(`${task.status}:${task.statusMessage ?? ''}`);
      },
    });
    const completed = await terminal(manager, created.taskId);
    expect(completed.status).toBe('completed');
    expect(manager.result(created.taskId, owner).result).toEqual({
      ok: true,
      data: { value: '[REDACTED]', done: true },
    });
    expect(notifications.some((entry) => entry.startsWith('working:'))).toBe(true);
    expect(notifications.some((entry) => entry.startsWith('completed:'))).toBe(true);

    const taskFile = join(
      project,
      '.folderforge',
      'mcp-tasks',
      readdirSync(join(project, '.folderforge', 'mcp-tasks'))[0]!,
    );
    const persisted = readFileSync(taskFile, 'utf8');
    expect(persisted).not.toContain('secret-token');
    expect(persisted).toContain('[REDACTED]');
    expect(persisted).toMatch(/"argsSha256": "[a-f0-9]{64}"/);
  });

  it('binds task status, result, and cancellation to the creating principal', async () => {
    const project = root();
    const manager = new McpTaskManager(project, (text) => text, new AuditLog(project));
    const tools = registry(async () => ({ ok: true, data: { ok: true } }));
    const created = await manager.createToolTask({
      registry: tools,
      principal: owner,
      tool: 'demo',
      args: {},
    });
    await terminal(manager, created.taskId);

    expect(() => manager.get(created.taskId, stranger)).toThrow(/not owned/i);
    expect(() => manager.result(created.taskId, stranger)).toThrow(/not owned/i);
    await expect(manager.cancel(created.taskId, stranger)).rejects.toThrow(/not owned/i);
    await expect(manager.cancel(created.taskId, owner)).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
    expect(manager.list(stranger).tasks).toEqual([]);
  });

  it('marks an oversized persisted result as failed instead of completed', async () => {
    const project = root();
    const manager = new McpTaskManager(project, (text) => text, new AuditLog(project));
    const tools = registry(async () => ({ ok: true, data: { payload: 'x'.repeat(1_100_000) } }));
    const created = await manager.createToolTask({
      registry: tools,
      principal: owner,
      tool: 'demo',
      args: {},
    });

    expect(await terminal(manager, created.taskId)).toMatchObject({
      status: 'failed',
      statusMessage: expect.stringMatching(/exceeded/i),
    });
    expect(manager.result(created.taskId, owner).result).toMatchObject({
      ok: false,
      data: { truncated: true },
    });
  });

  it('cancels a running governed call through its AbortSignal', async () => {
    const project = root();
    const manager = new McpTaskManager(project, (text) => text, new AuditLog(project));
    const tools = registry(
      async (_args, signal) =>
        new Promise<ToolResult>((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ ok: false, error: 'handler observed cancellation' }),
            { once: true },
          );
        }),
    );
    const created = await manager.createToolTask({
      registry: tools,
      principal: owner,
      tool: 'demo',
      args: {},
    });

    const cancelled = await manager.cancel(created.taskId, owner);
    expect(cancelled.status).toBe('cancelled');
    expect(manager.result(created.taskId, owner).result).toEqual({
      ok: false,
      error: 'Task cancelled by caller.',
    });
  });

  it('fails active persisted tasks on restart instead of replaying uncertain calls', () => {
    const project = root();
    const directory = join(project, '.folderforge', 'mcp-tasks');
    mkdirSync(directory, { recursive: true });
    const taskId = 'task_restart';
    const now = new Date().toISOString();
    writeFileSync(
      join(directory, `${taskId}.json`),
      JSON.stringify({
        schemaVersion: 1,
        task: {
          taskId,
          status: 'working',
          ttl: 60_000,
          createdAt: now,
          lastUpdatedAt: now,
          pollInterval: 1000,
        },
        ownerId: owner.id,
        tool: 'demo',
        argsSha256: '0'.repeat(64),
        argsSummary: {},
        hasOutputSchema: false,
      }),
    );

    const manager = new McpTaskManager(project, (text) => text, new AuditLog(project));
    expect(manager.get(taskId, owner)).toMatchObject({
      status: 'failed',
      statusMessage: expect.stringMatching(/not replayed/i),
    });
    expect(manager.result(taskId, owner).result.error).toMatch(/does not replay uncertain tool calls/i);
  });
});
