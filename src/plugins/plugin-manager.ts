import {
  cpSync,
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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AdapterDef, RiskLevel } from '../core/types.js';
import type { SubOpRisk } from '../adapters/child-mcp/risk-map.js';

const MANIFEST_FILE = 'folderforge.plugin.json';
const REGISTRY_FILE = 'registry.json';
const MAX_FILES = 2000;
const MAX_BYTES = 50 * 1024 * 1024;
const RESERVED_IDS = new Set(['serena', 'playwright', 'desktopCommander', 'folderforge']);

export interface PluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  compatibility?: { folderforge?: string; mcpProtocol?: string };
  runtime: {
    command: string;
    args?: string[];
    facade?: boolean;
  };
  permissions?: {
    network?: boolean;
    filesystem?: 'none' | 'workspace' | 'external';
    env?: string[];
  };
  risk?: {
    default?: SubOpRisk;
    tools?: Record<string, SubOpRisk>;
  };
}

export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  source: string;
  installDir: string;
  installedAt: number;
  updatedAt: number;
  permissions: NonNullable<PluginManifest['permissions']>;
  compatibility: NonNullable<PluginManifest['compatibility']>;
  facade: boolean;
}

interface RegistryFile {
  schemaVersion: 1;
  plugins: InstalledPlugin[];
}

function parseVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersion(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

export function satisfiesFolderForgeRange(version: string, range = '*'): boolean {
  if (!range || range === '*') return true;
  const current = parseVersion(version);
  if (!current) return false;
  const trimmed = range.trim();
  if (trimmed.startsWith('>=')) {
    const target = parseVersion(trimmed.slice(2));
    return target !== null && compareVersion(current, target) >= 0;
  }
  if (trimmed.startsWith('^')) {
    const target = parseVersion(trimmed.slice(1));
    return target !== null && current[0] === target[0] && compareVersion(current, target) >= 0;
  }
  const target = parseVersion(trimmed);
  return target !== null && compareVersion(current, target) === 0;
}

function normalizeRisk(value: unknown, fallback: SubOpRisk): SubOpRisk {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  const allowed: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  return {
    risk: allowed.includes(record.risk as RiskLevel) ? (record.risk as RiskLevel) : fallback.risk,
    mutates: typeof record.mutates === 'boolean' ? record.mutates : fallback.mutates,
  };
}

function validateManifest(raw: unknown, currentVersion: string): PluginManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Plugin manifest must be an object.');
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1) throw new Error('Unsupported plugin schemaVersion; expected 1.');
  const id = String(value.id ?? '');
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(id) || RESERVED_IDS.has(id)) {
    throw new Error('Plugin id must be 2-63 lowercase letters/digits/hyphens and not reserved.');
  }
  const name = String(value.name ?? '').trim();
  const version = String(value.version ?? '').trim();
  if (!name) throw new Error('Plugin name is required.');
  if (!parseVersion(version)) throw new Error('Plugin version must be semantic x.y.z.');
  const runtime = value.runtime as Record<string, unknown> | undefined;
  if (!runtime || typeof runtime.command !== 'string' || !runtime.command.trim()) {
    throw new Error('Plugin runtime.command is required.');
  }
  const args = runtime.args === undefined ? [] : runtime.args;
  if (!Array.isArray(args) || !args.every((item) => typeof item === 'string')) {
    throw new Error('Plugin runtime.args must be an array of strings.');
  }
  const compatibility = (value.compatibility ?? {}) as Record<string, unknown>;
  const folderforge = String(compatibility.folderforge ?? '*');
  if (!satisfiesFolderForgeRange(currentVersion, folderforge)) {
    throw new Error(`Plugin requires FolderForge ${folderforge}; current version is ${currentVersion}.`);
  }
  const permissionsRaw = (value.permissions ?? {}) as Record<string, unknown>;
  const filesystem = permissionsRaw.filesystem ?? 'none';
  if (!['none', 'workspace', 'external'].includes(String(filesystem))) {
    throw new Error('permissions.filesystem must be none, workspace, or external.');
  }
  const env = permissionsRaw.env ?? [];
  if (!Array.isArray(env) || !env.every((item) => typeof item === 'string' && /^[A-Z_][A-Z0-9_]*$/i.test(item))) {
    throw new Error('permissions.env must contain valid environment variable names.');
  }
  const riskRaw = (value.risk ?? {}) as Record<string, unknown>;
  const fallback = normalizeRisk(riskRaw.default, { risk: 'MEDIUM', mutates: true });
  const toolsRaw = (riskRaw.tools ?? {}) as Record<string, unknown>;
  const tools = Object.fromEntries(Object.entries(toolsRaw).map(([tool, risk]) => [tool, normalizeRisk(risk, fallback)]));
  return {
    schemaVersion: 1,
    id,
    name,
    version,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    compatibility: {
      folderforge,
      ...(typeof compatibility.mcpProtocol === 'string' ? { mcpProtocol: compatibility.mcpProtocol } : {}),
    },
    runtime: { command: runtime.command, args: args as string[], facade: runtime.facade !== false },
    permissions: {
      network: permissionsRaw.network === true,
      filesystem: filesystem as 'none' | 'workspace' | 'external',
      env: env as string[],
    },
    risk: { default: fallback, tools },
  };
}

function assertCopyBudget(source: string): void {
  let files = 0;
  let bytes = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(dir, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Plugin packages may not contain symlinks: ${relative(source, path)}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        files++;
        bytes += stat.size;
        if (files > MAX_FILES || bytes > MAX_BYTES) throw new Error(`Plugin package exceeds ${MAX_FILES} files or ${MAX_BYTES} bytes.`);
      }
    }
  };
  walk(source);
}

export class PluginManager {
  readonly root: string;
  private registryPath: string;

  constructor(private projectRoot: string, private currentVersion: string) {
    this.root = join(projectRoot, '.folderforge', 'plugins');
    this.registryPath = join(this.root, REGISTRY_FILE);
  }

  list(): InstalledPlugin[] {
    return this.readRegistry().plugins.map((plugin) => ({ ...plugin }));
  }

  inspect(id: string): { installed: InstalledPlugin; manifest: PluginManifest } {
    const installed = this.require(id);
    return { installed, manifest: this.readManifest(installed.installDir) };
  }

  install(sourceDir: string, enabled = true): InstalledPlugin {
    const source = resolve(sourceDir);
    if (!statSync(source).isDirectory()) throw new Error('Plugin source must be a directory.');
    const manifest = this.readManifest(source);
    if (this.list().some((plugin) => plugin.id === manifest.id)) throw new Error(`Plugin already installed: ${manifest.id}`);
    assertCopyBudget(source);
    mkdirSync(this.root, { recursive: true });
    const destination = join(this.root, manifest.id);
    try {
      cpSync(source, destination, { recursive: true, filter: (path) => basename(path) !== '.git' });
    } catch (error) {
      rmSync(destination, { recursive: true, force: true });
      throw error;
    }
    const now = Date.now();
    const installed = this.toInstalled(manifest, source, destination, enabled, now, now);
    const registry = this.readRegistry();
    registry.plugins.push(installed);
    this.writeRegistry(registry);
    return installed;
  }

  update(id: string, sourceDir: string): InstalledPlugin {
    const current = this.require(id);
    const source = resolve(sourceDir);
    const manifest = this.readManifest(source);
    if (manifest.id !== id) throw new Error(`Update manifest id ${manifest.id} does not match ${id}.`);
    assertCopyBudget(source);
    const staging = `${current.installDir}.staging-${Date.now()}`;
    const backup = `${current.installDir}.backup-${Date.now()}`;
    cpSync(source, staging, { recursive: true, filter: (path) => basename(path) !== '.git' });
    renameSync(current.installDir, backup);
    try {
      renameSync(staging, current.installDir);
      rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      if (!existsSync(current.installDir) && existsSync(backup)) renameSync(backup, current.installDir);
      throw error;
    }
    const updated = this.toInstalled(manifest, source, current.installDir, current.enabled, current.installedAt, Date.now());
    const registry = this.readRegistry();
    registry.plugins = registry.plugins.map((plugin) => (plugin.id === id ? updated : plugin));
    this.writeRegistry(registry);
    return updated;
  }

  setEnabled(id: string, enabled: boolean): InstalledPlugin {
    const registry = this.readRegistry();
    const index = registry.plugins.findIndex((plugin) => plugin.id === id);
    if (index < 0) throw new Error(`Plugin not installed: ${id}`);
    registry.plugins[index] = { ...registry.plugins[index]!, enabled, updatedAt: Date.now() };
    this.writeRegistry(registry);
    return { ...registry.plugins[index]! };
  }

  uninstall(id: string): InstalledPlugin {
    const installed = this.require(id);
    rmSync(installed.installDir, { recursive: true, force: true });
    const registry = this.readRegistry();
    registry.plugins = registry.plugins.filter((plugin) => plugin.id !== id);
    this.writeRegistry(registry);
    return installed;
  }

  enabledAdapters(): Array<{ name: string; def: AdapterDef; riskDefault: SubOpRisk; riskMap: Record<string, SubOpRisk> }> {
    return this.list().filter((plugin) => plugin.enabled).map((plugin) => this.adapter(plugin.id));
  }

  adapter(id: string): { name: string; def: AdapterDef; riskDefault: SubOpRisk; riskMap: Record<string, SubOpRisk> } {
    const { installed, manifest } = this.inspect(id);
    const pluginDir = installed.installDir;
    let command = manifest.runtime.command;
    if (command.startsWith('./')) {
      command = resolve(pluginDir, command);
      const rel = relative(pluginDir, command);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Relative runtime.command escapes the plugin directory.');
      if (!existsSync(command)) throw new Error(`Plugin runtime command not found: ${command}`);
    } else if (command.includes(sep) || command.includes('/')) {
      throw new Error('runtime.command must be a bare executable name or a ./ path inside the plugin package.');
    }
    const substitute = (value: string): string => value.replaceAll('{pluginDir}', pluginDir).replaceAll('{projectRoot}', this.projectRoot);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    for (const name of manifest.permissions?.env ?? []) if (process.env[name] !== undefined) env[name] = process.env[name]!;
    return {
      name: manifest.id,
      def: {
        enabled: true,
        command,
        args: (manifest.runtime.args ?? []).map(substitute),
        env,
        cwd: pluginDir,
        inheritEnv: false,
        facade: manifest.runtime.facade !== false,
      },
      riskDefault: manifest.risk?.default ?? { risk: 'MEDIUM', mutates: true },
      riskMap: manifest.risk?.tools ?? {},
    };
  }

  private readManifest(directory: string): PluginManifest {
    const path = join(directory, MANIFEST_FILE);
    if (!existsSync(path)) throw new Error(`Missing ${MANIFEST_FILE}.`);
    return validateManifest(JSON.parse(readFileSync(path, 'utf8')), this.currentVersion);
  }

  private require(id: string): InstalledPlugin {
    const plugin = this.list().find((entry) => entry.id === id);
    if (!plugin) throw new Error(`Plugin not installed: ${id}`);
    return plugin;
  }

  private readRegistry(): RegistryFile {
    if (!existsSync(this.registryPath)) return { schemaVersion: 1, plugins: [] };
    const value = JSON.parse(readFileSync(this.registryPath, 'utf8')) as RegistryFile;
    if (value.schemaVersion !== 1 || !Array.isArray(value.plugins)) throw new Error('Invalid plugin registry.');
    return value;
  }

  private writeRegistry(registry: RegistryFile): void {
    mkdirSync(dirname(this.registryPath), { recursive: true });
    const ignorePath = join(this.root, '.gitignore');
    if (!existsSync(ignorePath)) writeFileSync(ignorePath, '*\n!.gitignore\n', 'utf8');
    const temp = `${this.registryPath}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, this.registryPath);
  }

  private toInstalled(manifest: PluginManifest, source: string, installDir: string, enabled: boolean, installedAt: number, updatedAt: number): InstalledPlugin {
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      ...(manifest.description ? { description: manifest.description } : {}),
      enabled,
      source,
      installDir,
      installedAt,
      updatedAt,
      permissions: manifest.permissions ?? {},
      compatibility: manifest.compatibility ?? {},
      facade: manifest.runtime.facade !== false,
    };
  }
}
