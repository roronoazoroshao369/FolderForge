import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import {
  A11Y_AUDIT_FUNCTION,
  browserTools,
  extractJsonReport,
} from '../../src/tools/browser-tools.js';
import { ArtifactStore } from '../../src/artifacts/artifact-store.js';
import type { ToolContext } from '../../src/core/types.js';

function png(red: number): Buffer {
  const image = new PNG({ width: 1, height: 1 });
  image.data[0] = red;
  image.data[1] = 0;
  image.data[2] = 0;
  image.data[3] = 255;
  return PNG.sync.write(image);
}

function context(
  root: string,
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
): ToolContext {
  return {
    projectRoot: root,
    config: {} as ToolContext['config'],
    container: {
      artifacts: new ArtifactStore(root),
      adapters: {
        isEnabled: (name: string) => name === 'playwright',
        ensure: async () => ({ callTool }),
      },
      policy: { getMode: () => 'dev' },
    },
  };
}

describe('browser artifact, visual, and accessibility quality tools', () => {
  let root: string;
  const tools = new Map(browserTools().map((tool) => [tool.name, tool]));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'folderforge-browser-quality-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('persists browser screenshots while preserving the MCP image block', async () => {
    const bytes = png(10);
    const callTool = vi.fn(async () => ({
      content: [{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }],
    }));
    const ctx = context(root, callTool);

    const result = await tools.get('browser_screenshot')!.handler({ fullPage: true }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toEqual([
      { kind: 'image', mimeType: 'image/png', data: bytes.toString('base64') },
    ]);
    expect(result.data).toMatchObject({
      artifact: { id: expect.stringMatching(/^art_[a-f0-9]{64}$/), mimeType: 'image/png', width: 1, height: 1 },
    });
    expect(ctx.container.artifacts.stats()).toMatchObject({ count: 1, bytes: bytes.length });
    expect(callTool).toHaveBeenCalledWith('browser_take_screenshot', { fullPage: true });
  });

  it('captures and compares a visual artifact with deterministic pixel metrics', async () => {
    const ctx = context(root, async () => ({
      content: [{ type: 'image', mimeType: 'image/png', data: png(255).toString('base64') }],
    }));
    const baseline = ctx.container.artifacts.put(png(0), 'image/png', { sourceTool: 'baseline' });

    const result = await tools.get('browser_visual_compare')!.handler(
      { baselineId: baseline.id, storeDiff: true },
      ctx
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      artifact: { mimeType: 'image/png' },
      comparison: {
        comparable: true,
        pixels: 1,
        differentPixels: 1,
        differencePercent: 100,
        diffArtifact: { mimeType: 'image/png' },
      },
    });
    // The generated red diff is byte-identical to this 1px red screenshot, so
    // content addressing deduplicates it instead of storing a third object.
    expect(ctx.container.artifacts.stats().count).toBe(2);
  });

  it('runs only the fixed accessibility audit and returns parsed structured evidence', async () => {
    const report = {
      url: 'http://localhost:3000',
      title: 'Fixture',
      scanned: { elements: 5, contrastTextNodes: 1 },
      summary: { violations: 1, byImpact: { critical: 1 } },
      violations: [{ rule: 'image-alt', impact: 'critical', selector: '#hero' }],
    };
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: JSON.stringify(report) }],
    }));
    const ctx = context(root, callTool);

    const result = await tools.get('browser_accessibility_audit')!.handler({}, ctx);
    expect(result).toEqual({ ok: true, data: report });
    expect(callTool).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledWith('browser_evaluate', { function: A11Y_AUDIT_FUNCTION });
    expect(A11Y_AUDIT_FUNCTION).toContain('color-contrast');
    expect(A11Y_AUDIT_FUNCTION.length).toBeLessThan(20_000);
  });

  it('extracts JSON from direct, quoted, and decorated child text', () => {
    expect(extractJsonReport({ content: [{ text: '{"ok":true}' }] })).toEqual({ ok: true });
    expect(extractJsonReport({ text: JSON.stringify('{"nested":1}') })).toEqual({ nested: 1 });
    expect(extractJsonReport({ text: 'Result follows:\n{"value":2}\nDone' })).toEqual({ value: 2 });
    expect(extractJsonReport({ text: 'no json' })).toBeNull();
  });
});
