import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { ArtifactStorePort } from '../evidence/ports.js';

const DEFAULT_MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACTS = 1000;
const ARTIFACT_ID = /^art_([a-f0-9]{64})$/;

export interface ArtifactMetadata {
  id: string;
  sha256: string;
  mimeType: string;
  bytes: number;
  createdAt: string;
  sourceTool?: string;
  label?: string;
  width?: number;
  height?: number;
}

export interface ArtifactComparison {
  baseline: ArtifactMetadata;
  actual: ArtifactMetadata;
  comparable: boolean;
  width?: number;
  height?: number;
  pixels?: number;
  differentPixels?: number;
  differencePercent?: number;
  meanChannelDelta?: number;
  threshold: number;
  diffArtifact?: ArtifactMetadata;
  reason?: string;
}

export interface ArtifactStoreOptions {
  maxArtifactBytes?: number;
  maxTotalBytes?: number;
  maxArtifacts?: number;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return normalized;
}

function writeAtomic(path: string, data: Buffer | string): void {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, data, { mode: 0o600 });
  renameSync(temp, path);
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

function imageDimensions(mimeType: string, data: Buffer): { width?: number; height?: number } {
  if (mimeType !== 'image/png') return {};
  try {
    const png = PNG.sync.read(data, { skipRescale: true });
    return { width: png.width, height: png.height };
  } catch {
    return {};
  }
}

export class ArtifactStore implements ArtifactStorePort<ArtifactMetadata> {
  readonly root: string;
  private readonly objectsDir: string;
  private readonly metadataDir: string;
  private readonly maxArtifactBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxArtifacts: number;

  constructor(projectRoot: string, options: ArtifactStoreOptions = {}) {
    this.root = join(projectRoot, '.folderforge', 'artifacts');
    this.objectsDir = join(this.root, 'objects');
    this.metadataDir = join(this.root, 'metadata');
    this.maxArtifactBytes = positiveInteger(
      options.maxArtifactBytes,
      DEFAULT_MAX_ARTIFACT_BYTES,
      'maxArtifactBytes'
    );
    this.maxTotalBytes = positiveInteger(
      options.maxTotalBytes,
      DEFAULT_MAX_TOTAL_BYTES,
      'maxTotalBytes'
    );
    this.maxArtifacts = positiveInteger(options.maxArtifacts, DEFAULT_MAX_ARTIFACTS, 'maxArtifacts');
  }

  put(
    data: Buffer,
    mimeType: string,
    details: { sourceTool?: string; label?: string } = {}
  ): ArtifactMetadata {
    if (!Buffer.isBuffer(data)) throw new Error('Artifact data must be a Buffer.');
    if (data.byteLength < 1 || data.byteLength > this.maxArtifactBytes) {
      throw new Error(`Artifact must contain 1-${this.maxArtifactBytes} bytes.`);
    }
    const normalizedMime = mimeType.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalizedMime)) {
      throw new Error('Artifact mimeType is invalid.');
    }

    const sha256 = createHash('sha256').update(data).digest('hex');
    const id = `art_${sha256}`;
    const existing = this.tryMetadata(id);
    if (existing) return existing;

    const current = this.list();
    const totalBytes = current.reduce((sum, artifact) => sum + artifact.bytes, 0);
    if (current.length >= this.maxArtifacts) throw new Error('Artifact count quota exceeded.');
    if (totalBytes + data.byteLength > this.maxTotalBytes) {
      throw new Error('Artifact total byte quota exceeded.');
    }

    mkdirSync(this.objectsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.metadataDir, { recursive: true, mode: 0o700 });
    const dimensions = imageDimensions(normalizedMime, data);
    const metadata: ArtifactMetadata = {
      id,
      sha256,
      mimeType: normalizedMime,
      bytes: data.byteLength,
      createdAt: new Date().toISOString(),
      ...(details.sourceTool ? { sourceTool: details.sourceTool.slice(0, 128) } : {}),
      ...(details.label ? { label: details.label.slice(0, 256) } : {}),
      ...dimensions,
    };
    writeAtomic(this.objectPath(sha256), data);
    try {
      writeAtomic(this.metadataPath(sha256), `${JSON.stringify(metadata, null, 2)}\n`);
    } catch (error) {
      rmSync(this.objectPath(sha256), { force: true });
      throw error;
    }
    this.ensureGitignore();
    return metadata;
  }

  list(limit = 100, offset = 0): ArtifactMetadata[] {
    const safeLimit = Math.max(0, Math.min(1000, Math.trunc(limit)));
    const safeOffset = Math.max(0, Math.trunc(offset));
    if (!existsSync(this.metadataDir)) return [];
    return readdirSync(this.metadataDir)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => this.readMetadataFile(join(this.metadataDir, name)))
      .filter((value): value is ArtifactMetadata => value !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .slice(safeOffset, safeOffset + safeLimit);
  }

  metadata(id: string): ArtifactMetadata {
    const sha = this.parseId(id);
    const metadata = this.readMetadataFile(this.metadataPath(sha));
    if (!metadata) throw new Error(`Artifact not found: ${id}`);
    return metadata;
  }

  read(id: string): { metadata: ArtifactMetadata; data: Buffer } {
    const metadata = this.metadata(id);
    const data = readFileSync(this.objectPath(metadata.sha256));
    const digest = createHash('sha256').update(data).digest('hex');
    if (digest !== metadata.sha256 || data.byteLength !== metadata.bytes) {
      throw new Error(`Artifact integrity mismatch: ${id}`);
    }
    return { metadata, data };
  }

  delete(id: string): ArtifactMetadata {
    const metadata = this.metadata(id);
    rmSync(this.metadataPath(metadata.sha256), { force: true });
    rmSync(this.objectPath(metadata.sha256), { force: true });
    return metadata;
  }

  comparePng(
    baselineId: string,
    actualId: string,
    options: { threshold?: number; storeDiff?: boolean } = {}
  ): ArtifactComparison {
    const threshold = options.threshold ?? 0;
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) {
      throw new Error('PNG comparison threshold must be an integer from 0 to 255.');
    }
    const baseline = this.read(baselineId);
    const actual = this.read(actualId);
    if (baseline.metadata.mimeType !== 'image/png' || actual.metadata.mimeType !== 'image/png') {
      return {
        baseline: baseline.metadata,
        actual: actual.metadata,
        comparable: false,
        threshold,
        reason: 'Both artifacts must be image/png.',
      };
    }

    let a: PNG;
    let b: PNG;
    try {
      a = PNG.sync.read(baseline.data, { skipRescale: true });
      b = PNG.sync.read(actual.data, { skipRescale: true });
    } catch (error) {
      return {
        baseline: baseline.metadata,
        actual: actual.metadata,
        comparable: false,
        threshold,
        reason: `Invalid PNG data: ${String(error)}`,
      };
    }
    if (a.width !== b.width || a.height !== b.height) {
      return {
        baseline: baseline.metadata,
        actual: actual.metadata,
        comparable: false,
        threshold,
        width: b.width,
        height: b.height,
        reason: `PNG dimensions differ: ${a.width}x${a.height} vs ${b.width}x${b.height}.`,
      };
    }

    const diff = new PNG({ width: a.width, height: a.height });
    let differentPixels = 0;
    let channelDelta = 0;
    for (let index = 0; index < a.data.length; index += 4) {
      let maxDelta = 0;
      for (let channel = 0; channel < 4; channel += 1) {
        const delta = Math.abs(a.data[index + channel]! - b.data[index + channel]!);
        channelDelta += delta;
        maxDelta = Math.max(maxDelta, delta);
      }
      const changed = maxDelta > threshold;
      if (changed) differentPixels += 1;
      diff.data[index] = changed ? 255 : b.data[index]!;
      diff.data[index + 1] = changed ? 0 : b.data[index + 1]!;
      diff.data[index + 2] = changed ? 0 : b.data[index + 2]!;
      diff.data[index + 3] = 255;
    }
    const pixels = a.width * a.height;
    const result: ArtifactComparison = {
      baseline: baseline.metadata,
      actual: actual.metadata,
      comparable: true,
      width: a.width,
      height: a.height,
      pixels,
      differentPixels,
      differencePercent: pixels === 0 ? 0 : (differentPixels / pixels) * 100,
      meanChannelDelta: a.data.length === 0 ? 0 : channelDelta / a.data.length,
      threshold,
    };
    if (options.storeDiff) {
      result.diffArtifact = this.put(PNG.sync.write(diff), 'image/png', {
        sourceTool: 'artifact_compare',
        label: `Diff ${baselineId} vs ${actualId}`,
      });
    }
    return result;
  }

  private parseId(id: string): string {
    const match = ARTIFACT_ID.exec(id);
    if (!match) throw new Error('Artifact id must be art_<64 lowercase hex>.');
    return match[1]!;
  }

  private objectPath(sha256: string): string {
    return join(this.objectsDir, sha256);
  }

  private metadataPath(sha256: string): string {
    return join(this.metadataDir, `${sha256}.json`);
  }

  private tryMetadata(id: string): ArtifactMetadata | null {
    try {
      return this.metadata(id);
    } catch {
      return null;
    }
  }

  private readMetadataFile(path: string): ArtifactMetadata | null {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as ArtifactMetadata;
      if (!ARTIFACT_ID.test(value.id) || value.sha256 !== value.id.slice(4)) return null;
      if (!Number.isSafeInteger(value.bytes) || value.bytes < 1) return null;
      return value;
    } catch {
      return null;
    }
  }

  private ensureGitignore(): void {
    const path = join(this.root, '.gitignore');
    if (!existsSync(path)) writeAtomic(path, '*\n!.gitignore\n');
    if (process.platform !== 'win32' && existsSync(this.root)) chmodSync(this.root, 0o700);
  }

  stats(): { count: number; bytes: number; maxArtifacts: number; maxTotalBytes: number } {
    const artifacts = this.list(1000, 0);
    return {
      count: artifacts.length,
      bytes: artifacts.reduce((sum, item) => sum + item.bytes, 0),
      maxArtifacts: this.maxArtifacts,
      maxTotalBytes: this.maxTotalBytes,
    };
  }
}
