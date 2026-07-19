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
import { readFolderForgeVersion } from './version.js';
import { registerAdapterRiskMap } from '../adapters/child-mcp/risk-map.js';
import { logger } from './logger.js';
import { WorkflowManager } from '../workflows/workflow-manager.js';
import { ArtifactStore } from '../artifacts/artifact-store.js';
/**
 * Dependency container shared by every tool handler.
 */
export class Container {
    config;
    policy;
    rateLimiter;
    audit;
    workspace;
    processes;
    adapters;
    db;
    lsp;
    patchTransactions;
    plugins;
    workflows;
    artifacts;
    workspaceStartupError = null;
    /**
     * The tool registry. Assigned by `buildRegistry` right after construction so
     * that routing tools (e.g. `workspace_route`) can adjust the active tool set.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registry = null;
    constructor(config) {
        this.config = config;
        this.policy = new PolicyEngine(config);
        this.rateLimiter = new RateLimiter(config.rateLimit);
        this.workspace = new WorkspaceManager(config.workspace.allowedDirectories);
        this.audit = new AuditLog(config.workspace.defaultProject);
        this.processes = new ProcessManager();
        this.plugins = new PluginManager(config.workspace.defaultProject, readFolderForgeVersion());
        this.workflows = new WorkflowManager(config.workspace.defaultProject);
        this.artifacts = new ArtifactStore(config.workspace.defaultProject);
        const pluginAdapters = [];
        for (const plugin of this.plugins.list().filter((entry) => entry.enabled)) {
            try {
                const adapter = this.plugins.adapter(plugin.id);
                pluginAdapters.push({ name: adapter.name, def: adapter.def });
                registerAdapterRiskMap(adapter.name, adapter.riskDefault, adapter.riskMap);
            }
            catch (error) {
                logger.warn({ plugin: plugin.id, error: String(error) }, 'Skipping invalid installed plugin');
            }
        }
        this.adapters = new ChildMcpRegistry(config.adapters, pluginAdapters);
        this.db = new DbManager();
        this.lsp = new LspManager(config.lsp);
        this.patchTransactions = new PatchTransactionManager();
        // Auto-activate default project if it exists.
        if (config.workspace.defaultProject) {
            try {
                this.workspace.activate(config.workspace.defaultProject);
            }
            catch (error) {
                this.workspaceStartupError =
                    error instanceof Error ? error.message : String(error);
                logger.warn({
                    projectRoot: config.workspace.defaultProject,
                    error: this.workspaceStartupError,
                }, 'Default workspace activation failed');
            }
        }
    }
    projectRoot() {
        return this.workspace.projectRoot() ?? this.config.workspace.defaultProject;
    }
}
