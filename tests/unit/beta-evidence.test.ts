import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { betaReport, ingestBetaEvidence, normalizeBetaEvidence } from '../../scripts/beta-evidence.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function record(overrides = {}) {
  return {
    schemaVersion: 1,
    installationId: 'participant-random-123',
    version: '2.5.0',
    commit: 'abcdef123',
    os: 'ubuntu',
    nodeVersion: '24.0.0',
    client: 'client-a',
    attemptType: 'clean-install',
    success: true,
    finalCohort: true,
    notes: 'OPENAI_API_KEY=secret',
    ...overrides,
  };
}

describe('beta evidence intake and graduation gates', () => {
  it('hashes participant/plugin identifiers, redacts notes, and deduplicates records', () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-beta-'));
    roots.push(root);
    const first = ingestBetaEvidence(root, record({ externalPlugin: { packageId: 'external-plugin', validated: true, sandboxReviewed: true } }));
    const second = ingestBetaEvidence(root, record({ externalPlugin: { packageId: 'external-plugin', validated: true, sandboxReviewed: true } }));
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(first.evidence).not.toHaveProperty('installationId');
    expect(first.evidence.externalPlugin).not.toHaveProperty('packageId');
    expect(first.evidence.notes).toContain('[REDACTED]');
    expect(first.evidence.notes).not.toContain('secret');
  });

  it('never graduates without real cohort counts, OS/client/plugin diversity, and final success evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'folderforge-beta-'));
    roots.push(root);
    ingestBetaEvidence(root, record());
    expect(betaReport(root)).toMatchObject({
      completedInstallations: 1,
      graduated: false,
      gates: { installations: false, osCoverage: false, clients: false, externalPlugins: false },
    });
  });

  it('rejects unstructured or sensitive oversized intake instead of storing arbitrary attachments', () => {
    expect(() => normalizeBetaEvidence(record({ os: 'linux' }))).toThrow(/ubuntu, macos, or windows/);
    expect(() => normalizeBetaEvidence(record({ notes: 'x'.repeat(2001) }))).toThrow(/2000/);
    expect(() => normalizeBetaEvidence({ ...record(), sourceCode: 'not allowed' })).not.toThrow();
    const normalized = normalizeBetaEvidence({ ...record(), sourceCode: 'not allowed' });
    expect(normalized).not.toHaveProperty('sourceCode');
  });
});
