import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/workspace/memory-store.js';
import { onboardProject } from '../../src/workspace/onboarding.js';

const roots: string[] = [];

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'folderforge-workspace-onboarding-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'onboarding-fixture',
        scripts: { test: 'vitest run', lint: 'eslint .' },
        devDependencies: { vitest: '^4.1.11' },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workspace onboarding memories', () => {
  it('writes the initial detected project memories', () => {
    const root = projectRoot();
    const memory = new MemoryStore(root);

    const result = onboardProject(root, memory);

    expect(result.writtenMemories).toHaveLength(4);
    expect(memory.list().sort()).toEqual([
      'coding_conventions.md',
      'commands.md',
      'project_overview.md',
      'testing_strategy.md',
    ]);
    expect(memory.read('commands.md')).toContain('| test | `npm run test` |');
    expect(memory.read('testing_strategy.md')).toContain('- Framework: vitest');
  });

  it('preserves edited memories and regenerates only missing files', () => {
    const root = projectRoot();
    const memory = new MemoryStore(root);
    onboardProject(root, memory);

    const editedOverview = '# Team-owned overview\n\nDo not overwrite this content.\n';
    memory.write('project_overview.md', editedOverview);
    unlinkSync(join(memory.dir_(), 'commands.md'));

    const result = onboardProject(root, memory);

    expect(result.writtenMemories).toEqual([join(memory.dir_(), 'commands.md')]);
    expect(memory.read('project_overview.md')).toBe(editedOverview);
    expect(memory.read('commands.md')).toContain('| test | `npm run test` |');
  });
});
