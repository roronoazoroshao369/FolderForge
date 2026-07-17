import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { detectProject, type ProjectInfo } from './project-detector.js';
import { MemoryStore } from './memory-store.js';
import { logger } from '../core/logger.js';

interface Session {
  info: ProjectInfo;
  memory: MemoryStore;
  root: string;
  activatedAt: number;
}

/**
 * Tracks one or more activated projects and which one is "current".
 *
 * Multi-project support: several workspaces can be active at once (keyed by
 * absolute root). `current` points at the workspace that path-less tool calls
 * operate on; switch it with {@link setCurrent}. The single-project API
 * (`activate`, `getActive`, `requireActive`, `projectRoot`, `getMemory`) is
 * preserved and always refers to the current workspace.
 */
export class WorkspaceManager {
  private sessions = new Map<string, Session>();
  private current: string | null = null;

  constructor(private allowedDirectories: string[]) {}

  private assertAllowed(abs: string): void {
    const allowed = this.allowedDirectories.some((directory) => {
      const root = resolve(directory);
      return abs === root || abs.startsWith(`${root}${sep}`);
    });
    if (!allowed) {
      throw new Error(`Project path is not within allowed directories: ${abs}`);
    }
  }

  /**
   * Activate a project and make it the current workspace. If it was already
   * activated, this simply re-selects it as current.
   */
  activate(path: string): ProjectInfo {
    const abs = resolve(path);
    if (!existsSync(abs)) {
      throw new Error(`Project path does not exist: ${abs}`);
    }
    this.assertAllowed(abs);

    let session = this.sessions.get(abs);
    if (!session) {
      session = { info: detectProject(abs), memory: new MemoryStore(abs), root: abs, activatedAt: Date.now() };
      this.sessions.set(abs, session);
      logger.info({ project: session.info.name, root: abs }, 'Workspace activated');
    }
    this.current = abs;
    return session.info;
  }

  /** Switch the current workspace to an already-activated project. */
  setCurrent(path: string): ProjectInfo {
    const abs = resolve(path);
    const session = this.sessions.get(abs);
    if (!session) {
      throw new Error(`Workspace not activated: ${abs}. Call workspace_activate first.`);
    }
    this.current = abs;
    logger.info({ project: session.info.name, root: abs }, 'Current workspace switched');
    return session.info;
  }

  /** Deactivate a workspace. If it was current, current falls back to most recent. */
  deactivate(path: string): boolean {
    const abs = resolve(path);
    const existed = this.sessions.delete(abs);
    if (this.current === abs) {
      const remaining = [...this.sessions.values()].sort((a, b) => b.activatedAt - a.activatedAt);
      this.current = remaining[0]?.root ?? null;
    }
    return existed;
  }

  /** All activated workspaces, with a flag for the current one. */
  list(): Array<ProjectInfo & { root: string; current: boolean }> {
    return [...this.sessions.values()].map((s) => ({
      ...s.info,
      root: s.root,
      current: s.root === this.current,
    }));
  }

  private currentSession(): Session | null {
    return this.current ? this.sessions.get(this.current) ?? null : null;
  }

  getActive(): ProjectInfo | null {
    return this.currentSession()?.info ?? null;
  }

  requireActive(): ProjectInfo {
    const s = this.currentSession();
    if (!s) throw new Error('No active workspace. Call workspace_activate first.');
    return s.info;
  }

  projectRoot(): string | null {
    return this.currentSession()?.info.projectRoot ?? null;
  }

  getMemory(): MemoryStore {
    const s = this.currentSession();
    if (!s) throw new Error('No active workspace memory store.');
    return s.memory;
  }

  /** Memory store for a specific activated workspace (defaults to current). */
  getMemoryFor(path?: string): MemoryStore {
    if (!path) return this.getMemory();
    const s = this.sessions.get(resolve(path));
    if (!s) throw new Error(`Workspace not activated: ${resolve(path)}`);
    return s.memory;
  }
}
