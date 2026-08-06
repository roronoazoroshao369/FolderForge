import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_RUNTIME_ENV_KEYS = [
  'FOLDERFORGE_APPROVALS_PATH',
  'FOLDERFORGE_ALLOW_UNAUTHENTICATED_TUNNEL',
  'HOME',
  'USERPROFILE',
  'npm_config_cache',
] as const;

type ManagedEnvironmentKey = (typeof TEST_RUNTIME_ENV_KEYS)[number];

export interface TestRuntimeIsolationOptions {
  env?: NodeJS.ProcessEnv;
  tempParent?: string;
  cleanupFixtures?: () => void;
}

export interface TestRuntimeIsolation {
  approvalRoot: string;
  testHome: string;
  cleanup(): void;
}

function restoreEnvironment(
  env: NodeJS.ProcessEnv,
  snapshot: ReadonlyMap<ManagedEnvironmentKey, string | undefined>,
): void {
  for (const key of TEST_RUNTIME_ENV_KEYS) {
    const original = snapshot.get(key);
    if (original === undefined) delete env[key];
    else env[key] = original;
  }
}

/**
 * Install one test-file-scoped runtime transaction.
 *
 * Every environment mutation is snapshotted before installation and restored
 * during idempotent cleanup. Temporary approval and home roots are never shared
 * between test files, preventing state, credential, npm-cache, and host-home
 * leakage when Vitest reuses workers or changes file order.
 */
export function installTestRuntimeIsolation(
  options: TestRuntimeIsolationOptions = {},
): TestRuntimeIsolation {
  const env = options.env ?? process.env;
  const parent = options.tempParent ?? tmpdir();
  const snapshot = new Map<ManagedEnvironmentKey, string | undefined>(
    TEST_RUNTIME_ENV_KEYS.map((key) => [key, env[key]]),
  );

  const approvalRoot = mkdtempSync(join(parent, 'folderforge-test-approvals-'));
  let testHome: string;
  try {
    testHome = mkdtempSync(join(parent, 'folderforge-test-home-'));
  } catch (error) {
    rmSync(approvalRoot, { recursive: true, force: true });
    throw error;
  }

  env.FOLDERFORGE_APPROVALS_PATH = join(approvalRoot, 'approvals.jsonl');
  env.FOLDERFORGE_ALLOW_UNAUTHENTICATED_TUNNEL = '1';
  env.HOME = testHome;
  env.USERPROFILE = testHome;
  env.npm_config_cache = join(testHome, '.npm');

  let cleaned = false;
  return {
    approvalRoot,
    testHome,
    cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      const failures: unknown[] = [];

      try {
        options.cleanupFixtures?.();
      } catch (error) {
        failures.push(error);
      }

      try {
        restoreEnvironment(env, snapshot);
      } catch (error) {
        failures.push(error);
      }

      for (const root of [approvalRoot, testHome]) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch (error) {
          failures.push(error);
        }
      }

      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Test runtime isolation cleanup failed.');
      }
    },
  };
}
