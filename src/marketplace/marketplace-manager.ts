import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as tar from 'tar';
import {
  calculatePluginIntegrity,
  validatePluginManifest,
  type InstalledPlugin,
  type PluginManager,
  type PluginManifest,
} from '../plugins/plugin-manager.js';
import { canonicalJson, sha256 } from '../distributed/coordinator.js';

export type PublisherState = 'active' | 'revoked';
export type MarketplaceModerationState = 'listed' | 'yanked' | 'security-hold';

export interface MarketplacePublisherView {
  id: string;
  name: string;
  publicKeyFingerprint: string;
  state: PublisherState;
  createdAt: number;
  updatedAt: number;
  revokedAt?: number;
  revokeReason?: string;
}

interface MarketplacePublisherRecord extends MarketplacePublisherView {
  publicKeyPem: string;
}

export interface MarketplaceProvenance {
  repository: string;
  commit: string;
  workflow: string;
  sourceDigest: string;
  builder?: string;
}

export interface MarketplaceEntryPayload {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  publisherId: string;
  packageUrl: string;
  packageDigest: string;
  manifestDigest: string;
  sbomDigest: string;
  provenanceDigest: string;
  provenance: MarketplaceProvenance;
  compatibility: { folderforge: string; mcpProtocol?: string };
  permissions: { network: boolean; filesystem: 'none' | 'workspace' | 'external'; env: string[] };
  publishedAt: number;
}

export interface MarketplaceEntry extends MarketplaceEntryPayload {
  signature: string;
}

export interface MarketplaceEntryView extends MarketplaceEntry {
  publisher: MarketplacePublisherView;
  signatureValid: boolean;
  trusted: boolean;
  moderation: {
    state: MarketplaceModerationState;
    reason?: string;
    updatedAt?: number;
  };
  quarantine?: MarketplaceQuarantineRecord;
}

export interface MarketplaceScanFinding {
  code:
    | 'lifecycle-script'
    | 'symlink'
    | 'archive'
    | 'secret'
    | 'size'
    | 'manifest'
    | 'sbom'
    | 'provenance'
    | 'executable'
    | 'path';
  severity: 'info' | 'warning' | 'error';
  path?: string;
  message: string;
}

export interface MarketplaceScanReport {
  passed: boolean;
  files: number;
  bytes: number;
  executableFiles: number;
  findings: MarketplaceScanFinding[];
  manifest: PluginManifest;
  integrity: ReturnType<typeof calculatePluginIntegrity>;
  scannedAt: number;
}

export interface MarketplaceQuarantineRecord {
  key: string;
  entryId: string;
  version: string;
  packagePath: string;
  extractedDir: string;
  packageDigest: string;
  scan: MarketplaceScanReport;
  createdAt: number;
}

interface TrustStore {
  schemaVersion: 1;
  publishers: MarketplacePublisherRecord[];
}

interface IndexStore {
  schemaVersion: 1;
  entries: MarketplaceEntry[];
}

interface ModerationRecord {
  key: string;
  state: MarketplaceModerationState;
  reason?: string;
  updatedAt: number;
}

interface ModerationStore {
  schemaVersion: 1;
  records: ModerationRecord[];
}

interface QuarantineStore {
  schemaVersion: 1;
  records: MarketplaceQuarantineRecord[];
}

export interface MarketplaceManagerOptions {
  now?: () => number;
  secretScan?: (text: string) => Array<unknown>;
  maxIndexBytes?: number;
  maxPackageBytes?: number;
  maxExtractedBytes?: number;
  maxFiles?: number;
}

const PUBLISHER_ID = /^[a-z][a-z0-9-]{1,62}$/;
const PLUGIN_ID = /^[a-z][a-z0-9-]{1,62}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_TEXT_SCAN = 1024 * 1024;
const DEFAULT_MAX_INDEX = 5 * 1024 * 1024;
const DEFAULT_MAX_PACKAGE = 20 * 1024 * 1024;
const DEFAULT_MAX_EXTRACTED = 50 * 1024 * 1024;
const DEFAULT_MAX_FILES = 2000;
const NESTED_ARCHIVE_EXTENSIONS = new Set(['.tgz', '.gz', '.zip', '.7z', '.rar', '.bz2', '.xz', '.tar']);
const LIFECYCLE_SCRIPTS = new Set(['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly']);

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

function boundedString(value: unknown, label: string, max = 512): string {
  const text = String(value ?? '').trim();
  if (!text || Buffer.byteLength(text) > max || /\0/.test(text)) {
    throw new Error(`${label} must be a non-empty string up to ${max} bytes.`);
  }
  return text;
}

function publisherKey(publicKeyPem: string): { normalized: string; fingerprint: string } {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Publisher key must be Ed25519.');
  const normalized = key.export({ type: 'spki', format: 'pem' }).toString();
  return { normalized, fingerprint: sha256(key.export({ type: 'spki', format: 'der' })) };
}

function entryPayload(entry: MarketplaceEntry): MarketplaceEntryPayload {
  const { signature: _signature, ...payload } = entry;
  return payload;
}

export function signMarketplaceEntry(payload: MarketplaceEntryPayload, privateKeyPem: string): MarketplaceEntry {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Publisher private key must be Ed25519.');
  return {
    ...payload,
    signature: cryptoSign(null, Buffer.from(canonicalJson(payload)), key).toString('base64url'),
  };
}

export function verifyMarketplaceEntry(entry: MarketplaceEntry, publicKeyPem: string): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(canonicalJson(entryPayload(entry))),
      createPublicKey(publicKeyPem),
      Buffer.from(entry.signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

function normalizeFileUrlOrPath(value: string): { kind: 'file'; path: string } | { kind: 'https'; url: URL } {
  if (/^https:\/\//i.test(value)) return { kind: 'https', url: new URL(value) };
  if (/^file:\/\//i.test(value)) return { kind: 'file', path: fileURLToPath(new URL(value)) };
  if (/^[a-z]+:\/\//i.test(value)) throw new Error('Marketplace URLs must use HTTPS or file://.');
  return { kind: 'file', path: resolve(value) };
}

function publicPublisher(record: MarketplacePublisherRecord): MarketplacePublisherView {
  const { publicKeyPem: _publicKeyPem, ...view } = record;
  return JSON.parse(JSON.stringify(view)) as MarketplacePublisherView;
}

function keyFor(id: string, version: string): string {
  return `${id}@${version}`;
}

function validateEntryShape(value: unknown): MarketplaceEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Marketplace entry must be an object.');
  const entry = value as MarketplaceEntry;
  if (entry.schemaVersion !== 1) throw new Error('Unsupported marketplace entry schemaVersion.');
  if (!PLUGIN_ID.test(entry.id)) throw new Error(`Invalid plugin id: ${entry.id}`);
  if (!SEMVER.test(entry.version)) throw new Error(`Invalid plugin version: ${entry.version}`);
  boundedString(entry.name, 'entry.name', 256);
  if (!PUBLISHER_ID.test(entry.publisherId)) throw new Error(`Invalid publisher id: ${entry.publisherId}`);
  normalizeFileUrlOrPath(boundedString(entry.packageUrl, 'entry.packageUrl', 4096));
  for (const [label, digest] of [
    ['packageDigest', entry.packageDigest],
    ['manifestDigest', entry.manifestDigest],
    ['sbomDigest', entry.sbomDigest],
    ['provenanceDigest', entry.provenanceDigest],
  ]) {
    if (!HASH.test(String(digest))) throw new Error(`${label} must be SHA-256 hex.`);
  }
  if (!entry.provenance || !HASH.test(entry.provenance.sourceDigest)) {
    throw new Error('Marketplace entry requires provenance with a sourceDigest.');
  }
  if (!/^[a-f0-9]{40,64}$/i.test(entry.provenance.commit)) throw new Error('Provenance commit must be a Git commit hash.');
  boundedString(entry.provenance.repository, 'provenance.repository', 2048);
  boundedString(entry.provenance.workflow, 'provenance.workflow', 512);
  if (!entry.compatibility || typeof entry.compatibility.folderforge !== 'string') {
    throw new Error('Marketplace entry requires FolderForge compatibility.');
  }
  if (!entry.permissions || !['none', 'workspace', 'external'].includes(entry.permissions.filesystem)) {
    throw new Error('Marketplace entry permissions are invalid.');
  }
  if (!Array.isArray(entry.permissions.env) || !entry.permissions.env.every((item) => typeof item === 'string')) {
    throw new Error('Marketplace entry permissions.env is invalid.');
  }
  if (!Number.isSafeInteger(entry.publishedAt) || entry.publishedAt < 1) throw new Error('Invalid publishedAt.');
  boundedString(entry.signature, 'entry.signature', 2048);
  return JSON.parse(JSON.stringify(entry)) as MarketplaceEntry;
}

export class MarketplaceManager {
  readonly root: string;
  private readonly trustPath: string;
  private readonly indexPath: string;
  private readonly moderationPath: string;
  private readonly quarantinePath: string;
  private readonly quarantineDir: string;
  private readonly now: () => number;
  private readonly secretScan: (text: string) => Array<unknown>;
  private readonly maxIndexBytes: number;
  private readonly maxPackageBytes: number;
  private readonly maxExtractedBytes: number;
  private readonly maxFiles: number;

  constructor(
    projectRoot: string,
    private readonly currentVersion: string,
    private readonly plugins: PluginManager,
    options: MarketplaceManagerOptions = {},
  ) {
    this.root = join(projectRoot, '.folderforge', 'marketplace');
    this.trustPath = join(this.root, 'publishers.json');
    this.indexPath = join(this.root, 'index.json');
    this.moderationPath = join(this.root, 'moderation.json');
    this.quarantinePath = join(this.root, 'quarantine.json');
    this.quarantineDir = join(this.root, 'quarantine');
    this.now = options.now ?? Date.now;
    this.secretScan = options.secretScan ?? (() => []);
    this.maxIndexBytes = options.maxIndexBytes ?? DEFAULT_MAX_INDEX;
    this.maxPackageBytes = options.maxPackageBytes ?? DEFAULT_MAX_PACKAGE;
    this.maxExtractedBytes = options.maxExtractedBytes ?? DEFAULT_MAX_EXTRACTED;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  }

  addPublisher(input: { id: string; name: string; publicKeyPem: string }): MarketplacePublisherView {
    const id = boundedString(input.id, 'publisher id', 63);
    if (!PUBLISHER_ID.test(id)) throw new Error('Publisher id must be 2-63 lowercase letters/digits/hyphens.');
    const name = boundedString(input.name, 'publisher name', 128);
    const key = publisherKey(boundedString(input.publicKeyPem, 'publisher public key', 16_384));
    const trust = this.readTrust();
    if (trust.publishers.some((publisher) => publisher.id === id)) throw new Error(`Publisher already exists: ${id}`);
    if (trust.publishers.some((publisher) => publisher.publicKeyFingerprint === key.fingerprint)) {
      throw new Error('Publisher public key is already registered.');
    }
    const now = this.now();
    const record: MarketplacePublisherRecord = {
      id,
      name,
      publicKeyPem: key.normalized,
      publicKeyFingerprint: key.fingerprint,
      state: 'active',
      createdAt: now,
      updatedAt: now,
    };
    trust.publishers.push(record);
    this.writeTrust(trust);
    return publicPublisher(record);
  }

  revokePublisher(id: string, reason = 'Revoked by operator.'): MarketplacePublisherView {
    const trust = this.readTrust();
    const record = trust.publishers.find((publisher) => publisher.id === id);
    if (!record) throw new Error(`Publisher not found: ${id}`);
    const now = this.now();
    record.state = 'revoked';
    record.revokedAt = now;
    record.revokeReason = boundedString(reason, 'revoke reason', 1000);
    record.updatedAt = now;
    this.writeTrust(trust);
    return publicPublisher(record);
  }

  listPublishers(): MarketplacePublisherView[] {
    return this.readTrust().publishers.map(publicPublisher).sort((a, b) => a.id.localeCompare(b.id));
  }

  async createPackage(input: {
    sourceDir: string;
    outputFile: string;
    packageUrl?: string;
    publisherId: string;
    privateKeyPem: string;
    provenance: MarketplaceProvenance;
    publishedAt?: number;
  }): Promise<{ entry: MarketplaceEntry; packagePath: string; scan: MarketplaceScanReport }> {
    const source = resolve(input.sourceDir);
    if (!statSync(source).isDirectory()) throw new Error('Marketplace package source must be a directory.');
    const publisher = this.requireActivePublisher(input.publisherId);
    const key = createPrivateKey(input.privateKeyPem);
    const derived = createPublicKey(key).export({ type: 'spki', format: 'der' });
    if (sha256(derived) !== publisher.publicKeyFingerprint) throw new Error('Publisher private key does not match the trusted identity.');
    const scan = this.scanDirectory(source);
    if (!scan.passed) throw new Error('Package source failed marketplace scanning.');
    const output = resolve(input.outputFile);
    mkdirSync(dirname(output), { recursive: true });
    const files = this.walkRelative(source).sort();
    await tar.c({ gzip: true, cwd: source, file: output, portable: true, noMtime: true }, files);
    const packageBytes = readFileSync(output);
    if (packageBytes.byteLength > this.maxPackageBytes) throw new Error(`Package exceeds ${this.maxPackageBytes} bytes.`);
    const manifestPath = join(source, 'folderforge.plugin.json');
    const sbomPath = join(source, 'sbom.cdx.json');
    const provenancePath = join(source, 'provenance.json');
    const manifest = scan.manifest;
    const provenanceBytes = readFileSync(provenancePath);
    const declaredProvenance = JSON.parse(provenanceBytes.toString('utf8')) as MarketplaceProvenance;
    if (canonicalJson(declaredProvenance) !== canonicalJson(input.provenance)) {
      throw new Error('provenance.json does not match the signed provenance input.');
    }
    const payload: MarketplaceEntryPayload = {
      schemaVersion: 1,
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      ...(manifest.description ? { description: manifest.description } : {}),
      publisherId: publisher.id,
      packageUrl: input.packageUrl ?? pathToFileURL(output).toString(),
      packageDigest: sha256(packageBytes),
      manifestDigest: sha256(readFileSync(manifestPath)),
      sbomDigest: sha256(readFileSync(sbomPath)),
      provenanceDigest: sha256(provenanceBytes),
      provenance: input.provenance,
      compatibility: {
        folderforge: manifest.compatibility?.folderforge ?? '*',
        ...(manifest.compatibility?.mcpProtocol ? { mcpProtocol: manifest.compatibility.mcpProtocol } : {}),
      },
      permissions: {
        network: manifest.permissions?.network === true,
        filesystem: manifest.permissions?.filesystem ?? 'none',
        env: [...(manifest.permissions?.env ?? [])].sort(),
      },
      publishedAt: input.publishedAt ?? this.now(),
    };
    const entry = signMarketplaceEntry(payload, input.privateKeyPem);
    this.importEntries([entry]);
    return { entry, packagePath: output, scan };
  }

  async syncIndex(source: string, expectedSha256?: string): Promise<{ imported: number; unchanged: number; digest: string }> {
    const bytes = await this.readBoundedSource(source, this.maxIndexBytes);
    const digest = sha256(bytes);
    if (expectedSha256 !== undefined && digest !== expectedSha256) throw new Error('Marketplace index digest mismatch.');
    const value = JSON.parse(bytes.toString('utf8')) as { schemaVersion?: unknown; entries?: unknown };
    if (value.schemaVersion !== 1 || !Array.isArray(value.entries)) throw new Error('Marketplace index must use schemaVersion 1 and entries[].');
    const before = this.readIndex().entries.length;
    const imported = this.importEntries(value.entries);
    return { imported, unchanged: value.entries.length - imported, digest, ...(before ? {} : {}) };
  }

  exportIndex(): IndexStore {
    return this.readIndex();
  }

  list(query = ''): MarketplaceEntryView[] {
    const normalized = query.trim().toLowerCase();
    return this.readIndex().entries
      .map((entry) => this.viewEntry(entry))
      .filter((entry) => !normalized || [entry.id, entry.name, entry.description ?? '', entry.publisherId].join(' ').toLowerCase().includes(normalized))
      .sort((a, b) => a.id.localeCompare(b.id) || b.version.localeCompare(a.version));
  }

  inspect(id: string, version: string): MarketplaceEntryView {
    return this.viewEntry(this.requireEntry(id, version));
  }

  moderate(id: string, version: string, state: MarketplaceModerationState, reason?: string): MarketplaceEntryView {
    if (!['listed', 'yanked', 'security-hold'].includes(state)) throw new Error('Invalid moderation state.');
    this.requireEntry(id, version);
    const store = this.readModeration();
    const key = keyFor(id, version);
    const now = this.now();
    const next: ModerationRecord = {
      key,
      state,
      updatedAt: now,
      ...(reason ? { reason: boundedString(reason, 'moderation reason', 2000) } : {}),
    };
    const index = store.records.findIndex((record) => record.key === key);
    if (index >= 0) store.records[index] = next;
    else store.records.push(next);
    this.writeModeration(store);
    return this.inspect(id, version);
  }

  async quarantine(id: string, version: string): Promise<MarketplaceQuarantineRecord> {
    const entry = this.requireInstallableEntry(id, version);
    const bytes = await this.readBoundedSource(entry.packageUrl, this.maxPackageBytes);
    const digest = sha256(bytes);
    if (digest !== entry.packageDigest) throw new Error('Marketplace package digest mismatch.');
    const key = keyFor(id, version);
    const safe = key.replaceAll('@', '-');
    mkdirSync(this.quarantineDir, { recursive: true, mode: 0o700 });
    const packagePath = join(this.quarantineDir, `${safe}.tgz`);
    const staging = join(this.quarantineDir, `${safe}.staging-${process.pid}-${Date.now()}`);
    const extractedRoot = join(this.quarantineDir, safe);
    rmSync(staging, { recursive: true, force: true });
    rmSync(extractedRoot, { recursive: true, force: true });
    writeFileSync(packagePath, bytes, { mode: 0o600 });
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    let entries = 0;
    let bytesDeclared = 0;
    await tar.x({
      file: packagePath,
      cwd: staging,
      strict: true,
      preservePaths: false,
      onentry: (tarEntry) => {
        entries += 1;
        bytesDeclared += Number(tarEntry.size ?? 0);
        const path = String(tarEntry.path).replaceAll('\\', '/');
        const type = String(tarEntry.type ?? '');
        if (entries > this.maxFiles || bytesDeclared > this.maxExtractedBytes) {
          throw new Error('Marketplace archive exceeds extraction budget.');
        }
        if (path.startsWith('/') || path.split('/').includes('..') || /\0/.test(path)) {
          throw new Error(`Unsafe archive path: ${path}`);
        }
        if (/SymbolicLink|Link|CharacterDevice|BlockDevice|FIFO/i.test(type)) {
          throw new Error(`Unsafe archive entry type ${type}: ${path}`);
        }
      },
    });
    const packageRoot = this.findPackageRoot(staging);
    const scan = this.scanDirectory(packageRoot);
    if (scan.manifest.id !== id || scan.manifest.version !== version) {
      scan.findings.push({ code: 'manifest', severity: 'error', message: 'Extracted manifest identity/version does not match the signed marketplace entry.' });
      scan.passed = false;
    }
    if (sha256(readFileSync(join(packageRoot, 'folderforge.plugin.json'))) !== entry.manifestDigest) {
      scan.findings.push({ code: 'manifest', severity: 'error', message: 'Manifest digest does not match the signed entry.' });
      scan.passed = false;
    }
    if (sha256(readFileSync(join(packageRoot, 'sbom.cdx.json'))) !== entry.sbomDigest) {
      scan.findings.push({ code: 'sbom', severity: 'error', message: 'SBOM digest does not match the signed entry.' });
      scan.passed = false;
    }
    if (sha256(readFileSync(join(packageRoot, 'provenance.json'))) !== entry.provenanceDigest) {
      scan.findings.push({ code: 'provenance', severity: 'error', message: 'Provenance digest does not match the signed entry.' });
      scan.passed = false;
    }
    const provenance = JSON.parse(readFileSync(join(packageRoot, 'provenance.json'), 'utf8')) as MarketplaceProvenance;
    if (canonicalJson(provenance) !== canonicalJson(entry.provenance)) {
      scan.findings.push({ code: 'provenance', severity: 'error', message: 'Provenance content does not match the signed entry.' });
      scan.passed = false;
    }
    renameSync(packageRoot, extractedRoot);
    rmSync(staging, { recursive: true, force: true });
    const record: MarketplaceQuarantineRecord = {
      key,
      entryId: id,
      version,
      packagePath,
      extractedDir: extractedRoot,
      packageDigest: digest,
      scan,
      createdAt: this.now(),
    };
    const store = this.readQuarantine();
    store.records = store.records.filter((item) => item.key !== key);
    store.records.push(record);
    this.writeQuarantine(store);
    return JSON.parse(JSON.stringify(record)) as MarketplaceQuarantineRecord;
  }

  install(id: string, version: string): InstalledPlugin {
    const entry = this.requireInstallableEntry(id, version);
    const quarantine = this.readQuarantine().records.find((record) => record.key === keyFor(id, version));
    if (!quarantine || !quarantine.scan.passed) throw new Error('Package must pass quarantine scanning before installation.');
    if (quarantine.packageDigest !== entry.packageDigest) throw new Error('Quarantine record digest no longer matches the marketplace entry.');
    const currentScan = this.scanDirectory(quarantine.extractedDir);
    if (!currentScan.passed) throw new Error('Quarantined package no longer passes marketplace scanning.');
    if (canonicalJson(currentScan.integrity) !== canonicalJson(quarantine.scan.integrity)) {
      throw new Error('Quarantined package contents changed after scanning; quarantine it again.');
    }
    const installed = this.plugins.install(quarantine.extractedDir, false);
    if (installed.id !== id || installed.version !== version) {
      try { this.plugins.uninstall(installed.id); } catch { /* preserve mismatch */ }
      throw new Error('Installed plugin identity/version differs from the marketplace entry.');
    }
    return installed;
  }

  scanDirectory(directory: string): MarketplaceScanReport {
    const root = resolve(directory);
    const findings: MarketplaceScanFinding[] = [];
    let files = 0;
    let bytes = 0;
    let executableFiles = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const path = join(dir, entry.name);
        const rel = relative(root, path).split(sep).join('/');
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) {
          findings.push({ code: 'symlink', severity: 'error', path: rel, message: 'Plugin packages may not contain symlinks.' });
          continue;
        }
        if (stat.isDirectory()) {
          walk(path);
          continue;
        }
        if (!stat.isFile()) {
          findings.push({ code: 'path', severity: 'error', path: rel, message: 'Only regular files and directories are allowed.' });
          continue;
        }
        files += 1;
        bytes += stat.size;
        if (files > this.maxFiles || bytes > this.maxExtractedBytes) {
          findings.push({ code: 'size', severity: 'error', path: rel, message: 'Package exceeds file-count or extracted-byte budget.' });
          continue;
        }
        if ((stat.mode & 0o111) !== 0) {
          executableFiles += 1;
          findings.push({ code: 'executable', severity: 'info', path: rel, message: 'Executable file present; runtime remains sandbox/policy governed.' });
        }
        if (NESTED_ARCHIVE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          findings.push({ code: 'archive', severity: 'error', path: rel, message: 'Nested archives are rejected to avoid hidden payloads/archive bombs.' });
        }
        if (stat.size <= MAX_TEXT_SCAN && !this.looksBinary(path)) {
          const text = readFileSync(path, 'utf8');
          const secretFindings = this.secretScan(text);
          if (secretFindings.length > 0) {
            findings.push({ code: 'secret', severity: 'error', path: rel, message: `Detected ${secretFindings.length} possible secret(s).` });
          }
        }
      }
    };
    walk(root);

    const manifestPath = join(root, 'folderforge.plugin.json');
    const sbomPath = join(root, 'sbom.cdx.json');
    const provenancePath = join(root, 'provenance.json');
    if (!existsSync(manifestPath)) findings.push({ code: 'manifest', severity: 'error', message: 'Missing folderforge.plugin.json.' });
    if (!existsSync(sbomPath)) findings.push({ code: 'sbom', severity: 'error', message: 'Missing sbom.cdx.json.' });
    if (!existsSync(provenancePath)) findings.push({ code: 'provenance', severity: 'error', message: 'Missing provenance.json.' });

    let manifest: PluginManifest;
    try {
      manifest = validatePluginManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), this.currentVersion);
    } catch (error) {
      findings.push({ code: 'manifest', severity: 'error', message: `Manifest validation failed: ${String(error)}` });
      manifest = {
        schemaVersion: 1,
        id: 'invalid-plugin',
        name: 'Invalid plugin',
        version: '0.0.0',
        runtime: { command: 'invalid' },
      };
    }

    const packageJsonPath = join(root, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, unknown> };
        for (const script of Object.keys(packageJson.scripts ?? {})) {
          if (LIFECYCLE_SCRIPTS.has(script)) {
            findings.push({ code: 'lifecycle-script', severity: 'error', path: 'package.json', message: `Lifecycle script is not allowed in marketplace packages: ${script}` });
          }
        }
      } catch (error) {
        findings.push({ code: 'manifest', severity: 'error', path: 'package.json', message: `Invalid package.json: ${String(error)}` });
      }
    }

    for (const [path, code] of [[sbomPath, 'sbom'], [provenancePath, 'provenance']] as const) {
      if (!existsSync(path)) continue;
      try { JSON.parse(readFileSync(path, 'utf8')); }
      catch (error) { findings.push({ code, severity: 'error', path: basename(path), message: `Invalid JSON: ${String(error)}` }); }
    }
    let integrity: ReturnType<typeof calculatePluginIntegrity>;
    try {
      integrity = calculatePluginIntegrity(root);
    } catch (error) {
      findings.push({ code: 'path', severity: 'error', message: `Integrity scan failed: ${String(error)}` });
      integrity = { algorithm: 'sha256', digest: '0'.repeat(64), files, bytes };
    }
    return {
      passed: !findings.some((finding) => finding.severity === 'error'),
      files,
      bytes,
      executableFiles,
      findings,
      manifest,
      integrity,
      scannedAt: this.now(),
    };
  }

  private importEntries(values: unknown[]): number {
    const trust = this.readTrust();
    const index = this.readIndex();
    let imported = 0;
    for (const raw of values) {
      const entry = validateEntryShape(raw);
      const publisher = trust.publishers.find((candidate) => candidate.id === entry.publisherId);
      if (!publisher) throw new Error(`Unknown marketplace publisher: ${entry.publisherId}`);
      if (publisher.state !== 'active') throw new Error(`Marketplace publisher is revoked: ${entry.publisherId}`);
      if (!verifyMarketplaceEntry(entry, publisher.publicKeyPem)) throw new Error(`Invalid marketplace entry signature: ${keyFor(entry.id, entry.version)}`);
      const key = keyFor(entry.id, entry.version);
      const existing = index.entries.find((candidate) => keyFor(candidate.id, candidate.version) === key);
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(entry)) throw new Error(`Immutable marketplace version conflict: ${key}`);
        continue;
      }
      index.entries.push(entry);
      imported += 1;
    }
    if (imported > 0) this.writeIndex(index);
    return imported;
  }

  private viewEntry(entry: MarketplaceEntry): MarketplaceEntryView {
    const trust = this.readTrust();
    const publisher = trust.publishers.find((candidate) => candidate.id === entry.publisherId);
    if (!publisher) throw new Error(`Publisher not found for entry: ${entry.publisherId}`);
    const signatureValid = verifyMarketplaceEntry(entry, publisher.publicKeyPem);
    const moderation = this.readModeration().records.find((record) => record.key === keyFor(entry.id, entry.version));
    const quarantine = this.readQuarantine().records.find((record) => record.key === keyFor(entry.id, entry.version));
    return {
      ...entry,
      publisher: publicPublisher(publisher),
      signatureValid,
      trusted: signatureValid && publisher.state === 'active' && (moderation?.state ?? 'listed') === 'listed',
      moderation: moderation
        ? { state: moderation.state, ...(moderation.reason ? { reason: moderation.reason } : {}), updatedAt: moderation.updatedAt }
        : { state: 'listed' },
      ...(quarantine ? { quarantine: JSON.parse(JSON.stringify(quarantine)) as MarketplaceQuarantineRecord } : {}),
    };
  }

  private requireInstallableEntry(id: string, version: string): MarketplaceEntry {
    const view = this.inspect(id, version);
    if (!view.signatureValid) throw new Error('Marketplace entry signature is invalid.');
    if (view.publisher.state !== 'active') throw new Error('Marketplace publisher is revoked.');
    if (view.moderation.state !== 'listed') throw new Error(`Marketplace entry is ${view.moderation.state}.`);
    return this.requireEntry(id, version);
  }

  private requireEntry(id: string, version: string): MarketplaceEntry {
    if (!PLUGIN_ID.test(id) || !SEMVER.test(version)) throw new Error('Invalid marketplace id or version.');
    const entry = this.readIndex().entries.find((candidate) => candidate.id === id && candidate.version === version);
    if (!entry) throw new Error(`Marketplace entry not found: ${keyFor(id, version)}`);
    return entry;
  }

  private requireActivePublisher(id: string): MarketplacePublisherRecord {
    const publisher = this.readTrust().publishers.find((candidate) => candidate.id === id);
    if (!publisher) throw new Error(`Publisher not found: ${id}`);
    if (publisher.state !== 'active') throw new Error(`Publisher is revoked: ${id}`);
    return publisher;
  }

  private async readBoundedSource(source: string, maxBytes: number): Promise<Buffer> {
    const resolved = normalizeFileUrlOrPath(source);
    if (resolved.kind === 'file') {
      const stat = statSync(resolved.path);
      if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Marketplace source exceeds ${maxBytes} bytes or is not a file.`);
      return readFileSync(resolved.path);
    }
    const response = await fetch(resolved.url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Marketplace fetch failed: HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > maxBytes) throw new Error(`Marketplace response exceeds ${maxBytes} bytes.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`Marketplace response exceeds ${maxBytes} bytes.`);
    return bytes;
  }

  private findPackageRoot(staging: string): string {
    if (existsSync(join(staging, 'folderforge.plugin.json'))) return staging;
    const directories = readdirSync(staging, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const files = readdirSync(staging, { withFileTypes: true }).filter((entry) => entry.isFile());
    if (files.length === 0 && directories.length === 1) {
      const candidate = join(staging, directories[0]!.name);
      if (existsSync(join(candidate, 'folderforge.plugin.json'))) return candidate;
    }
    throw new Error('Marketplace archive must contain folderforge.plugin.json at root or under one top-level directory.');
  }

  private walkRelative(root: string): string[] {
    const output: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === '.git') continue;
        const path = join(dir, entry.name);
        const rel = relative(root, path).split(sep).join('/');
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error(`Package source contains a symlink: ${rel}`);
        if (stat.isDirectory()) walk(path);
        else if (stat.isFile()) output.push(rel);
        else throw new Error(`Package source contains an unsupported entry: ${rel}`);
      }
    };
    walk(root);
    return output;
  }

  private looksBinary(path: string): boolean {
    const content = readFileSync(path);
    return content.subarray(0, Math.min(content.length, 8192)).includes(0);
  }

  private ensureRoot(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
    const ignore = join(this.root, '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n!.gitignore\n', { mode: 0o600 });
  }

  private readTrust(): TrustStore {
    this.ensureRoot();
    if (!existsSync(this.trustPath)) return { schemaVersion: 1, publishers: [] };
    const value = JSON.parse(readFileSync(this.trustPath, 'utf8')) as TrustStore;
    if (value.schemaVersion !== 1 || !Array.isArray(value.publishers)) throw new Error('Invalid marketplace publisher store.');
    return value;
  }

  private writeTrust(value: TrustStore): void { this.ensureRoot(); atomicJson(this.trustPath, value); }

  private readIndex(): IndexStore {
    this.ensureRoot();
    if (!existsSync(this.indexPath)) return { schemaVersion: 1, entries: [] };
    const value = JSON.parse(readFileSync(this.indexPath, 'utf8')) as IndexStore;
    if (value.schemaVersion !== 1 || !Array.isArray(value.entries)) throw new Error('Invalid marketplace index store.');
    return value;
  }

  private writeIndex(value: IndexStore): void { this.ensureRoot(); atomicJson(this.indexPath, value); }

  private readModeration(): ModerationStore {
    this.ensureRoot();
    if (!existsSync(this.moderationPath)) return { schemaVersion: 1, records: [] };
    const value = JSON.parse(readFileSync(this.moderationPath, 'utf8')) as ModerationStore;
    if (value.schemaVersion !== 1 || !Array.isArray(value.records)) throw new Error('Invalid marketplace moderation store.');
    return value;
  }

  private writeModeration(value: ModerationStore): void { this.ensureRoot(); atomicJson(this.moderationPath, value); }

  private readQuarantine(): QuarantineStore {
    this.ensureRoot();
    if (!existsSync(this.quarantinePath)) return { schemaVersion: 1, records: [] };
    const value = JSON.parse(readFileSync(this.quarantinePath, 'utf8')) as QuarantineStore;
    if (value.schemaVersion !== 1 || !Array.isArray(value.records)) throw new Error('Invalid marketplace quarantine store.');
    return value;
  }

  private writeQuarantine(value: QuarantineStore): void { this.ensureRoot(); atomicJson(this.quarantinePath, value); }
}
