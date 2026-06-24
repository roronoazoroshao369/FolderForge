import { describe, it, expect } from 'vitest';
import { parseErrors } from '../../src/tools/error-parser.js';

describe('parseErrors', () => {
  it('parses TypeScript diagnostics', () => {
    const out = parseErrors('src/x.ts(12,5): error TS2345: Argument not assignable.');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      tool: 'typescript',
      file: 'src/x.ts',
      line: 12,
      column: 5,
      severity: 'error',
    });
    expect(out[0]!.message).toContain('Argument not assignable');
  });

  it('parses ruff diagnostics', () => {
    const out = parseErrors('app.py:3:1: E402 module level import not at top of file');
    const ruff = out.find((e) => e.tool === 'ruff');
    expect(ruff).toMatchObject({ file: 'app.py', line: 3, column: 1 });
    expect(ruff!.message).toContain('E402');
  });

  it('parses go diagnostics', () => {
    const out = parseErrors('./main.go:8:2: undefined: foo');
    const go = out.find((e) => e.tool === 'go');
    expect(go).toMatchObject({ file: './main.go', line: 8, column: 2, severity: 'error' });
  });

  it('parses rust errors', () => {
    const out = parseErrors('error[E0382]: borrow of moved value: `x`');
    const rust = out.find((e) => e.tool === 'rust');
    expect(rust).toBeDefined();
    expect(rust!.message).toContain('borrow of moved value');
  });

  it('parses vitest failure lines', () => {
    const out = parseErrors('FAIL src/foo.test.ts > does the thing');
    const vt = out.find((e) => e.tool === 'vitest');
    expect(vt).toBeDefined();
    expect(vt!.message).toContain('foo.test.ts');
  });

  it('returns an empty array when nothing matches', () => {
    expect(parseErrors('all good, build succeeded')).toHaveLength(0);
  });

  it('caps output at 100 entries', () => {
    const many = Array.from({ length: 200 }, (_, i) => `src/x.ts(${i + 1},1): error TS1000: boom`).join('\n');
    expect(parseErrors(many)).toHaveLength(100);
  });
});
