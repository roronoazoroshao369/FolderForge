import { createHash } from 'node:crypto';
import { simpleGit } from 'simple-git';
import type {
  ReadResourceResult,
  Resource,
} from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Container } from '../runtime/container.js';
import type { ToolPrincipal } from '../core/types.js';
import type { McpTaskManager } from './mcp-task-manager.js';

interface ResourceDefinition extends Resource {
  read: () => Promise<unknown> | unknown;
}

function jsonContent(uri: string, value: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: `${JSON.stringify(value, null, 2)}\n`,
      },
    ],
  };
}

export class McpResourceCatalog {
  private readonly definitions = new Map<string, ResourceDefinition>();

  constructor(
    private readonly container: Container,
    private readonly tasks: McpTaskManager,
    private readonly principal: ToolPrincipal,
  ) {
    this.register({
      uri: 'folderforge://workspace/status',
      name: 'workspace-status',
      title: 'Workspace status',
      description: 'Current and activated workspaces, policy mode, and visible tool counts.',
      mimeType: 'application/json',
      annotations: { audience: ['assistant'], priority: 1 },
      read: () => ({
        current: this.container.workspace.getActive(),
        activated: this.container.workspace.list(),
        allowedDirectories: this.container.config.workspace.allowedDirectories,
        policyMode: this.container.policy.getMode(),
        tools: {
          active: this.container.registry?.listAgentActive?.().length ?? 0,
          total: this.container.registry?.listAll?.().length ?? 0,
        },
      }),
    });

    this.register({
      uri: 'folderforge://git/status',
      name: 'git-status',
      title: 'Git status',
      description: 'Branch and bounded working-tree state for the active project.',
      mimeType: 'application/json',
      annotations: { audience: ['assistant'], priority: 0.95 },
      read: async () => {
        const status = await simpleGit({ baseDir: this.container.projectRoot() }).status();
        return {
          branch: status.current,
          tracking: status.tracking,
          ahead: status.ahead,
          behind: status.behind,
          clean: status.isClean(),
          staged: status.staged.slice(0, 200),
          modified: status.modified.slice(0, 200),
          notAdded: status.not_added.slice(0, 200),
          deleted: status.deleted.slice(0, 200),
          conflicted: status.conflicted.slice(0, 200),
          truncated:
            status.staged.length +
              status.modified.length +
              status.not_added.length +
              status.deleted.length +
              status.conflicted.length >
            1000,
        };
      },
    });

    this.register({
      uri: 'folderforge://processes',
      name: 'managed-processes',
      title: 'Managed processes',
      description: 'Current FolderForge-managed local process sessions without process output.',
      mimeType: 'application/json',
      annotations: { audience: ['assistant'], priority: 0.8 },
      read: () => this.container.processes.list().slice(0, 200),
    });

    this.register({
      uri: 'folderforge://workflows',
      name: 'workflow-runs',
      title: 'Workflow runs',
      description: 'Recent governed workflow states and step evidence metadata.',
      mimeType: 'application/json',
      annotations: { audience: ['assistant'], priority: 0.9 },
      read: () => this.container.workflows.list(50),
    });

    this.register({
      uri: 'folderforge://tasks',
      name: 'mcp-tasks',
      title: 'MCP tasks',
      description: 'Tasks owned by the authenticated MCP principal.',
      mimeType: 'application/json',
      annotations: { audience: ['assistant'], priority: 0.9 },
      read: () => this.tasks.snapshot(this.principal),
    });

    this.register({
      uri: 'folderforge://artifacts',
      name: 'artifact-index',
      title: 'Artifact index',
      description: 'Bounded metadata for content-addressed evidence artifacts.',
      mimeType: 'application/json',
      annotations: { audience: ['assistant'], priority: 0.75 },
      read: () => ({
        stats: this.container.artifacts.stats(),
        artifacts: this.container.artifacts.list(100, 0),
      }),
    });
  }

  list(): Resource[] {
    return [...this.definitions.values()].map(({ read: _read, ...resource }) => resource);
  }

  has(uri: string): boolean {
    return this.definitions.has(uri);
  }

  async read(uri: string): Promise<ReadResourceResult> {
    const definition = this.definitions.get(uri);
    if (!definition) throw new Error(`Unknown resource URI: ${uri}`);
    const value = await definition.read();
    return jsonContent(uri, this.sanitize(value));
  }

  private sanitize(value: unknown, key = ''): unknown {
    if (
      typeof value === 'string' &&
      /^(?:id|taskId|sessionId|runId|artifactId|sha256|argsSha256)$/i.test(key)
    ) {
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => this.sanitize(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
          childKey,
          this.sanitize(child, childKey),
        ]),
      );
    }
    return this.container.policy.secret.redactValue(value, key);
  }

  async fingerprint(uri: string): Promise<string> {
    const result = await this.read(uri);
    return createHash('sha256').update(JSON.stringify(result.contents)).digest('hex');
  }

  private register(definition: ResourceDefinition): void {
    if (this.definitions.has(definition.uri)) {
      throw new Error(`Duplicate resource URI: ${definition.uri}`);
    }
    this.definitions.set(definition.uri, definition);
  }
}

export class McpResourceSubscriptions {
  private readonly subscribed = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly server: Server,
    private readonly catalog: McpResourceCatalog,
    private readonly intervalMs = 1000,
  ) {}

  async subscribe(uri: string): Promise<void> {
    if (!this.catalog.has(uri)) throw new Error(`Unknown resource URI: ${uri}`);
    if (this.subscribed.size >= 32 && !this.subscribed.has(uri)) {
      throw new Error('Resource subscription limit reached (32).');
    }
    this.subscribed.set(uri, await this.catalog.fingerprint(uri));
    this.start();
  }

  unsubscribe(uri: string): void {
    this.subscribed.delete(uri);
    if (this.subscribed.size === 0) this.stop();
  }

  dispose(): void {
    this.stop();
    this.subscribed.clear();
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  private stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const [uri, previous] of this.subscribed) {
        try {
          const next = await this.catalog.fingerprint(uri);
          if (next === previous) continue;
          this.subscribed.set(uri, next);
          await this.server.sendResourceUpdated({ uri });
        } catch {
          // A transient resource read failure must not terminate other subscriptions.
        }
      }
    } finally {
      this.polling = false;
    }
  }
}
