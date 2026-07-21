import type {
  FolderForgeConfig,
  ToolRoutingRegistry,
} from '../core/types.js';
import { PolicyEngine } from '../policy/policy-engine.js';
import { RateLimiter } from '../policy/rate-limiter.js';
import { AuditLog } from '../audit/audit-log.js';
import { WorkspaceManager } from '../workspace/workspace-manager.js';
import { ProcessManager } from '../managers/process-manager.js';
import { ChildMcpRegistry } from '../adapters/child-mcp/registry.js';
import { DbManager } from '../managers/db-manager.js';
import { LspManager } from '../managers/lsp-manager.js';
import { PatchTransactionManager } from '../managers/patch-transaction-manager.js';
import { PluginManager } from '../plugins/plugin-manager.js';
import { readFolderForgeVersion } from '../core/version.js';
import { registerAdapterRiskMap } from '../adapters/child-mcp/risk-map.js';
import { logger } from '../core/logger.js';
import { WorkflowManager } from '../workflows/workflow-manager.js';
import { ArtifactStore } from '../artifacts/artifact-store.js';
import { DistributedCoordinator } from '../distributed/coordinator.js';
import { MarketplaceManager } from '../marketplace/marketplace-manager.js';
import { BrowserEmulationManager } from '../browser/emulation-manager.js';
import { McpTaskManager } from '../server/mcp-task-manager.js';
import { WorkspaceCapsuleManager } from '../capsule/workspace-capsule-manager.js';
import { WorktreeManager } from '../isolation/worktree-manager.js';
import { ProofPackManager } from '../proof/proof-pack-manager.js';
import { MissionControlState } from '../operator/mission-control.js';
import { VerificationManager } from '../verification/verification-manager.js';

/**
 * Dependency container shared by every tool handler.
 */
export class Container {
  readonly config: FolderForgeConfig;
  readonly policy: PolicyEngine;
  readonly rateLimiter: RateLimiter;
  readonly audit: AuditLog;
  readonly workspace: WorkspaceManager;
  readonly processes: ProcessManager;
  readonly adapters: ChildMcpRegistry;
  readonly db: DbManager;
  readonly lsp: LspManager;
  readonly patchTransactions: PatchTransactionManager;
  readonly plugins: PluginManager;
  readonly workflows: WorkflowManager;
  readonly artifacts: ArtifactStore;
  readonly distributed: DistributedCoordinator;
  readonly marketplace: MarketplaceManager;
  readonly browserEmulation: BrowserEmulationManager;
  readonly mcpTasks: McpTaskManager;
  readonly capsules: WorkspaceCapsuleManager;
  readonly isolation: WorktreeManager;
  readonly proofPacks: ProofPackManager;
  readonly missionControl: MissionControlState;
  readonly verifications: VerificationManager;
  workspaceStartupError: string | null = null;
  /**
   * Narrow routing contract assigned by `buildRegistry` after construction.
   */
  registry: ToolRoutingRegistry | null = null;

  constructor(config: FolderForgeConfig) {
    this.config = config;
    this.policy = new PolicyEngine(config);
    this.missionControl = new MissionControlState(
      config.workspace.defaultProject,
      this.policy,
    );
    this.verifications = new VerificationManager(config.workspace.defaultProject);
    this.rateLimiter = new RateLimiter(config.rateLimit);
    this.workspace = new WorkspaceManager(config.workspace.allowedDirectories);
    this.audit = new AuditLog(config.workspace.defaultProject, config.audit);
    this.isolation = new WorktreeManager(
      config.workspace.allowedDirectories,
      config.workspace.defaultProject,
    );
    this.capsules = new WorkspaceCapsuleManager(
      config.workspace.allowedDirectories,
      config.capsule.enforcement,
      config.capsule.defaultTtlMs,
      config.capsule.maxTtlMs,
      config.workspace.defaultProject,
      (root) => this.isolation.isManagedRoot(root),
      (path) => this.isolation.managedRootForPath(path),
    );
    this.mcpTasks = new McpTaskManager(
      config.workspace.defaultProject,
      (text) => this.policy.secret.redact(text),
      this.audit,
    );
    this.processes = new ProcessManager();
    this.plugins = new PluginManager(config.workspace.defaultProject, readFolderForgeVersion());
    this.workflows = new WorkflowManager(config.workspace.defaultProject);
    this.proofPacks = new ProofPackManager(
      config.workspace.defaultProject,
      (text) => this.policy.secret.redact(text),
    );
    this.artifacts = new ArtifactStore(config.workspace.defaultProject);
    this.marketplace = new MarketplaceManager(
      config.workspace.defaultProject,
      readFolderForgeVersion(),
      this.plugins,
      { secretScan: (text) => this.policy.secret.scan(text) },
    );
    this.distributed = new DistributedCoordinator(config.workspace.defaultProject, {
      artifactExists: (id) => {
        try { this.artifacts.metadata(id); return true; } catch { return false; }
      },
    });
    const pluginAdapters: Array<{
      name: string;
      def: import('../core/types.js').AdapterDef;
    }> = [];
    for (const plugin of this.plugins.list().filter((entry) => entry.enabled)) {
      try {
        const adapter = this.plugins.adapter(plugin.id);
        pluginAdapters.push({ name: adapter.name, def: adapter.def });
        registerAdapterRiskMap(adapter.name, adapter.riskDefault, adapter.riskMap);
      } catch (error) {
        logger.warn({ plugin: plugin.id, error: String(error) }, 'Skipping invalid installed plugin');
      }
    }
    this.adapters = new ChildMcpRegistry(config.adapters, pluginAdapters);
    this.browserEmulation = new BrowserEmulationManager(this.adapters);
    this.db = new DbManager();
    this.lsp = new LspManager(config.lsp);
    this.patchTransactions = new PatchTransactionManager();

    // Auto-activate default project if it exists.
    if (config.workspace.defaultProject) {
      try {
        this.workspace.activate(config.workspace.defaultProject);
      } catch (error) {
        this.workspaceStartupError =
          error instanceof Error ? error.message : String(error);
        logger.warn(
          {
            projectRoot: config.workspace.defaultProject,
            error: this.workspaceStartupError,
          },
          'Default workspace activation failed'
        );
      }
    }
  }

  projectRoot(): string {
    return this.workspace.projectRoot() ?? this.config.workspace.defaultProject;
  }
}
