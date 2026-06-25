import { describe, it, expect } from 'vitest';
import { toCallToolResult } from '../../src/server/mcp-server.js';

/**
 * `tools/call` result mapping, including structured tool output mirroring
 * (MCP 2025-06-18, roadmap Q1).
 *
 * Contract:
 *  - errors become an isError text result (with approvalId appended when set);
 *  - a successful payload is always rendered as a JSON text block;
 *  - when the tool declares an outputSchema, the raw `data` is ALSO mirrored
 *    into `structuredContent` so spec-aware clients get typed output;
 *  - without an outputSchema, no structuredContent is emitted.
 */
type WithStructured = ReturnType<typeof toCallToolResult> & {
  structuredContent?: unknown;
};

describe('toCallToolResult', () => {
  it('renders a plain success payload as JSON text', () => {
    const out = toCallToolResult({ ok: true, data: { a: 1 } });
    expect(out.isError).toBeUndefined();
    expect(out.content[0]).toMatchObject({ type: 'text' });
    expect(JSON.parse((out.content[0] as { text: string }).text)).toEqual({
      data: { a: 1 },
    });
  });

  it('mirrors data into structuredContent when the tool has an outputSchema', () => {
    const out = toCallToolResult({ ok: true, data: { rows: [{ id: 1 }] } }, true) as WithStructured;
    expect(out.structuredContent).toEqual({ rows: [{ id: 1 }] });
  });

  it('omits structuredContent when there is no outputSchema', () => {
    const out = toCallToolResult({ ok: true, data: { rows: [] } }, false) as WithStructured;
    expect(out.structuredContent).toBeUndefined();
  });

  it('omits structuredContent when there is no data even with a schema', () => {
    const out = toCallToolResult({ ok: true }, true) as WithStructured;
    expect(out.structuredContent).toBeUndefined();
  });

  it('returns a diff as text when there is no data payload', () => {
    const out = toCallToolResult({ ok: true, diff: '--- a\n+++ b' });
    expect((out.content[0] as { text: string }).text).toBe('--- a\n+++ b');
  });

  it('renders an error result with isError', () => {
    const out = toCallToolResult({ ok: false, error: 'boom' });
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toBe('boom');
  });

  it('appends the approvalId to an approval-gated error', () => {
    const out = toCallToolResult({ ok: false, error: 'needs approval', approvalId: 'ap_123' });
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain('ap_123');
  });
});
