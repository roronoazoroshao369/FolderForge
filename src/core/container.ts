import type { FolderForgeConfig } from '../core/types.js';
import { PolicyEngine } from '../policy/policy-engine.js';
import { AuditLog } from '../audit/audit-log.js';
import { WorkspaceManager } from '../workspace/workspace-manager.js';
import { ProcessManager } from '../managers/process-manager.js';
import { ChildMcpRegistry } from '../adapters/child-mcp/registry.js';
import { DbManager } from '../managers/db-manager.js';

/**
 * Dependency container shared by every tool handler.
 */
export class Container {
  readonly config: FolderForgeConfig;
  readonly policy: PolicyEngine;
  readonly audit: AuditLog;
  readonly workspace: WorkspaceManager;
  readonly processes: ProcessManager;
  readonly adapters: ChildMcpRegistry;
  readonly db: DbManager;
  /**
   * The tool registry. Assigned by `buildRegistry` right after construction so
   * that routing tools (e.g. `workspace_route`) can adjust the active tool set.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registry: any = null;

  constructor(config: FolderForgeConfig) {
    this.config = config;
    this.policy = new PolicyEngine(config);
    this.workspace = new WorkspaceManager(config.workspace.allowedDirectories);
    this.audit = new AuditLog(config.workspace.defaultProject);
    this.processes = new ProcessManager();
    this.adapters = new ChildMcpRegistry(config.adapters);
    this.db = new DbManager();

    // Auto-activate default project if it exists.
    if (config.workspace.defaultProject) {
      try {
        this.workspace.activate(config.workspace.defaultProject);
      } catch {
        // Not fatal; the client can call workspace_activate later.
      }
    }
  }

  projectRoot(): string {
    return this.workspace.projectRoot() ?? this.config.workspace.defaultProject;
  }
}
