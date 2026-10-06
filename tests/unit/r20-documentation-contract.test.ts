import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function readDoc(...parts: string[]): string {
  return readFileSync(join(root, ...parts), 'utf8');
}

function between(content: string, start: string, end: string): string {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing section start: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing section end: ${end}`).toBeGreaterThan(startIndex);
  return content.slice(startIndex, endIndex);
}

const staleR20Status =
  /EXACT-HEAD CI PENDING|REMEDIATED LOCALLY|awaits exact-head CI|pending exact-head CI|R20 closes only after|R20 PR must pass/i;

describe('R20 documentation contract', () => {
  const projectState = readDoc('docs', 'project', 'PROJECT_STATE.md');
  const projectStatus = readDoc('docs', 'PROJECT_STATUS.md');
  const frontier = readDoc('docs', 'CURRENT_FRONTIER.md');
  const handoff = readDoc('docs', 'HANDOFF.md');

  const currentClaims = [
    {
      name: 'PROJECT_STATE current snapshot',
      content: between(projectState, '# PROJECT STATE', '## Previously inspected environment'),
    },
    {
      name: 'PROJECT_STATUS',
      content: projectStatus,
    },
    {
      name: 'CURRENT_FRONTIER R20 section',
      content: between(
        frontier,
        '## P1 — Mission Control dependency audit',
        '## P2 — External release evidence',
      ),
    },
    {
      name: 'HANDOFF current snapshot',
      content: between(handoff, '## Current snapshot', '## Read first'),
    },
  ];

  it.each(currentClaims)('$name reports R20 as VERIFIED_CI without pending wording', ({ content }) => {
    expect(content).toContain('R20');
    expect(content).toContain('VERIFIED_CI');
    expect(content).not.toMatch(staleR20Status);
  });

  it('keeps the risk register status explicit', () => {
    expect(projectState).toMatch(/^\| R20 \| High \| VERIFIED_CI \|/m);
  });
});
