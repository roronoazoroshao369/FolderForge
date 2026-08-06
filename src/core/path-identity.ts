import { existsSync, realpathSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
  type PlatformPath,
} from 'node:path';

/** Lexical absolute path used for user-facing display and diagnostics. */
export function displayPath(input: string): string {
  return resolve(input);
}

/** Canonical identity for a path that must already exist. */
export function canonicalExistingPath(input: string): string {
  return realpathSync.native(displayPath(input));
}

/**
 * Canonical identity for an existing path or a not-yet-created candidate.
 * The nearest existing ancestor is resolved natively, then the lexical suffix
 * is appended without following a path that does not exist yet.
 */
export function canonicalCandidatePath(input: string): string {
  const absolute = displayPath(input);
  let probe = absolute;
  const suffix: string[] = [];

  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) {
      throw new Error(`PATH_CANONICALIZATION_FAILED: no existing ancestor for ${absolute}`);
    }
    suffix.unshift(basename(probe));
    probe = parent;
  }

  const canonicalAncestor = realpathSync.native(probe);
  return suffix.length > 0 ? resolve(canonicalAncestor, ...suffix) : canonicalAncestor;
}

/**
 * Legacy persisted path representation used by Workspace Capsule records.
 * It intentionally preserves the pre-existing on-disk digest contract. Never
 * use this value as an authorization identity; canonicalize transiently first.
 */
export function legacyPersistedPath(input: string): string {
  const absolute = displayPath(input);
  let probe = absolute;
  const suffix: string[] = [];

  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return absolute;
    suffix.unshift(basename(probe));
    probe = parent;
  }

  try {
    const persistedAncestor = realpathSync(probe);
    return suffix.length > 0 ? resolve(persistedAncestor, ...suffix) : persistedAncestor;
  } catch {
    return absolute;
  }
}

export type PathSemantics = Pick<PlatformPath, 'relative' | 'isAbsolute' | 'sep'>;

const hostPath: PathSemantics = { relative, isAbsolute, sep };

/** Exact path identity under the selected platform's path semantics. */
export function samePath(left: string, right: string, paths: PathSemantics = hostPath): boolean {
  return paths.relative(left, right) === '' && paths.relative(right, left) === '';
}

/** Segment-aware containment; prefix siblings such as repo-escape are rejected. */
export function isPathWithin(
  root: string,
  candidate: string,
  paths: PathSemantics = hostPath,
): boolean {
  const rel = paths.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel));
}
