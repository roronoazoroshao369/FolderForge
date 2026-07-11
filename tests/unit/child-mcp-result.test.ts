import { describe, expect, it } from 'vitest';
import {
  childCallToToolResult,
  normalizeChildContent,
} from '../../src/adapters/child-mcp/result.js';

describe('child MCP result normalization', () => {
  it('promotes text, image, resource, and resource-link blocks', () => {
    const content = normalizeChildContent([
      { type: 'text', text: 'ready' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      {
        type: 'resource',
        resource: { uri: 'memory://report', text: 'report', mimeType: 'text/plain' },
      },
      {
        type: 'resource_link',
        uri: 'file:///tmp/report.txt',
        name: 'report',
        mimeType: 'text/plain',
      },
      { type: 'audio', data: 'ignored-for-now', mimeType: 'audio/wav' },
    ]);

    expect(content).toEqual([
      { kind: 'text', text: 'ready' },
      { kind: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      {
        kind: 'resource',
        uri: 'memory://report',
        text: 'report',
        mimeType: 'text/plain',
      },
      {
        kind: 'resource_link',
        uri: 'file:///tmp/report.txt',
        name: 'report',
        mimeType: 'text/plain',
      },
    ]);
  });

  it('preserves raw data while promoting renderable content', () => {
    const raw = {
      content: [
        { type: 'text', text: 'screenshot saved' },
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      ],
    };
    const result = childCallToToolResult(raw, 'browser_screenshot');

    expect(result.ok).toBe(true);
    expect(result.data).toBe(raw);
    expect(result.content).toHaveLength(2);
  });

  it('turns child isError into a FolderForge error for audit correctness', () => {
    const result = childCallToToolResult(
      { isError: true, content: [{ type: 'text', text: 'invalid selector' }] },
      'browser_click'
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('invalid selector');
    expect(result.content).toContainEqual({ kind: 'text', text: 'invalid selector' });
  });
});
