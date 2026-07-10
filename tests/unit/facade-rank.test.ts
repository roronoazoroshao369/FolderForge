import { describe, it, expect } from 'vitest';
import { tokenize, bm25Rank, type RankDoc } from '../../src/adapters/child-mcp/rank.js';

describe('facade list_tools ranking (BM25)', () => {
  describe('tokenize', () => {
    it('splits snake_case, kebab-case, and dotted names', () => {
      expect(tokenize('open_scene')).toEqual(['open', 'scene']);
      expect(tokenize('run-project')).toEqual(['run', 'project']);
      expect(tokenize('node.get_child')).toEqual(['node', 'get', 'child']);
    });

    it('splits camelCase / PascalCase boundaries', () => {
      expect(tokenize('getChildNode')).toEqual(['get', 'child', 'node']);
      expect(tokenize('HTTPServer')).toEqual(['httpserver']);
    });

    it('lowercases and drops empties; keeps single chars', () => {
      expect(tokenize('  Foo   BAR ')).toEqual(['foo', 'bar']);
      expect(tokenize('x')).toEqual(['x']);
      expect(tokenize('')).toEqual([]);
    });
  });

  const DOCS: RankDoc[] = [
    { id: 'open_scene', name: 'open_scene', description: 'Open a scene file in the editor.' },
    { id: 'save_scene', name: 'save_scene', description: 'Save the current scene to disk.' },
    { id: 'run_project', name: 'run_project', description: 'Run the game project from the main scene.' },
    { id: 'list_nodes', name: 'list_nodes', description: 'List all nodes in the active scene tree.' },
    { id: 'delete_file', name: 'delete_file', description: 'Remove a file from the filesystem.' },
  ];

  it('ranks the exact-name match first', () => {
    const ranked = bm25Rank(DOCS, 'open scene');
    expect(ranked[0].id).toBe('open_scene');
    expect(ranked[0].score).toBeGreaterThan(0);
  });

  it('drops docs that match no query term (query acts as a filter)', () => {
    const ranked = bm25Rank(DOCS, 'compile shader');
    expect(ranked).toEqual([]);
  });

  it('returns only relevant docs, best first', () => {
    const ranked = bm25Rank(DOCS, 'scene');
    const ids = ranked.map((r) => r.id);
    // Every returned doc mentions "scene"; delete_file / (nothing else) excluded.
    expect(ids).toContain('open_scene');
    expect(ids).toContain('save_scene');
    expect(ids).toContain('run_project');
    expect(ids).toContain('list_nodes');
    expect(ids).not.toContain('delete_file');
  });

  it('weights a name hit above a description-only hit', () => {
    const docs: RankDoc[] = [
      { id: 'a', name: 'unrelated_tool', description: 'This mentions scene once.' },
      { id: 'b', name: 'scene_manager', description: 'Handles things.' },
    ];
    const ranked = bm25Rank(docs, 'scene');
    expect(ranked[0].id).toBe('b');
  });

  it('is stable: ties keep original order', () => {
    const docs: RankDoc[] = [
      { id: 'first', name: 'alpha', description: 'shared term' },
      { id: 'second', name: 'beta', description: 'shared term' },
    ];
    const ranked = bm25Rank(docs, 'shared');
    expect(ranked.map((r) => r.id)).toEqual(['first', 'second']);
  });

  it('returns empty for an empty query or empty catalog', () => {
    expect(bm25Rank(DOCS, '')).toEqual([]);
    expect(bm25Rank(DOCS, '   ')).toEqual([]);
    expect(bm25Rank([], 'scene')).toEqual([]);
  });
});
