import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

interface WorkflowMatrix {
  jobs?: {
    compatibility?: {
      strategy?: { matrix?: { os?: string[]; node?: number[] } };
    };
  };
}

describe('package and CI compatibility contract', () => {
  it('keeps package lifecycle scripts free of POSIX-only chmod/rm commands', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.build).toContain('scripts/ensure-bin-mode.mjs');
    expect(pkg.scripts.clean).toBe('node scripts/clean.mjs');
    expect(pkg.scripts.build).not.toMatch(/\bchmod\b/);
    expect(pkg.scripts.clean).not.toMatch(/\brm\s+-rf\b/);
  });

  it('tests both supported LTS lines on Linux, macOS, and Windows', () => {
    const workflow = parseYaml(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')) as WorkflowMatrix;
    const matrix = workflow.jobs?.compatibility?.strategy?.matrix;
    expect(matrix?.node).toEqual([22, 24]);
    expect(matrix?.os).toEqual(['ubuntu-latest', 'macos-latest', 'windows-latest']);
  });
});
