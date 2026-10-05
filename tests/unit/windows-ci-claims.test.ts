import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WINDOWS = 'windows-latest';
const CONTRACT_START = '<!-- windows-ci-contract:start -->';
const CONTRACT_END = '<!-- windows-ci-contract:end -->';

interface WorkflowStep {
  name?: string;
  if?: string;
  uses?: string;
}

interface Workflow {
  jobs?: {
    compatibility?: {
      steps?: WorkflowStep[];
    };
  };
}

/** Fail closed on any CI `if` form this reconciliation does not understand. */
export function runsOn(condition: string | undefined, os: string, node: number): boolean {
  if (!condition) return true;
  const source = condition.trim();
  let index = 0;

  function skipSpace(): void {
    while (source[index] === ' ') index += 1;
  }

  function parseOr(): boolean {
    let value = parseAnd();
    while (true) {
      skipSpace();
      if (!source.startsWith('||', index)) return value;
      index += 2;
      const right = parseAnd();
      value = value || right;
    }
  }

  function parseAnd(): boolean {
    let value = parseUnary();
    while (true) {
      skipSpace();
      if (!source.startsWith('&&', index)) return value;
      index += 2;
      const right = parseUnary();
      value = value && right;
    }
  }

  function parseUnary(): boolean {
    skipSpace();
    if (source.startsWith('(', index)) {
      index += 1;
      const value = parseOr();
      skipSpace();
      if (source[index] !== ')') throw new Error(`unclosed group in ${condition}`);
      index += 1;
      return value;
    }
    if (source.startsWith('always()', index)) {
      index += 'always()'.length;
      return true;
    }
    const comparison = /^(matrix\.(?:os|node))\s*(==|!=)\s*(\S+)/.exec(source.slice(index));
    if (!comparison) {
      throw new Error(`unrecognized CI condition near "${source.slice(index)}" in ${condition}`);
    }
    index += comparison[0].length;
    const field = comparison[1];
    const operator = comparison[2];
    const expected = comparison[3].replace(/^['"]|['"]$/g, '');
    const actual = field === 'matrix.os' ? os : String(node);
    return operator === '==' ? actual === expected : actual !== expected;
  }

  const value = parseOr();
  skipSpace();
  if (index !== source.length) {
    throw new Error(`trailing CI condition "${source.slice(index)}" in ${condition}`);
  }
  return value;
}

function loadWorkflow(): WorkflowStep[] {
  const workflow = parseYaml(
    readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'),
  ) as Workflow;
  return workflow.jobs?.compatibility?.steps ?? [];
}

function windowsContract(steps: WorkflowStep[]): string {
  const rows = steps
    .filter((step) => step.name && step.name !== 'Set up Node')
    .map((step) => {
      const node22 = runsOn(step.if, WINDOWS, 22) ? 'run' : 'NOT_RUN';
      const node24 = runsOn(step.if, WINDOWS, 24) ? 'run' : 'NOT_RUN';
      return `| ${step.name} | ${node22} | ${node24} |`;
    });
  return [
    '| Step | Node 22 | Node 24 |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n');
}

describe('Windows CI claim reconciliation', () => {
  const steps = loadWorkflow();
  const byName = new Map(steps.filter((step) => step.name).map((step) => [step.name as string, step]));

  it('keeps the Windows gates that already run', () => {
    const requiredBoth = [
      'Install dependencies without lifecycle downloads',
      'Typecheck',
      'Lint',
      'Architecture boundaries',
      'Documentation and version checks',
      'Sandbox smoke runtime selection (routing-only, not containment evidence)',
      'Fleet reconnect recovery (orphan reaping, lease fencing)',
      'Windows danger-mode regression',
      'Build',
    ];
    for (const name of requiredBoth) {
      const step = byName.get(name);
      expect(step, name).toBeDefined();
      expect(runsOn(step?.if, WINDOWS, 22), `${name} / Node 22`).toBe(true);
      expect(runsOn(step?.if, WINDOWS, 24), `${name} / Node 24`).toBe(true);
    }

    const thirdParty = byName.get('Pinned third-party child MCP compatibility');
    const preserveThirdParty = byName.get('Preserve third-party child MCP evidence');
    expect(runsOn(thirdParty?.if, WINDOWS, 22)).toBe(true);
    expect(runsOn(thirdParty?.if, WINDOWS, 24)).toBe(false);
    expect(preserveThirdParty?.uses).toContain('actions/upload-artifact');
    expect(runsOn(preserveThirdParty?.if, WINDOWS, 22)).toBe(true);
    expect(runsOn(preserveThirdParty?.if, WINDOWS, 24)).toBe(false);
  });

  it('documents the exact Windows run/NOT_RUN contract and rejects universal smoke claims', () => {
    const compatibility = readFileSync(join(root, 'docs', 'compatibility.md'), 'utf8');
    const expected = windowsContract(steps);
    const start = compatibility.indexOf(CONTRACT_START);
    const end = compatibility.indexOf(CONTRACT_END);
    expect(start, 'missing windows-ci-contract start marker').toBeGreaterThanOrEqual(0);
    expect(end, 'missing windows-ci-contract end marker').toBeGreaterThan(start);
    const actual = compatibility.slice(start + CONTRACT_START.length, end).trim();
    expect(actual).toBe(expected);

    expect(compatibility).not.toContain('Every matrix entry installs dependencies');
    expect(compatibility).not.toContain('Ubuntu/Node 22 and Windows/Node 22 run repeated heartbeat stress');
    expect(compatibility).toContain('NOT_RUN is not a pass');
    expect(compatibility).toContain('Windows danger-mode regression is not the full unit and integration suite');
    expect(compatibility).toContain('package, stdio, and authenticated HTTP smokes are not Windows evidence');
    expect(compatibility).toContain('heartbeat stress and MCP Inspector do not run on Windows');
  });
});
