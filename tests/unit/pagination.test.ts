import { describe, it, expect } from 'vitest';
import {
  paginate,
  truncateBytes,
  readPageParams,
  toInt,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../../src/tools/pagination.js';

/**
 * Pagination & truncation helpers (roadmap Q3 - token efficiency).
 */
describe('pagination helpers', () => {
  describe('toInt', () => {
    it('coerces numeric strings and floors floats', () => {
      expect(toInt('5', 0)).toBe(5);
      expect(toInt(3.9, 0)).toBe(3);
    });

    it('falls back on invalid or negative input', () => {
      expect(toInt('nope', 7)).toBe(7);
      expect(toInt(-1, 7)).toBe(7);
      expect(toInt(undefined, 2)).toBe(2);
    });
  });

  describe('readPageParams', () => {
    it('applies defaults when args are absent', () => {
      const p = readPageParams({});
      expect(p.offset).toBe(0);
      expect(p.limit).toBe(DEFAULT_LIMIT);
      expect(p.maxBytes).toBeUndefined();
    });

    it('clamps limit to MAX_LIMIT', () => {
      const p = readPageParams({ limit: MAX_LIMIT + 5000 });
      expect(p.limit).toBe(MAX_LIMIT);
    });

    it('reads explicit offset / limit / maxBytes', () => {
      const p = readPageParams({ offset: 10, limit: 25, maxBytes: 1024 });
      expect(p).toEqual({ offset: 10, limit: 25, maxBytes: 1024 });
    });
  });

  describe('paginate', () => {
    const all = Array.from({ length: 10 }, (_, i) => i);

    it('returns a non-truncated page when everything fits', () => {
      const page = paginate(all, 0, 10);
      expect(page.items).toEqual(all);
      expect(page.total).toBe(10);
      expect(page.count).toBe(10);
      expect(page.truncated).toBe(false);
      expect(page.nextOffset).toBeNull();
    });

    it('truncates and reports nextOffset when more remain', () => {
      const page = paginate(all, 0, 4);
      expect(page.items).toEqual([0, 1, 2, 3]);
      expect(page.truncated).toBe(true);
      expect(page.nextOffset).toBe(4);
    });

    it('handles offsets past the end gracefully', () => {
      const page = paginate(all, 50, 10);
      expect(page.items).toEqual([]);
      expect(page.offset).toBe(10);
      expect(page.count).toBe(0);
      expect(page.truncated).toBe(false);
      expect(page.nextOffset).toBeNull();
    });

    it('pages forward via nextOffset until exhausted', () => {
      const seen: number[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page = paginate(all, offset, 3);
        seen.push(...page.items);
        offset = page.nextOffset;
      }
      expect(seen).toEqual(all);
    });
  });

  describe('truncateBytes', () => {
    it('returns the original string when it fits', () => {
      const r = truncateBytes('hello', 100);
      expect(r.text).toBe('hello');
      expect(r.truncated).toBe(false);
      expect(r.totalBytes).toBe(5);
      expect(r.returnedBytes).toBe(5);
    });

    it('returns the original string when maxBytes is undefined', () => {
      const r = truncateBytes('hello');
      expect(r.truncated).toBe(false);
      expect(r.text).toBe('hello');
    });

    it('truncates ASCII to the byte limit', () => {
      const r = truncateBytes('abcdef', 3);
      expect(r.text).toBe('abc');
      expect(r.truncated).toBe(true);
      expect(r.returnedBytes).toBe(3);
      expect(r.totalBytes).toBe(6);
    });

    it('never splits a multi-byte UTF-8 character', () => {
      // 'é' is 2 bytes; 'ü' is 2 bytes. Source = 'aéü' = 1 + 2 + 2 = 5 bytes.
      const src = 'aéü';
      // Cut at 2 bytes: keep 'a' only ('é' would be split), so step back to 'a'.
      const r = truncateBytes(src, 2);
      expect(r.text).toBe('a');
      expect(r.truncated).toBe(true);
      // The returned text must always decode cleanly (no replacement chars).
      expect(r.text).not.toContain('\uFFFD');
    });

    it('keeps a whole multi-byte char when it lands on a boundary', () => {
      const r = truncateBytes('aéü', 3); // 'a' + 'é' = 3 bytes exactly
      expect(r.text).toBe('aé');
      expect(r.truncated).toBe(true);
    });
  });
});
