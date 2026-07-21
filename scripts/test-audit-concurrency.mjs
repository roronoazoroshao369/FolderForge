import { fork } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const mode = process.argv[2];

if (mode === '--child') {
  await runChild();
} else {
  await runParent();
}

async function runChild() {
  const root = process.argv[3];
  const workerId = process.argv[4];
  const records = Number(process.argv[5]);
  if (!root || !workerId || !Number.isInteger(records) || records <= 0) {
    throw new Error('Invalid audit concurrency child arguments');
  }

  const { AuditLog } = await import('../dist/audit/audit-log.js');
  const audit = new AuditLog(root, {
    durability: 'best-effort',
    requireForHighRisk: true,
    requireForAuthenticatedHttp: true,
  });

  process.send?.({ type: 'ready', workerId });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for concurrent start signal')),
      20_000,
    );
    process.once('message', (message) => {
      if (!message || message.type !== 'start') {
        clearTimeout(timeout);
        reject(new Error('Invalid concurrent start signal'));
        return;
      }
      clearTimeout(timeout);
      resolve();
    });
  });

  for (let sequence = 0; sequence < records; sequence += 1) {
    audit.record(
      {
        type: 'tool_call',
        tool: 'audit_concurrency_probe',
        risk: 'HIGH',
        detail: { workerId, sequence },
      },
      { required: true },
    );
  }
}

async function runParent() {
  const workerCount = 8;
  const recordsPerWorker = 25;
  const root = mkdtempSync(join(tmpdir(), 'folderforge-audit-concurrency-'));
  const children = [];

  try {
    const ready = new Set();
    for (let index = 0; index < workerCount; index += 1) {
      const workerId = `worker-${index}`;
      const child = fork(
        scriptPath,
        ['--child', root, workerId, String(recordsPerWorker)],
        {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      children.push({ child, workerId, stderr: '' });
      const entry = children.at(-1);
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk) => {
        entry.stderr += chunk;
      });
      child.on('message', (message) => {
        if (message?.type === 'ready') ready.add(message.workerId);
      });
    }

    await waitUntil(
      () => ready.size === workerCount,
      20_000,
      'Timed out waiting for audit writer processes to initialize',
    );
    for (const { child } of children) child.send({ type: 'start' });

    const exits = await Promise.all(
      children.map(
        ({ child, workerId, stderr }) =>
          new Promise((resolve) => {
            child.once('exit', (code, signal) => {
              resolve({ code, signal, workerId, stderr });
            });
          }),
      ),
    );
    const failures = exits.filter((result) => result.code !== 0);
    if (failures.length > 0) {
      throw new Error(`Audit writers failed: ${JSON.stringify(failures)}`);
    }

    const path = join(root, '.folderforge', 'audit', 'audit.v2.jsonl');
    if (!existsSync(path)) throw new Error('Audit concurrency log was not created');
    const raw = readFileSync(path, 'utf8');
    if (!raw.endsWith('\n')) {
      throw new Error('Audit concurrency log ends with a partial record');
    }
    const records = raw
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    const expectedCount = workerCount * recordsPerWorker;
    if (records.length !== expectedCount) {
      throw new Error(
        `Expected ${expectedCount} audit records, received ${records.length}`,
      );
    }

    const identities = new Set(
      records.map(
        (record) =>
          `${record.event?.detail?.workerId}:${record.event?.detail?.sequence}`,
      ),
    );
    if (identities.size !== expectedCount) {
      throw new Error(
        `Expected ${expectedCount} unique writer records, received ${identities.size}`,
      );
    }
    const { verifyAuditChain } = await import('../dist/evidence/audit-chain.js');
    const verification = verifyAuditChain(raw);
    if (!verification.ok) {
      throw new Error(`Concurrent audit chain verification failed: ${JSON.stringify(verification.issues)}`);
    }

    const evidence = {
      ok: true,
      workers: workerCount,
      recordsPerWorker,
      records: records.length,
      uniqueRecords: identities.size,
      headHash: verification.headHash,
    };
    const evidencePath = process.env.FOLDERFORGE_AUDIT_CONCURRENCY_EVIDENCE;
    if (evidencePath) {
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    }
    console.log(JSON.stringify(evidence));
  } finally {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    rmSync(root, { recursive: true, force: true });
  }
}

async function waitUntil(predicate, timeoutMs, timeoutMessage) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(timeoutMessage);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
