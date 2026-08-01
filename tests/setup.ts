import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupIsolatedFixtures } from './integration/fixtures.js';

const approvalRoot = mkdtempSync(join(tmpdir(), 'folderforge-test-approvals-'));
const testHome = mkdtempSync(join(tmpdir(), 'folderforge-test-home-'));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalNpmCache = process.env.npm_config_cache;

process.env.FOLDERFORGE_APPROVALS_PATH = join(approvalRoot, 'approvals.jsonl');
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.npm_config_cache = join(testHome, '.npm');
// A developer or CI host may run an unrelated tunnel client (cloudflared,
// ngrok, ...). The HTTP transport refuses to start unauthenticated in that
// situation, which is correct in production but would make these tests depend
// on host state. The guard itself is covered with an injected probe in
// tests/unit/tunnel-and-async-run.test.ts.
process.env.FOLDERFORGE_ALLOW_UNAUTHENTICATED_TUNNEL = '1';

afterAll(() => {
  cleanupIsolatedFixtures();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalNpmCache === undefined) delete process.env.npm_config_cache;
  else process.env.npm_config_cache = originalNpmCache;
  rmSync(approvalRoot, { recursive: true, force: true });
  rmSync(testHome, { recursive: true, force: true });
});
