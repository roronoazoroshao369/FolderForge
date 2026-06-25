import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Ensure FolderForge's own state directory never pollutes the host project's
 * git status. We drop a self-ignoring `.gitignore` (`*`) into `.folderforge/`,
 * which makes git ignore the entire directory - including the `.gitignore`
 * itself - so `git status` stays clean for the user's repository.
 *
 * Idempotent and safe to call on every workspace activation.
 */
export function ensureStateDirIgnored(projectRoot: string): void {
  const stateDir = join(projectRoot, '.folderforge');
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  const ignore = join(stateDir, '.gitignore');
  if (!existsSync(ignore)) {
    writeFileSync(ignore, '*\n', 'utf8');
  }
}

/**
 * Memory store backed by markdown files under .folderforge/memory/.
 */
export class MemoryStore {
  private dir: string;

  constructor(projectRoot: string) {
    this.dir = join(projectRoot, '.folderforge', 'memory');
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
    // Keep FolderForge's state out of the user's git status.
    ensureStateDirIgnored(projectRoot);
  }

  private safeName(name: string): string {
    const base = name.endsWith('.md') ? name : `${name}.md`;
    if (base.includes('/') || base.includes('..') || base.includes('\\')) {
      throw new Error(`Invalid memory name: ${name}`);
    }
    return base;
  }

  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith('.md'));
  }

  read(name: string): string {
    const path = join(this.dir, this.safeName(name));
    if (!existsSync(path)) throw new Error(`Memory not found: ${name}`);
    return readFileSync(path, 'utf8');
  }

  write(name: string, content: string): string {
    const path = join(this.dir, this.safeName(name));
    writeFileSync(path, content, 'utf8');
    return path;
  }

  update(name: string, append: string): string {
    const file = this.safeName(name);
    const path = join(this.dir, file);
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
    writeFileSync(path, existing + (existing ? '\n' : '') + append, 'utf8');
    return path;
  }

  dir_(): string {
    return this.dir;
  }
}
