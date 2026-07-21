import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ErrorCode, McpError, type Task } from '@modelcontextprotocol/sdk/types.js';
import type {
  ToolCallControl,
  ToolDefinition,
  ToolPrincipal,
  ToolResult,
} from '../core/types.js';
import type { AuditLog } from '../audit/audit-log.js';
import { FileRecordStore } from '../evidence/file-stores.js';
import type { RecordStore } from '../evidence/ports.js';

const SCHEMA_VERSION = 1;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 1000;
const MIN_POLL_MS = 250;
const MAX_POLL_MS = 5000;
const MAX_TASKS = 1000;
const PAGE_SIZE = 50;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_STATUS_MESSAGE = 1000;

interface PersistedTaskRecord {
  schemaVersion: 1;
  task: Task;
  ownerId: string;
  tool: string;
  argsSha256: string;
  argsSummary: unknown;
  hasOutputSchema: boolean;
  result?: ToolResult;
}

export interface TaskToolExecutor {
  get(name: string): ToolDefinition | undefined;
  callAgent(
    name: string,
    args: Record<string, unknown>,
    control?: ToolCallControl,
  ): Promise<ToolResult>;
}

export interface CreateToolTaskOptions {
  registry: TaskToolExecutor;
  principal: ToolPrincipal;
  tool: string;
  args: Record<string, unknown>;
  ttl?: number;
  pollInterval?: number;
  notify?: (task: Task) => Promise<void>;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isTerminal(status: Task['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export class McpTaskManager {
  private readonly directory: string;
  private readonly store: RecordStore<PersistedTaskRecord>;
  private readonly records = new Map<string, PersistedTaskRecord>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    projectRoot: string,
    private readonly redact: (text: string) => string,
    private readonly audit: AuditLog,
    store?: RecordStore<PersistedTaskRecord>,
  ) {
    this.directory = join(projectRoot, '.folderforge', 'mcp-tasks');
    this.store =
      store ?? new FileRecordStore(this.directory, validateTaskRecord);
    this.load();
  }

  async createToolTask(options: CreateToolTaskOptions): Promise<Task> {
    this.cleanupExpired();
    if (this.records.size >= MAX_TASKS) {
      throw new Error(`MCP task limit reached (${MAX_TASKS}); remove or wait for expired tasks.`);
    }
    const definition = options.registry.get(options.tool);
    if (!definition || definition.audience !== 'agent') {
      throw new Error(`Unknown or unavailable agent tool: ${options.tool}`);
    }

    const now = new Date().toISOString();
    const ttl = clamp(options.ttl, DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS);
    const pollInterval = clamp(
      options.pollInterval,
      DEFAULT_POLL_MS,
      MIN_POLL_MS,
      MAX_POLL_MS,
    );
    const task: Task = {
      taskId: `task_${randomUUID()}`,
      status: 'working',
      ttl,
      createdAt: now,
      lastUpdatedAt: now,
      pollInterval,
      statusMessage: `Queued ${options.tool}`,
    };
    const argsSummary = this.redactJson(options.args);
    const argsText = stable(argsSummary);
    const record: PersistedTaskRecord = {
      schemaVersion: SCHEMA_VERSION,
      task,
      ownerId: options.principal.id,
      tool: options.tool,
      argsSha256: createHash('sha256').update(argsText).digest('hex'),
      argsSummary,
      hasOutputSchema: Boolean(definition.outputSchema),
    };
    this.persist(record);
    this.records.set(task.taskId, record);
    this.audit.record({
      type: 'task_event',
      tool: options.tool,
      summary: `created ${task.taskId}`,
      detail: { taskId: task.taskId, ownerId: options.principal.id, argsSha256: record.argsSha256 },
    });

    const controller = new AbortController();
    this.controllers.set(task.taskId, controller);
    void this.execute(record, options, controller);
    return { ...task };
  }

  get(taskId: string, principal: ToolPrincipal): Task {
    this.cleanupExpired();
    const record = this.requireOwned(taskId, principal);
    return { ...record.task };
  }

  list(principal: ToolPrincipal, cursor?: string): { tasks: Task[]; nextCursor?: string } {
    this.cleanupExpired();
    const records = [...this.records.values()]
      .filter((record) => principal.role === 'admin' || record.ownerId === principal.id)
      .sort((a, b) => b.task.createdAt.localeCompare(a.task.createdAt));
    let start = 0;
    if (cursor) {
      const index = records.findIndex((record) => record.task.taskId === cursor);
      if (index < 0) throw new Error(`Invalid task cursor: ${cursor}`);
      start = index + 1;
    }
    const page = records.slice(start, start + PAGE_SIZE);
    const nextCursor = start + PAGE_SIZE < records.length ? page.at(-1)?.task.taskId : undefined;
    return {
      tasks: page.map((record) => ({ ...record.task })),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  result(taskId: string, principal: ToolPrincipal): { result: ToolResult; hasOutputSchema: boolean } {
    this.cleanupExpired();
    const record = this.requireOwned(taskId, principal);
    if (!isTerminal(record.task.status)) {
      throw new Error(`Task ${taskId} is not complete (status=${record.task.status}).`);
    }
    if (!record.result) throw new Error(`Task ${taskId} has no stored result.`);
    return { result: record.result, hasOutputSchema: record.hasOutputSchema };
  }

  async cancel(
    taskId: string,
    principal: ToolPrincipal,
    notify?: (task: Task) => Promise<void>,
  ): Promise<Task> {
    const record = this.requireOwned(taskId, principal);
    if (isTerminal(record.task.status)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Cannot cancel task in terminal status: ${record.task.status}`,
      );
    }
    this.controllers.get(taskId)?.abort(new Error('MCP task cancelled'));
    record.task.status = 'cancelled';
    record.task.statusMessage = 'Cancelled by caller';
    record.task.lastUpdatedAt = new Date().toISOString();
    record.result = { ok: false, error: 'Task cancelled by caller.' };
    this.persist(record);
    this.audit.record({
      type: 'task_event',
      tool: record.tool,
      ok: false,
      summary: `cancelled ${taskId}`,
      detail: { taskId, ownerId: record.ownerId },
    });
    await this.safeNotify(notify, record.task);
    return { ...record.task };
  }

  snapshot(principal: ToolPrincipal): Array<Record<string, unknown>> {
    return this.list(principal).tasks.map((task) => ({ ...task }));
  }

  private async execute(
    record: PersistedTaskRecord,
    options: CreateToolTaskOptions,
    controller: AbortController,
  ): Promise<void> {
    let lastProgressWrite = 0;
    try {
      record.task.statusMessage = `Running ${record.tool}`;
      record.task.lastUpdatedAt = new Date().toISOString();
      this.persist(record);
      await this.safeNotify(options.notify, record.task);
      const result = await options.registry.callAgent(record.tool, options.args, {
        principal: options.principal,
        signal: controller.signal,
        reportProgress: async (progress, total, message) => {
          if (isTerminal(record.task.status)) return;
          const now = Date.now();
          record.task.statusMessage = this.redact(
            `${record.tool}: ${message ?? 'working'} (${progress}${total === undefined ? '' : `/${total}`})`,
          ).slice(0, MAX_STATUS_MESSAGE);
          record.task.lastUpdatedAt = new Date(now).toISOString();
          if (now - lastProgressWrite >= 250) {
            lastProgressWrite = now;
            this.persist(record);
            await this.safeNotify(options.notify, record.task);
          }
        },
      });

      if (record.task.status === 'cancelled') return;
      const storedResult = this.boundResult(result);
      record.result = storedResult;
      record.task.status = storedResult.ok ? 'completed' : 'failed';
      record.task.statusMessage = this.redact(
        storedResult.ok
          ? `Completed ${record.tool}`
          : storedResult.error ?? `Failed ${record.tool}`,
      ).slice(0, MAX_STATUS_MESSAGE);
      record.task.lastUpdatedAt = new Date().toISOString();
      this.persist(record);
      this.audit.record({
        type: 'task_event',
        tool: record.tool,
        ok: storedResult.ok,
        summary: `${record.task.status} ${record.task.taskId}`,
        detail: { taskId: record.task.taskId, ownerId: record.ownerId },
      });
      await this.safeNotify(options.notify, record.task);
    } catch (error) {
      if (record.task.status === 'cancelled') return;
      const message = this.redact(error instanceof Error ? error.message : String(error));
      record.result = { ok: false, error: message.slice(0, MAX_STATUS_MESSAGE) };
      record.task.status = controller.signal.aborted ? 'cancelled' : 'failed';
      record.task.statusMessage = message.slice(0, MAX_STATUS_MESSAGE);
      record.task.lastUpdatedAt = new Date().toISOString();
      this.persist(record);
      this.audit.record({
        type: 'task_event',
        tool: record.tool,
        ok: false,
        summary: `${record.task.status} ${record.task.taskId}`,
        detail: { taskId: record.task.taskId, ownerId: record.ownerId },
      });
      await this.safeNotify(options.notify, record.task);
    } finally {
      this.controllers.delete(record.task.taskId);
    }
  }

  private boundResult(result: ToolResult): ToolResult {
    const redacted = this.redactJson(result) as ToolResult;
    const bytes = Buffer.byteLength(JSON.stringify(redacted));
    if (bytes <= MAX_RESULT_BYTES) return redacted;
    return {
      ok: false,
      error: `Task result exceeded ${MAX_RESULT_BYTES} bytes after redaction and was not persisted.`,
      data: { truncated: true, originalBytes: bytes },
    };
  }

  private redactJson(value: unknown): unknown {
    let text: string;
    try {
      text = JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
    const redacted = this.redact(text);
    try {
      return JSON.parse(redacted);
    } catch {
      return redacted;
    }
  }

  private requireOwned(taskId: string, principal: ToolPrincipal): PersistedTaskRecord {
    const record = this.records.get(taskId);
    if (!record) throw new Error(`Task not found: ${taskId}`);
    if (principal.role !== 'admin' && record.ownerId !== principal.id) {
      throw new Error(`Task ${taskId} is not owned by principal ${principal.id}.`);
    }
    return record;
  }

  private async safeNotify(
    notify: ((task: Task) => Promise<void>) | undefined,
    task: Task,
  ): Promise<void> {
    if (!notify) return;
    try {
      await notify({ ...task });
    } catch {
      // Tasks are durable and may outlive the connection that created them.
    }
  }

  private load(): void {
    for (const record of this.store.load()) {
      if (record.task.status === 'working' || record.task.status === 'input_required') {
        record.task.status = 'failed';
        record.task.statusMessage = 'Server restarted; task was not replayed.';
        record.task.lastUpdatedAt = new Date().toISOString();
        record.result = {
          ok: false,
          error: 'Server restarted while the task was active. FolderForge does not replay uncertain tool calls.',
        };
        this.persist(record);
      }
      this.records.set(record.task.taskId, record);
    }
    this.cleanupExpired();
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [taskId, record] of this.records) {
      if (record.task.ttl === null) continue;
      const updated = Date.parse(record.task.lastUpdatedAt);
      if (!Number.isFinite(updated) || updated + record.task.ttl > now) continue;
      this.controllers.get(taskId)?.abort(new Error('MCP task expired'));
      this.controllers.delete(taskId);
      this.records.delete(taskId);
      this.store.delete(taskId);
    }
  }

  private persist(record: PersistedTaskRecord): void {
    this.store.write(record.task.taskId, record);
  }
}

function validateTaskRecord(value: unknown, location: string): PersistedTaskRecord {
  if (!value || typeof value !== 'object') {
    throw new Error(`${location} is not an MCP task record.`);
  }
  const record = value as Partial<PersistedTaskRecord>;
  if (
    record.schemaVersion !== SCHEMA_VERSION ||
    !record.task ||
    typeof record.task.taskId !== 'string' ||
    typeof record.ownerId !== 'string' ||
    typeof record.tool !== 'string' ||
    typeof record.argsSha256 !== 'string' ||
    typeof record.hasOutputSchema !== 'boolean'
  ) {
    throw new Error(`${location} does not match the MCP task record schema.`);
  }
  return record as PersistedTaskRecord;
}
