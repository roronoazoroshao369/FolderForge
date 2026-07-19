import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import { ArtifactStore } from '../../src/artifacts/artifact-store.js';

function png(width: number, height: number, pixels: Array<[number, number, number, number]>): Buffer {
  const image = new PNG({ width, height });
  for (let index = 0; index < pixels.length; index += 1) {
    const offset = index * 4;
    const pixel = pixels[index]!;
    image.data[offset] = pixel[0];
    image.data[offset + 1] = pixel[1];
    image.data[offset + 2] = pixel[2];
    image.data[offset + 3] = pixel[3];
  }
  return PNG.sync.write(image);
}

describe('ArtifactStore', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'folderforge-artifacts-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('stores content by SHA-256, deduplicates bytes, and verifies reads', () => {
    const store = new ArtifactStore(root);
    const first = store.put(Buffer.from('hello artifact'), 'text/plain', {
      sourceTool: 'test',
      label: 'hello',
    });
    const second = store.put(Buffer.from('hello artifact'), 'text/plain', {
      sourceTool: 'other',
    });

    expect(first.id).toMatch(/^art_[a-f0-9]{64}$/);
    expect(second).toEqual(first);
    expect(store.list()).toEqual([first]);
    expect(store.read(first.id)).toEqual({ metadata: first, data: Buffer.from('hello artifact') });
    expect(store.stats()).toMatchObject({ count: 1, bytes: 14 });
    expect(readFileSync(join(store.root, '.gitignore'), 'utf8')).toContain('!.gitignore');
  });

  it('fails closed when stored bytes are modified after metadata creation', () => {
    const store = new ArtifactStore(root);
    const artifact = store.put(Buffer.from('trusted'), 'text/plain');
    writeFileSync(join(store.root, 'objects', artifact.sha256), 'tampered');
    expect(() => store.read(artifact.id)).toThrow(/integrity mismatch/i);
  });

  it('enforces per-object, total-byte, and count quotas', () => {
    const objectBound = new ArtifactStore(root, {
      maxArtifactBytes: 3,
      maxTotalBytes: 10,
      maxArtifacts: 10,
    });
    expect(() => objectBound.put(Buffer.from('four'), 'text/plain')).toThrow(/1-3 bytes/);

    const totalRoot = mkdtempSync(join(tmpdir(), 'folderforge-artifacts-total-'));
    try {
      const total = new ArtifactStore(totalRoot, {
        maxArtifactBytes: 10,
        maxTotalBytes: 5,
        maxArtifacts: 2,
      });
      total.put(Buffer.from('abc'), 'text/plain');
      expect(() => total.put(Buffer.from('def'), 'text/plain')).toThrow(/total byte quota/i);
    } finally {
      rmSync(totalRoot, { recursive: true, force: true });
    }

    const countRoot = mkdtempSync(join(tmpdir(), 'folderforge-artifacts-count-'));
    try {
      const count = new ArtifactStore(countRoot, {
        maxArtifactBytes: 10,
        maxTotalBytes: 100,
        maxArtifacts: 1,
      });
      count.put(Buffer.from('one'), 'text/plain');
      expect(() => count.put(Buffer.from('two'), 'text/plain')).toThrow(/count quota/i);
    } finally {
      rmSync(countRoot, { recursive: true, force: true });
    }
  });

  it('compares PNG artifacts, reports exact pixel differences, and stores a diff', () => {
    const store = new ArtifactStore(root);
    const baseline = store.put(
      png(2, 1, [
        [0, 0, 0, 255],
        [255, 255, 255, 255],
      ]),
      'image/png',
      { sourceTool: 'baseline' }
    );
    const actual = store.put(
      png(2, 1, [
        [0, 0, 0, 255],
        [0, 255, 255, 255],
      ]),
      'image/png',
      { sourceTool: 'actual' }
    );

    const result = store.comparePng(baseline.id, actual.id, { storeDiff: true });
    expect(result).toMatchObject({
      comparable: true,
      width: 2,
      height: 1,
      pixels: 2,
      differentPixels: 1,
      differencePercent: 50,
      threshold: 0,
    });
    expect(result.diffArtifact?.mimeType).toBe('image/png');
    expect(store.read(result.diffArtifact!.id).data.byteLength).toBeGreaterThan(0);
  });

  it('reports non-comparable images without writing a diff and deletes cleanly', () => {
    const store = new ArtifactStore(root);
    const small = store.put(png(1, 1, [[0, 0, 0, 255]]), 'image/png');
    const large = store.put(
      png(2, 1, [
        [0, 0, 0, 255],
        [0, 0, 0, 255],
      ]),
      'image/png'
    );
    const result = store.comparePng(small.id, large.id, { storeDiff: true });
    expect(result).toMatchObject({ comparable: false, threshold: 0 });
    expect(result.reason).toMatch(/dimensions differ/i);
    expect(result.diffArtifact).toBeUndefined();

    expect(store.delete(small.id)).toEqual(small);
    expect(() => store.metadata(small.id)).toThrow(/not found/i);
  });
});
