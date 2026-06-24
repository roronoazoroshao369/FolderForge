import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectProject } from './project-detector.js';
import { MemoryStore } from './memory-store.js';
import { logger } from '../core/logger.js';
/**
 * Tracks the currently active project and its memory store.
 */
export class WorkspaceManager {
    allowedDirectories;
    active = null;
    memory = null;
    constructor(allowedDirectories) {
        this.allowedDirectories = allowedDirectories;
    }
    activate(path) {
        const abs = resolve(path);
        if (!existsSync(abs)) {
            throw new Error(`Project path does not exist: ${abs}`);
        }
        const allowed = this.allowedDirectories.some((d) => abs === resolve(d) || abs.startsWith(resolve(d)));
        if (!allowed) {
            throw new Error(`Project path is not within allowed directories: ${abs}`);
        }
        this.active = detectProject(abs);
        this.memory = new MemoryStore(abs);
        logger.info({ project: this.active.name, root: abs }, 'Workspace activated');
        return this.active;
    }
    getActive() {
        return this.active;
    }
    requireActive() {
        if (!this.active)
            throw new Error('No active workspace. Call workspace_activate first.');
        return this.active;
    }
    projectRoot() {
        return this.active?.projectRoot ?? null;
    }
    getMemory() {
        if (!this.memory)
            throw new Error('No active workspace memory store.');
        return this.memory;
    }
}
