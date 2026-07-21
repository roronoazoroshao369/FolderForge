import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = process.cwd();
const project = mkdtempSync(join(tmpdir(), 'folderforge-evidence-smoke-'));
const legacy = join(project, 'audit.jsonl');
const migrated = join(project, 'audit.v2.jsonl');

function run(args, expectSuccess = true) {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/evidence.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if ((result.status === 0) !== expectSuccess) {
    throw new Error(
      `evidence ${args.join(' ')} returned ${result.status}:\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

try {
  const events = [
    {
      ts: '2026-07-20T00:00:00.000Z',
      type: 'tool_call',
      tool: 'smoke_read',
      risk: 'LOW',
    },
    {
      ts: '2026-07-20T00:00:01.000Z',
      type: 'tool_result',
      tool: 'smoke_read',
      risk: 'LOW',
      ok: true,
    },
  ];
  writeFileSync(legacy, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');

  const migration = run([
    'migrate',
    '--input',
    legacy,
    '--output',
    migrated,
    '--json',
  ]);
  const migratedReport = JSON.parse(migration.stdout);
  if (migratedReport.historicalIntegrityClaimed !== false) {
    throw new Error('Migration overstated historical integrity.');
  }
  if (migratedReport.sourceRecords !== events.length) {
    throw new Error('Migration record count does not match source.');
  }

  const verification = run(['verify', '--path', migrated, '--json']);
  const verifiedReport = JSON.parse(verification.stdout);
  if (!verifiedReport.ok || verifiedReport.records !== events.length) {
    throw new Error('Migrated chain did not verify.');
  }

  const records = readFileSync(migrated, 'utf8').trimEnd().split('\n');
  const tampered = JSON.parse(records[1]);
  tampered.event.tool = 'tampered';
  records[1] = JSON.stringify(tampered);
  writeFileSync(migrated, `${records.join('\n')}\n`, 'utf8');
  const rejected = run(['verify', '--path', migrated, '--json'], false);
  const rejectedReport = JSON.parse(rejected.stdout);
  if (rejectedReport.ok || !rejectedReport.issues.some((issue) => issue.code === 'invalid_record_hash')) {
    throw new Error('Tampered evidence was not rejected.');
  }

  console.log(
    JSON.stringify({
      ok: true,
      migratedRecords: migratedReport.sourceRecords,
      headHash: verifiedReport.headHash,
      tamperDetected: true,
    }),
  );
} finally {
  rmSync(project, { recursive: true, force: true });
}
