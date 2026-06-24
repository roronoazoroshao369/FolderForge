import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectProject, type ProjectInfo } from './project-detector.js';
import { MemoryStore } from './memory-store.js';
import { logger } from '../core/logger.js';

/**
 * Tracks the currently active project and its memory store.
 */
export class WorkspaceManager {
  private active: ProjectInfo | null = null;
  private memory: MemoryStore | null = null;

  constructor(private allowedDirectories: string[]) {}

  activate(path: string): ProjectInfo {
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

  getActive(): ProjectInfo | null {
    return this.active;
  }

  requireActive(): ProjectInfo {
    if (!this.active) throw new Error('No active workspace. Call workspace_activate first.');
    return this.active;
  }

  projectRoot(): string | null {
    return this.active?.projectRoot ?? null;
  }

  getMemory(): MemoryStore {
    if (!this.memory) throw new Error('No active workspace memory store.');
    return this.memory;
  }
}
