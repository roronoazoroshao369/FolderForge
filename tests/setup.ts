import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const approvalRoot = mkdtempSync(join(tmpdir(), 'folderforge-test-approvals-'));
process.env.FOLDERFORGE_APPROVALS_PATH = join(approvalRoot, 'approvals.jsonl');

afterAll(() => {
  rmSync(approvalRoot, { recursive: true, force: true });
});
