import { describe, it, expect } from 'vitest';
import { simpleDiff } from '../../src/tools/diff-util.js';

describe('simpleDiff', () => {
  it('reports no changes for identical input', () => {
    const out = simpleDiff('a\nb\nc', 'a\nb\nc', 'file.ts');
    expect(out).toContain('(no changes)');
  });

  it('shows added lines with a + prefix', () => {
    const out = simpleDiff('a\nb', 'a\nb\nc');
    expect(out).toContain('+ c');
    expect(out).toContain('  a');
    expect(out).toContain('  b');
  });

  it('shows removed lines with a - prefix', () => {
    const out = simpleDiff('a\nb\nc', 'a\nc');
    expect(out).toContain('- b');
  });

  it('shows a replacement as a remove + add', () => {
    const out = simpleDiff('hello\nworld', 'hello\nthere');
    expect(out).toContain('- world');
    expect(out).toContain('+ there');
  });

  it('includes before/after header labels', () => {
    const out = simpleDiff('x', 'y', 'main.ts');
    expect(out).toContain('--- main.ts (before)');
    expect(out).toContain('+++ main.ts (after)');
  });

  it('truncates very large diffs', () => {
    const before = Array.from({ length: 500 }, (_, i) => `old${i}`).join('\n');
    const after = Array.from({ length: 500 }, (_, i) => `new${i}`).join('\n');
    const out = simpleDiff(before, after);
    expect(out).toContain('more lines)');
  });
});
