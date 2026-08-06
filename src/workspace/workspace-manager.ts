import { existsSync } from 'node:fs';
import { detectProject, type ProjectInfo } from './project-detector.js';
import { MemoryStore } from './memory-store.js';
import { logger } from '../core/logger.js';
import {
  canonicalCandidatePath,
  canonicalExistingPath,
  displayPath,
  isPathWithin,
  samePath,
} from '../core/path-identity.js';

interface Session {
  info: ProjectInfo;
  memory: MemoryStore;
  /** First lexical absolute path supplied by the operator; safe for display only. */
  displayRoot: string;
  /** Canonical existing filesystem identity used as the session key. */
  identityRoot: string;
  activatedAt: number;
}

/**
 * Tracks one or more activated projects and which one is "current".
 *
 * Multi-project support: several workspaces can be active at once, keyed by
 * canonical filesystem identity. Public roots preserve the first lexical path
 * supplied by the operator; display paths are never used for authorization.
 */
export class WorkspaceManager {
  private sessions = new Map<string, Session>();
  private current: string | null = null;
  private readonly allowedIdentities: string[];

  constructor(allowedDirectories: string[]) {
    this.allowedIdentities = allowedDirectories.map((directory) =>
      canonicalCandidatePath(directory),
    );
  }

  private assertAllowed(identityRoot: string): void {
    const allowed = this.allowedIdentities.some((root) => isPathWithin(root, identityRoot));
    if (!allowed) {
      throw new Error(`Project path is not within allowed directories: ${identityRoot}`);
    }
  }

  private sessionFor(path: string): Session | undefined {
    const displayRoot = displayPath(path);
    try {
      return this.sessions.get(canonicalExistingPath(displayRoot));
    } catch {
      return [...this.sessions.values()].find((session) =>
        samePath(session.displayRoot, displayRoot),
      );
    }
  }

  /**
   * Activate a project and make it the current workspace. If the same
   * filesystem identity was already activated through another alias, this
   * simply re-selects the existing session and preserves its first display path.
   */
  activate(path: string): ProjectInfo {
    const rootForDisplay = displayPath(path);
    if (!existsSync(rootForDisplay)) {
      throw new Error(`Project path does not exist: ${rootForDisplay}`);
    }
    const identityRoot = canonicalExistingPath(rootForDisplay);
    this.assertAllowed(identityRoot);

    let session = this.sessions.get(identityRoot);
    if (!session) {
      session = {
        info: detectProject(rootForDisplay),
        memory: new MemoryStore(identityRoot),
        displayRoot: rootForDisplay,
        identityRoot,
        activatedAt: Date.now(),
      };
      this.sessions.set(identityRoot, session);
      logger.info(
        { project: session.info.name, root: session.displayRoot, workspaceIdentity: identityRoot },
        'Workspace activated',
      );
    }
    this.current = identityRoot;
    return session.info;
  }

  /** Switch the current workspace to an already-activated project. */
  setCurrent(path: string): ProjectInfo {
    const session = this.sessionFor(path);
    if (!session) {
      throw new Error(`Workspace not activated: ${displayPath(path)}. Call workspace_activate first.`);
    }
    this.current = session.identityRoot;
    logger.info(
      { project: session.info.name, root: session.displayRoot, workspaceIdentity: session.identityRoot },
      'Current workspace switched',
    );
    return session.info;
  }

  /** Deactivate a workspace. If it was current, current falls back to most recent. */
  deactivate(path: string): boolean {
    const session = this.sessionFor(path);
    if (!session) return false;
    const existed = this.sessions.delete(session.identityRoot);
    if (this.current === session.identityRoot) {
      const remaining = [...this.sessions.values()].sort((a, b) => b.activatedAt - a.activatedAt);
      this.current = remaining[0]?.identityRoot ?? null;
    }
    return existed;
  }

  /** All activated workspaces, with a flag for the current one. */
  list(): Array<ProjectInfo & { root: string; current: boolean }> {
    return [...this.sessions.values()].map((session) => ({
      ...session.info,
      root: session.displayRoot,
      current: session.identityRoot === this.current,
    }));
  }

  private currentSession(): Session | null {
    return this.current ? this.sessions.get(this.current) ?? null : null;
  }

  getActive(): ProjectInfo | null {
    return this.currentSession()?.info ?? null;
  }

  requireActive(): ProjectInfo {
    const session = this.currentSession();
    if (!session) throw new Error('No active workspace. Call workspace_activate first.');
    return session.info;
  }

  projectRoot(): string | null {
    return this.currentSession()?.displayRoot ?? null;
  }

  getMemory(): MemoryStore {
    const session = this.currentSession();
    if (!session) throw new Error('No active workspace memory store.');
    return session.memory;
  }

  /** Memory store for a specific activated workspace (defaults to current). */
  getMemoryFor(path?: string): MemoryStore {
    if (!path) return this.getMemory();
    const session = this.sessionFor(path);
    if (!session) throw new Error(`Workspace not activated: ${displayPath(path)}`);
    return session.memory;
  }
}
