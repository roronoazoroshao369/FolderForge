import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

const WORKFLOWS = {
  soak: resolve('.github/workflows/production-soak.yml'),
  release: resolve('.github/workflows/release.yml'),
  publish: resolve('.github/workflows/publish-npm.yml'),
};

function text(name: keyof typeof WORKFLOWS): string {
  return readFileSync(WORKFLOWS[name], 'utf8');
}

function parsed(name: keyof typeof WORKFLOWS): Record<string, unknown> {
  return YAML.parse(text(name)) as Record<string, unknown>;
}

describe('production release workflow contracts', () => {
  it('defines an exact-commit resumable 24-hour soak with pinned actions', () => {
    const source = text('soak');
    const workflow = parsed('soak') as {
      env: Record<string, string>;
      jobs: Record<string, { 'timeout-minutes'?: number }>;
    };

    expect(workflow.env).toMatchObject({
      SOAK_DURATION_MS: '86400000',
      SOAK_INTERVAL_MS: '1000',
      SOAK_FAULT_EVERY: '300',
    });
    expect(Object.keys(workflow.jobs)).toEqual([
      'prepare',
      'segment-1',
      'segment-2',
      'segment-3',
      'segment-4',
      'complete',
    ]);
    for (const name of ['segment-1', 'segment-2', 'segment-3', 'segment-4', 'complete']) {
      expect(workflow.jobs[name]?.['timeout-minutes']).toBe(350);
    }
    expect(source.match(/--resume/g)).toHaveLength(4);
    expect(source.match(/test "\$\{code\}" -eq 143/g)).toHaveLength(4);
    expect(source).toContain('test "${code}" -eq 0');
    expect(source).toContain('--commit "${{ needs.prepare.outputs.commit }}"');
    expect(source).toContain('production-soak-${{ needs.prepare.outputs.commit }}');
    expect(source).toContain('production-soak-receipt.json');

    const actionRefs = [...source.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)].map((match) => match[1]);
    expect(actionRefs.length).toBeGreaterThan(0);
    expect(actionRefs.every((ref) => /^[0-9a-f]{40}$/i.test(ref))).toBe(true);
  });

  it.each(['release', 'publish'] as const)(
    '%s requires exact-SHA CI and a verified production soak artifact',
    (name) => {
      const source = text(name);
      const workflow = parsed(name) as { permissions: Record<string, string> };

      expect(workflow.permissions.actions).toBe('read');
      expect(source).toContain('actions/workflows/ci.yml/runs');
      expect(source).toContain('-f head_sha="${GITHUB_SHA}"');
      expect(source).toContain('-f status=success');
      expect(source).toContain('actions/artifacts');
      expect(source).toContain('-f name="production-soak-${GITHUB_SHA}"');
      expect(source).toContain('.expired == false');
      expect(source).toContain('.name == "production-soak"');
      expect(source).toContain('.path == ".github/workflows/production-soak.yml"');
      expect(source).toContain('--name "production-soak-${GITHUB_SHA}"');
      expect(source).toContain('scripts/verify-production-soak.mjs');
      expect(source).toContain('--commit "${GITHUB_SHA}"');
    },
  );

  it('attests and publishes the production soak receipt with npm evidence', () => {
    const source = text('publish');
    expect(source).toContain('Attest production soak verification receipt');
    expect(source).toContain('subject-path: ${{ runner.temp }}/production-soak-verification.json');
    expect(source).toContain('${{ runner.temp }}/production-soak-verification.json');
    expect(source).toContain('"${RUNNER_TEMP}/production-soak-verification.json"');
  });
});
