import { realpathSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import picomatchLite from './glob-match.js';
import { PathEscapeError } from '../core/errors.js';

/**
 * PathPolicy enforces the workspace boundary:
 *  - every path must resolve inside an allowed directory
 *  - symlink escapes are rejected
 *  - denied globs (secrets, node_modules, git internals) are blocked
 */
export class PathPolicy {
  private allowed: string[];
  private deniedGlobs: string[];

  constructor(allowedDirectories: string[], deniedGlobs: string[]) {
    this.allowed = allowedDirectories.map((d) => resolve(d));
    this.deniedGlobs = deniedGlobs;
  }

  /** Resolve a (possibly relative) path against the project root and validate it. */
  resolveSafe(inputPath: string, projectRoot: string): string {
    const abs = isAbsolute(inputPath) ? resolve(inputPath) : resolve(projectRoot, inputPath);
    this.assertInsideAllowed(abs);
    this.assertNotDenied(abs, projectRoot);
    this.assertNoSymlinkEscape(abs);
    return abs;
  }

  isInsideAllowed(abs: string): boolean {
    return this.allowed.some((root) => {
      const rel = relative(root, abs);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });
  }

  assertInsideAllowed(abs: string): void {
    if (!this.isInsideAllowed(abs)) {
      throw new PathEscapeError(`Path is outside allowed directories: ${abs}`);
    }
  }

  isDenied(abs: string, projectRoot: string): boolean {
    const rel = relative(projectRoot, abs).split(sep).join('/');
    const candidates = [rel, abs.split(sep).join('/')];
    return this.deniedGlobs.some((g) => candidates.some((c) => picomatchLite(g, c)));
  }

  assertNotDenied(abs: string, projectRoot: string): void {
    if (this.isDenied(abs, projectRoot)) {
      throw new PathEscapeError(`Path is denied by policy (secret/ignored): ${abs}`);
    }
    // Extra hard guards for sensitive home folders.
    const lowered = abs.toLowerCase();
    const sensitive = ['/.ssh/', '/.aws/', '/.gnupg/', '/.config/gcloud/', '/.kube/'];
    if (sensitive.some((s) => lowered.includes(s))) {
      throw new PathEscapeError(`Path touches a protected credential folder: ${abs}`);
    }
  }

  /** Resolve symlinks on the nearest existing ancestor and re-check the boundary. */
  assertNoSymlinkEscape(abs: string): void {
    let probe = abs;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) return; // reached root, nothing exists yet
      probe = parent;
    }
    let real: string;
    try {
      real = realpathSync(probe);
    } catch {
      return;
    }
    if (!this.isInsideAllowed(real)) {
      throw new PathEscapeError(`Symlink escapes the workspace boundary: ${abs} -> ${real}`);
    }
  }
}
