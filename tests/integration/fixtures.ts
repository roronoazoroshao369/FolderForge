import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the TypeScript fixture project. */
export const TS_FIXTURE = resolve(__dirname, '..', 'fixtures', 'sample-ts-project');

/** Absolute path to the Python fixture project. */
export const PY_FIXTURE = resolve(__dirname, '..', 'fixtures', 'sample-python-project');

const isolatedRoots: string[] = [];

/**
 * Copy a fixture project into a throwaway directory.
 *
 * Tests that build a Container write runtime state (audit chain, approvals,
 * workflow runs) into `<projectRoot>/.folderforge`. Pointing several parallel
 * test files at the shared committed fixture made them race on one audit file
 * and let a multi-megabyte chain accumulate across runs, which eventually made
 * every governed call fail preflight with AUDIT_UNAVAILABLE. `.folderforge` is
 * deliberately excluded from the copy so a polluted fixture cannot leak in.
 */
export function isolatedFixture(source: string = TS_FIXTURE): string {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-fixture-'));
  cpSync(source, root, {
    recursive: true,
    filter: (from) => !from.includes('.folderforge'),
  });
  isolatedRoots.push(root);
  return root;
}

/** Remove every directory handed out by `isolatedFixture`. */
export function cleanupIsolatedFixtures(): void {
  while (isolatedRoots.length > 0) {
    const root = isolatedRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
}
