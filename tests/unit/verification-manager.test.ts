import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  VerificationManager,
  type VerificationRun,
} from '../../src/verification/verification-manager.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function resign(run: VerificationRun): VerificationRun {
  const { integritySha256: _old, ...unsigned } = run;
  run.integritySha256 = createHash('sha256').update(canonical(unsigned)).digest('hex');
  return run;
}

describe('VerificationManager', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'folderforge-verification-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('persists structured results with owner/project/client/task binding', () => {
    const manager = new VerificationManager(root);
    const owner = {
      id: 'credential:owner',
      role: 'agent' as const,
      projectId: 'project:alpha',
      oauthClientId: 'client:web',
      sessionId: 'session:one',
      taskId: 'wf_task123',
    };
    let run = manager.create({
      principal: owner,
      packageManager: 'npm',
      requested: ['test', 'build'],
      commands: { test: 'npm test' },
      stopOnFailure: false,
    });
    run.results[0]!.status = 'passed';
    run.results[0]!.passed = true;
    run.results[0]!.exitCode = 0;
    run = manager.checkpoint(run);
    run = manager.finish(run, 'completed');

    expect(manager.report(run)).toMatchObject({
      id: run.id,
      taskId: 'wf_task123',
      state: 'completed',
      overall: 'unavailable',
      passed: false,
      counts: { passed: 1, unavailable: 1 },
      results: [
        { check: 'test', status: 'passed' },
        { check: 'build', status: 'unavailable' },
      ],
    });
    const restarted = new VerificationManager(root);
    expect(
      restarted.get(run.id, { ...owner, sessionId: 'session:reconnect' }),
    ).toMatchObject({ owner: { principalId: owner.id }, taskId: owner.taskId });
    expect(restarted.list({ ...owner, sessionId: 'session:two' })).toHaveLength(1);
    expect(() => restarted.get(run.id, { ...owner, id: 'credential:other' })).toThrow(
      /access denied/i,
    );
    expect(() => restarted.get(run.id, { ...owner, projectId: 'project:other' })).toThrow(
      /access denied/i,
    );
    expect(() => restarted.get(run.id, { ...owner, oauthClientId: 'client:other' })).toThrow(
      /access denied/i,
    );
  });

  it('detects state tampering', () => {
    const manager = new VerificationManager(root);
    const run = manager.create({
      principal: { id: 'credential:owner', role: 'agent' },
      packageManager: 'npm',
      requested: ['test'],
      commands: { test: 'npm test' },
      stopOnFailure: true,
    });
    const path = join(root, '.folderforge', 'verifications', 'runs', `${run.id}.json`);
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as VerificationRun;
    persisted.results[0]!.command = 'malicious command';
    writeFileSync(path, `${JSON.stringify(persisted, null, 2)}\n`);
    expect(() => manager.get(run.id)).toThrow(/integrity check failed/i);
  });

  it('does not report success when the executor dies after the final checkpoint', () => {
    const manager = new VerificationManager(root);
    let run = manager.create({
      principal: { id: 'credential:owner', role: 'agent' },
      packageManager: 'npm',
      requested: ['test'],
      commands: { test: 'npm test' },
      stopOnFailure: true,
    });
    run.results[0]!.status = 'passed';
    run.results[0]!.passed = true;
    run.results[0]!.exitCode = 0;
    run = manager.checkpoint(run);
    const path = join(root, '.folderforge', 'verifications', 'runs', `${run.id}.json`);
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as VerificationRun;
    persisted.executorPid = 999_999_999;
    resign(persisted);
    writeFileSync(path, `${JSON.stringify(persisted, null, 2)}\n`);

    const restarted = new VerificationManager(root);
    expect(restarted.get(run.id)).toMatchObject({
      state: 'interrupted',
      overall: 'incomplete',
      results: [{ check: 'test', status: 'passed' }],
    });
  });

  it('rejects a symbolic-link verification store', () => {
    if (process.platform === 'win32') return;
    mkdirSync(join(root, '.folderforge'), { recursive: true });
    const outside = join(root, 'outside-store');
    mkdirSync(outside);
    symlinkSync(outside, join(root, '.folderforge', 'verifications'), 'dir');
    const manager = new VerificationManager(root);
    expect(() =>
      manager.create({
        principal: { id: 'credential:owner', role: 'agent' },
        packageManager: 'npm',
        requested: ['test'],
        commands: { test: 'npm test' },
        stopOnFailure: true,
      }),
    ).toThrow(/symbolic link/i);
  });

  it('recovers a dead running executor as interrupted without replay', () => {
    const manager = new VerificationManager(root);
    const run = manager.create({
      principal: { id: 'credential:owner', role: 'agent' },
      packageManager: 'npm',
      requested: ['test', 'build'],
      commands: { test: 'npm test', build: 'npm run build' },
      stopOnFailure: true,
    });
    const path = join(root, '.folderforge', 'verifications', 'runs', `${run.id}.json`);
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as VerificationRun;
    persisted.executorPid = 999_999_999;
    resign(persisted);
    writeFileSync(path, `${JSON.stringify(persisted, null, 2)}\n`);

    const restarted = new VerificationManager(root);
    expect(restarted.get(run.id)).toMatchObject({
      state: 'interrupted',
      overall: 'incomplete',
      results: [
        { check: 'test', status: 'skipped', skipped: true },
        { check: 'build', status: 'skipped', skipped: true },
      ],
    });
  });
});
