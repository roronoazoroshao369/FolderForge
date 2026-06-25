import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectProject } from './project-detector.js';
import { MemoryStore } from './memory-store.js';
import { logger } from '../core/logger.js';
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
    allowedDirectories;
    sessions = new Map();
    current = null;
    constructor(allowedDirectories) {
        this.allowedDirectories = allowedDirectories;
    }
    assertAllowed(abs) {
        const allowed = this.allowedDirectories.some((d) => abs === resolve(d) || abs.startsWith(resolve(d)));
        if (!allowed) {
            throw new Error(`Project path is not within allowed directories: ${abs}`);
        }
    }
    /**
     * Activate a project and make it the current workspace. If it was already
     * activated, this simply re-selects it as current.
     */
    activate(path) {
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
    setCurrent(path) {
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
    deactivate(path) {
        const abs = resolve(path);
        const existed = this.sessions.delete(abs);
        if (this.current === abs) {
            const remaining = [...this.sessions.values()].sort((a, b) => b.activatedAt - a.activatedAt);
            this.current = remaining[0]?.root ?? null;
        }
        return existed;
    }
    /** All activated workspaces, with a flag for the current one. */
    list() {
        return [...this.sessions.values()].map((s) => ({
            ...s.info,
            root: s.root,
            current: s.root === this.current,
        }));
    }
    currentSession() {
        return this.current ? this.sessions.get(this.current) ?? null : null;
    }
    getActive() {
        return this.currentSession()?.info ?? null;
    }
    requireActive() {
        const s = this.currentSession();
        if (!s)
            throw new Error('No active workspace. Call workspace_activate first.');
        return s.info;
    }
    projectRoot() {
        return this.currentSession()?.info.projectRoot ?? null;
    }
    getMemory() {
        const s = this.currentSession();
        if (!s)
            throw new Error('No active workspace memory store.');
        return s.memory;
    }
    /** Memory store for a specific activated workspace (defaults to current). */
    getMemoryFor(path) {
        if (!path)
            return this.getMemory();
        const s = this.sessions.get(resolve(path));
        if (!s)
            throw new Error(`Workspace not activated: ${resolve(path)}`);
        return s.memory;
    }
}
