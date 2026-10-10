/**
 * THROWAWAY QUALIFICATION PROBE — NOT PRODUCT CODE.
 * macOS CI verifies Node POSIX filesystem primitives and noninteractive denial.
 * It does NOT establish physical operator presence, cross-UID isolation on a
 * real host, or a durable grant/approval mechanism.
 */
import assert from 'node:assert/strict';
import { constants, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const output = { platform: process.platform, node: process.version, results: {} };
const required = ['O_NOFOLLOW', 'O_EXCL', 'O_CREAT', 'O_RDONLY', 'O_WRONLY'];
assert.equal(process.platform, 'darwin', 'This probe is macOS-only');
for (const flag of required) assert.equal(typeof constants[flag], 'number', `missing ${flag}`);
output.results.flags = 'PASS';
assert.equal(typeof process.getuid, 'function');
const uid = process.getuid();
const root = await fs.mkdtemp(join(tmpdir(), 'ff-macos-local-consent-'));
try {
  await fs.chmod(root, 0o700);
  const dir = await fs.lstat(root);
  assert.ok(dir.isDirectory());
  assert.equal(dir.uid, uid);
  assert.equal(dir.mode & 0o077, 0);
  output.results.owner_only_directory = 'PASS';

  const target = join(root, 'proof.json');
  const fd = await fs.open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await fd.writeFile(JSON.stringify({ nonce: 'throwaway', committed: false }));
    await fd.sync();
    const st = await fd.stat();
    assert.ok(st.isFile());
    assert.equal(st.uid, uid);
    assert.equal(st.nlink, 1);
    assert.equal(st.mode & 0o077, 0);
  } finally { await fd.close(); }
  output.results.exclusive_create_fd_check_fsync = 'PASS';

  const symbolic = join(root, 'trap');
  await fs.symlink(target, symbolic);
  await assert.rejects(() => fs.open(symbolic, constants.O_RDONLY | constants.O_NOFOLLOW));
  output.results.symlink_open_denied = 'PASS';

  const value = await fs.readFile(target, 'utf8');
  assert.match(value, /throwaway/);
  output.results.readback = 'PASS';

  // CI must NOT simulate or silently approve an interactive human decision.
  assert.notEqual(process.stdin.isTTY, true);
  output.results.noninteractive_refused = 'PASS';
  output.operator_confirmation = 'NOT_RUN';
  output.same_uid_attack_resistance = 'NOT_CLAIMED';
  output.actual_folderforge_fleet_flow = 'NOT_RUN';
  console.log(JSON.stringify(output, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
