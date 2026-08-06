import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installTestRuntimeIsolation } from '../runtime-isolation.js';

const MANAGED_ENV_KEYS = [
  'FOLDERFORGE_APPROVALS_PATH',
  'FOLDERFORGE_ALLOW_UNAUTHENTICATED_TUNNEL',
  'HOME',
  'USERPROFILE',
  'npm_config_cache',
] as const;

describe('test runtime isolation', () => {
  it('restores every managed environment key and removes its temporary roots exactly once', () => {
    const parent = mkdtempSync(join(tmpdir(), 'folderforge-runtime-isolation-test-'));
    const env: NodeJS.ProcessEnv = {
      FOLDERFORGE_APPROVALS_PATH: 'existing-approvals',
      HOME: 'existing-home',
      npm_config_cache: 'existing-cache',
    };
    let fixtureCleanupCalls = 0;

    try {
      const runtime = installTestRuntimeIsolation({
        env,
        tempParent: parent,
        cleanupFixtures: () => {
          fixtureCleanupCalls += 1;
        },
      });

      expect(env.FOLDERFORGE_APPROVALS_PATH).toBe(join(runtime.approvalRoot, 'approvals.jsonl'));
      expect(env.FOLDERFORGE_ALLOW_UNAUTHENTICATED_TUNNEL).toBe('1');
      expect(env.HOME).toBe(runtime.testHome);
      expect(env.USERPROFILE).toBe(runtime.testHome);
      expect(env.npm_config_cache).toBe(join(runtime.testHome, '.npm'));
      expect(existsSync(runtime.approvalRoot)).toBe(true);
      expect(existsSync(runtime.testHome)).toBe(true);

      runtime.cleanup();
      runtime.cleanup();

      expect(fixtureCleanupCalls).toBe(1);
      expect(existsSync(runtime.approvalRoot)).toBe(false);
      expect(existsSync(runtime.testHome)).toBe(false);
      expect(env.FOLDERFORGE_APPROVALS_PATH).toBe('existing-approvals');
      expect(env.HOME).toBe('existing-home');
      expect(env.npm_config_cache).toBe('existing-cache');
      expect(env.FOLDERFORGE_ALLOW_UNAUTHENTICATED_TUNNEL).toBeUndefined();
      expect(env.USERPROFILE).toBeUndefined();
      expect(Object.keys(env).sort()).toEqual(
        MANAGED_ENV_KEYS.filter((key) => env[key] !== undefined).sort(),
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
