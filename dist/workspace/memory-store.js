import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Memory store backed by markdown files under .folderforge/memory/.
 */
export class MemoryStore {
    dir;
    constructor(projectRoot) {
        this.dir = join(projectRoot, '.folderforge', 'memory');
        if (!existsSync(this.dir)) {
            mkdirSync(this.dir, { recursive: true });
        }
    }
    safeName(name) {
        const base = name.endsWith('.md') ? name : `${name}.md`;
        if (base.includes('/') || base.includes('..') || base.includes('\\')) {
            throw new Error(`Invalid memory name: ${name}`);
        }
        return base;
    }
    list() {
        if (!existsSync(this.dir))
            return [];
        return readdirSync(this.dir).filter((f) => f.endsWith('.md'));
    }
    read(name) {
        const path = join(this.dir, this.safeName(name));
        if (!existsSync(path))
            throw new Error(`Memory not found: ${name}`);
        return readFileSync(path, 'utf8');
    }
    write(name, content) {
        const path = join(this.dir, this.safeName(name));
        writeFileSync(path, content, 'utf8');
        return path;
    }
    update(name, append) {
        const file = this.safeName(name);
        const path = join(this.dir, file);
        const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
        writeFileSync(path, existing + (existing ? '\n' : '') + append, 'utf8');
        return path;
    }
    dir_() {
        return this.dir;
    }
}
