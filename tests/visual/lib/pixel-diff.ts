/**
 * Minimal PNG pixel-diff for the SPA visual regression suite (proposal 018).
 *
 * Thresholds (QA-locked, do not bump to hide churn): a pixel counts as
 * different when ANY channel (r/g/b/a) differs by more than
 * CHANNEL_TOLERANCE (12) — absorbs anti-alias noise without hiding real
 * layout changes; a comparison fails when the dimensions differ at all, or
 * when more than MAX_DIFF_RATIO (0.2%) of pixels differ.
 */
import { PNG } from 'pngjs';

export const CHANNEL_TOLERANCE = 12;
export const MAX_DIFF_RATIO = 0.002;

export interface PixelDiffResult {
  sameDimensions: boolean;
  width: number;
  height: number;
  diffPixels: number;
  totalPixels: number;
  ratio: number;
  /** Heat-map PNG (red = differing pixel), null on dimension mismatch. */
  diffPng: Buffer | null;
}

export function diffPngs(baseline: Buffer, actual: Buffer): PixelDiffResult {
  const a = PNG.sync.read(baseline);
  const b = PNG.sync.read(actual);
  const totalPixels = a.width * a.height;
  if (a.width !== b.width || a.height !== b.height) {
    return {
      sameDimensions: false,
      width: a.width,
      height: a.height,
      diffPixels: totalPixels,
      totalPixels,
      ratio: 1,
      diffPng: null,
    };
  }
  const heat = new PNG({ width: a.width, height: a.height });
  let diffPixels = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const different =
      Math.abs(a.data[i]! - b.data[i]!) > CHANNEL_TOLERANCE ||
      Math.abs(a.data[i + 1]! - b.data[i + 1]!) > CHANNEL_TOLERANCE ||
      Math.abs(a.data[i + 2]! - b.data[i + 2]!) > CHANNEL_TOLERANCE ||
      Math.abs(a.data[i + 3]! - b.data[i + 3]!) > CHANNEL_TOLERANCE;
    if (different) {
      diffPixels++;
      heat.data[i] = 255;
      heat.data[i + 1] = 0;
      heat.data[i + 2] = 0;
      heat.data[i + 3] = 255;
    } else {
      heat.data[i] = a.data[i]!;
      heat.data[i + 1] = a.data[i + 1]!;
      heat.data[i + 2] = a.data[i + 2]!;
      heat.data[i + 3] = 80;
    }
  }
  return {
    sameDimensions: true,
    width: a.width,
    height: a.height,
    diffPixels,
    totalPixels,
    ratio: diffPixels / totalPixels,
    diffPng: PNG.sync.write(heat),
  };
}
