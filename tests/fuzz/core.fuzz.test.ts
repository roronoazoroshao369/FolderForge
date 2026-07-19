import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  classifyChildFailure,
  classifyChildFailureDisposition,
  redactChildArgs,
  type ChildFailurePhase,
} from '../../src/adapters/child-mcp/client.js';
import { paginate, truncateBytes } from '../../src/tools/pagination.js';

const phases: ChildFailurePhase[] = [
  'resolve',
  'spawn',
  'initialize',
  'tools/list',
  'runtime',
  'shutdown',
];

const dispositions = new Set([
  'transient',
  'configuration',
  'compatibility',
  'resource',
  'shutdown',
]);

describe('bounded property and fuzz checks', () => {
  it('keeps pagination internally consistent for arbitrary arrays and bounds', () => {
    fc.assert(
      fc.property(
        fc.array(fc.jsonValue(), { maxLength: 200 }),
        fc.nat({ max: 300 }),
        fc.nat({ max: 100 }),
        (items, offset, limit) => {
          const page = paginate(items, offset, limit);
          expect(page.total).toBe(items.length);
          expect(page.offset).toBeLessThanOrEqual(items.length);
          expect(page.count).toBe(page.items.length);
          expect(page.items).toEqual(items.slice(page.offset, page.offset + limit));
          expect(page.truncated).toBe(page.offset + page.count < items.length);
          expect(page.nextOffset).toBe(page.truncated ? page.offset + page.count : null);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('never emits invalid UTF-8 or exceeds the requested byte bound', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), fc.nat({ max: 4096 }), (text, maxBytes) => {
        const result = truncateBytes(text, maxBytes);
        expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(maxBytes);
        expect(result.returnedBytes).toBe(Buffer.byteLength(result.text, 'utf8'));
        expect(result.totalBytes).toBe(Buffer.byteLength(text, 'utf8'));
        expect(text.startsWith(result.text)).toBe(true);
      }),
      { numRuns: 500 }
    );
  });

  it('classifies arbitrary child diagnostics without throwing', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...phases),
        fc.record({
          message: fc.option(fc.string({ maxLength: 1000 }), { nil: undefined }),
          stderr: fc.option(fc.string({ maxLength: 1000 }), { nil: undefined }),
          timedOut: fc.option(fc.boolean(), { nil: undefined }),
          code: fc.option(fc.string({ maxLength: 32 }), { nil: undefined }),
        }),
        (phase, input) => {
          const kind = classifyChildFailure(phase, input);
          expect(typeof kind).toBe('string');
          expect(dispositions.has(classifyChildFailureDisposition(kind))).toBe(true);
        }
      ),
      { numRuns: 1000 }
    );
  });

  it('redacts arbitrary argv without changing argument cardinality', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 512 }), { maxLength: 50 }), (args) => {
        const redacted = redactChildArgs(args);
        expect(redacted).toHaveLength(args.length);
        expect(redacted.every((value) => typeof value === 'string')).toBe(true);
      }),
      { numRuns: 1000 }
    );
  });
});
