import { createPublicKey, createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { verifyAuditChain } from '../dist/evidence/audit-chain.js';
import { migrateLegacyAuditLog } from '../dist/evidence/migration.js';

function parseOptions(argv) {
  const command = argv.shift();
  if (!['verify', 'migrate'].includes(command ?? '')) {
    throw new Error('Usage: evidence.mjs verify|migrate [options]');
  }
  const values = new Map();
  const publicKeys = [];
  let json = false;
  while (argv.length > 0) {
    const arg = argv.shift();
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--public-key') {
      const value = argv.shift();
      if (!value) throw new Error('Missing value for --public-key keyId=path');
      publicKeys.push(value);
      continue;
    }
    if (!arg?.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    const value = argv.shift();
    if (!value) throw new Error(`Missing value for ${arg}`);
    values.set(arg.slice(2), value);
  }
  return { command, values, publicKeys, json };
}

function loadPublicKeys(specs) {
  const keys = new Map();
  for (const spec of specs) {
    const separator = spec.indexOf('=');
    if (separator <= 0 || separator === spec.length - 1) {
      throw new Error(`Invalid --public-key value: ${spec}`);
    }
    const keyId = spec.slice(0, separator);
    const path = resolve(spec.slice(separator + 1));
    if (keys.has(keyId)) throw new Error(`Duplicate public key id: ${keyId}`);
    keys.set(keyId, createPublicKey(readFileSync(path)));
  }
  return keys;
}

function output(value, json) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else {
    console.log(`Evidence verification: ${value.ok ? 'PASS' : 'FAIL'}`);
    for (const [key, item] of Object.entries(value)) {
      if (key === 'ok' || key === 'issues') continue;
      console.log(`${key}: ${typeof item === 'object' ? JSON.stringify(item) : String(item)}`);
    }
    for (const issue of value.issues ?? []) {
      console.log(`line ${issue.line}: ${issue.code ?? 'error'}: ${issue.message}`);
    }
  }
}

function verify(options) {
  const path = resolve(
    options.values.get('path') ?? '.folderforge/audit/audit.v2.jsonl',
  );
  if (!existsSync(path)) throw new Error(`Evidence file does not exist: ${path}`);
  const report = verifyAuditChain(readFileSync(path, 'utf8'), {
    publicKeys: loadPublicKeys(options.publicKeys),
  });
  output({ ...report, path }, options.json);
  if (!report.ok) process.exitCode = 1;
}

function migrate(options) {
  const input = resolve(
    options.values.get('input') ?? '.folderforge/audit/audit.jsonl',
  );
  const destination = resolve(
    options.values.get('output') ?? '.folderforge/audit/audit.v2.jsonl',
  );
  if (!existsSync(input)) throw new Error(`Legacy audit file does not exist: ${input}`);
  if (existsSync(destination)) {
    throw new Error(`Refusing to overwrite existing evidence file: ${destination}`);
  }
  const raw = readFileSync(input, 'utf8');
  const result = migrateLegacyAuditLog(raw);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temp = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, result.jsonl, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, destination);
  if (process.platform !== 'win32') chmodSync(destination, 0o600);
  const verified = verifyAuditChain(readFileSync(destination, 'utf8'));
  if (!verified.ok) throw new Error('Migrated audit chain failed self-verification.');
  const report = {
    ok: true,
    input,
    output: destination,
    sourceRecords: result.source.records,
    sourceSha256: result.source.sha256,
    outputSha256: `sha256:${createHash('sha256')
      .update(readFileSync(destination))
      .digest('hex')}`,
    headHash: verified.headHash,
    historicalIntegrityClaimed: false,
    issues: [],
  };
  output(report, options.json);
}

try {
  const options = parseOptions(process.argv.slice(2));
  if (options.command === 'verify') verify(options);
  else migrate(options);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
