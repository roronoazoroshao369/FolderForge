/**
 * Mac filesystem durability primitives qualification, NOT a power-loss test.
 * Evidence-only; does NOT authorize a Fleet host grant.
 */
import assert from 'node:assert/strict';
import {
  constants, mkdirSync, mkdtempSync, writeFileSync, openSync, fsyncSync, closeSync,
  renameSync, readFileSync, rmSync, lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

assert.equal(process.platform, 'darwin', 'macOS only; skipped platforms are NOT_RUN');
const root = mkdtempSync(join(tmpdir(), 'ff-macos-directory-sync-'));
let fileFd;
let dirFd;
try {
  const operator = join(root, 'operator');
  mkdirSync(operator, { mode: 0o700 });
  const path = join(operator, 'journal.json');
  const temp = join(operator, 'journal.json.tmp');
  fileFd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  writeFileSync(fileFd, JSON.stringify({ phase: 'PREPARED' }));
  fsyncSync(fileFd);
  closeSync(fileFd);
  fileFd = undefined;
  dirFd = openSync(dirname(temp), constants.O_RDONLY | constants.O_NOFOLLOW);
  fsyncSync(dirFd);
  closeSync(dirFd);
  dirFd = undefined;
  renameSync(temp, path);
  dirFd = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  fsyncSync(dirFd);
  closeSync(dirFd);
  dirFd = undefined;
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.phase, 'PREPARED');
  assert.equal(lstatSync(path).mode & 0o077, 0);
  console.log(JSON.stringify({
    platform: 'darwin', node: process.version,
    file_fsync: 'PASS', directory_fsync: 'PASS', rename_readback: 'PASS',
    power_loss_durability: 'UNVERIFIED', real_host_operator_presence: 'NOT_RUN',
    actual_fleet_profile_recovery: 'NOT_RUN',
  }, null, 2));
} finally {
  if (fileFd !== undefined) closeSync(fileFd);
  if (dirFd !== undefined) closeSync(dirFd);
  rmSync(root, { recursive: true, force: true });
}
