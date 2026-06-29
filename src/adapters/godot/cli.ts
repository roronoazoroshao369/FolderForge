import { execa } from 'execa';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';
import type { GodotConfig } from '../../core/types.js';

/**
 * Godot headless-CLI adapter (Step 1 - read tier).
 *
 * This is the **CLI channel** of the Godot integration: it shells out to
 * `godot --headless` for version/engine probes and parses Godot project files
 * (`project.godot`, `*.tscn`) directly on disk for the read-only tools. It does
 * NOT need a running game or the editor open.
 *
 * Design notes:
 *  - A missing Godot binary is a normal, recoverable state. Pure file reads
 *    (`readScene`, `readProjectSettings`, `listProjectFiles`, `readFile`) work
 *    without the binary because they parse files directly. Engine-only probes
 *    (`version`) return a structured "not available" error instead of throwing.
 *  - Every path is resolved and guarded to stay inside the Godot project root,
 *    mirroring how the rest of FolderForge sandboxes file access.
 *  - No global state: one instance per call is fine; construction is cheap.
 */

export interface GodotCliResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface GodotVersionInfo {
  available: boolean;
  version?: string;
  path: string;
}

export interface GodotProjectInfo {
  projectRoot: string;
  name: string | null;
  /** Raw config_version from project.godot, if present. */
  configVersion: number | null;
  mainScene: string | null;
  hasProjectFile: boolean;
}

export interface GodotSceneNode {
  name: string;
  type: string | null;
  parent: string | null;
  /** The instanced scene path (res://...) when this node is a scene instance. */
  instance: string | null;
}

export interface GodotSceneInfo {
  path: string;
  resPath: string;
  nodeCount: number;
  nodes: GodotSceneNode[];
  /** ext_resource entries referenced by the scene. */
  resources: Array<{ type: string | null; path: string | null; id: string | null }>;
}

export interface GodotProjectFile {
  path: string;
  resPath: string;
  size: number;
  kind: 'scene' | 'script' | 'resource' | 'asset' | 'other';
}

const KIND_BY_EXT: Record<string, GodotProjectFile['kind']> = {
  '.tscn': 'scene',
  '.scn': 'scene',
  '.gd': 'script',
  '.cs': 'script',
  '.tres': 'resource',
  '.res': 'resource',
  '.png': 'asset',
  '.jpg': 'asset',
  '.jpeg': 'asset',
  '.svg': 'asset',
  '.ogg': 'asset',
  '.wav': 'asset',
  '.mp3': 'asset',
  '.gltf': 'asset',
  '.glb': 'asset',
};

const DEFAULT_IGNORES = new Set(['.git', '.godot', '.import', 'node_modules']);

export class GodotCli {
  constructor(private readonly config: GodotConfig) {}

  /** Whether the Godot adapter is turned on in config. */
  isEnabled(): boolean {
    return this.config.enabled === true;
  }

  /**
   * Probe the Godot binary for its version. Returns `available: false` (not an
   * error) when the binary cannot be found or run, so callers can degrade
   * gracefully instead of treating a missing engine as a failure.
   */
  async version(timeoutMs = 15_000): Promise<GodotCliResult<GodotVersionInfo>> {
    const bin = this.config.godotPath || 'godot';
    try {
      const sub = await execa(bin, ['--headless', '--version'], {
        timeout: timeoutMs,
        reject: false,
      });
      if (sub.exitCode !== 0) {
        // Some Godot builds print the version and exit non-zero in headless
        // mode; trust stdout if it looks like a version string.
        const v = parseVersion(sub.stdout) ?? parseVersion(sub.stderr);
        if (v) return { ok: true, data: { available: true, version: v, path: bin } };
        return {
          ok: true,
          data: { available: false, path: bin },
        };
      }
      const version = parseVersion(sub.stdout) ?? (sub.stdout.trim() || undefined);
      return { ok: true, data: { available: true, ...(version ? { version } : {}), path: bin } };
    } catch {
      // ENOENT / spawn failure -> not available, but this is a normal state.
      return { ok: true, data: { available: false, path: bin } };
    }
  }

  /**
   * Read high-level project metadata by parsing `project.godot`. Works without
   * the Godot binary.
   */
  readProjectInfo(projectRoot: string): GodotCliResult<GodotProjectInfo> {
    const root = resolve(projectRoot);
    const projectFile = join(root, 'project.godot');
    if (!existsSync(projectFile)) {
      return {
        ok: true,
        data: {
          projectRoot: root,
          name: null,
          configVersion: null,
          mainScene: null,
          hasProjectFile: false,
        },
      };
    }
    const text = readFileSync(projectFile, 'utf8');
    return {
      ok: true,
      data: {
        projectRoot: root,
        name: matchValue(text, /config\/name\s*=\s*"([^"]*)"/),
        configVersion: numberOrNull(matchValue(text, /config_version\s*=\s*(\d+)/)),
        mainScene: matchValue(text, /run\/main_scene\s*=\s*"([^"]*)"/),
        hasProjectFile: true,
      },
    };
  }

  /**
   * Parse a `.tscn` scene file into a flat node list + ext_resource references.
   * Pure file read; no engine required. Only the text-based `.tscn` format is
   * supported (binary `.scn` returns a clear error).
   */
  readScene(projectRoot: string, scenePath: string): GodotCliResult<GodotSceneInfo> {
    const abs = this.safeResolve(projectRoot, scenePath);
    if (!abs.ok) return { ok: false, error: abs.error };
    const file = abs.path;
    if (!existsSync(file)) return { ok: false, error: `Scene not found: ${scenePath}` };
    if (file.endsWith('.scn')) {
      return { ok: false, error: 'Binary .scn scenes are not supported; provide a text .tscn file.' };
    }
    const text = readFileSync(file, 'utf8');

    const resources: GodotSceneInfo['resources'] = [];
    const extRe = /\[ext_resource\s+([^\]]*)\]/g;
    for (let m = extRe.exec(text); m; m = extRe.exec(text)) {
      const attrs = m[1] ?? '';
      resources.push({
        type: matchValue(attrs, /type="([^"]*)"/),
        path: matchValue(attrs, /path="([^"]*)"/),
        id: matchValue(attrs, /id="?([^"\s]+)"?/),
      });
    }

    const nodes: GodotSceneNode[] = [];
    const nodeRe = /\[node\s+([^\]]*)\]/g;
    for (let m = nodeRe.exec(text); m; m = nodeRe.exec(text)) {
      const attrs = m[1] ?? '';
      const name = matchValue(attrs, /name="([^"]*)"/);
      if (name === null) continue;
      nodes.push({
        name,
        type: matchValue(attrs, /type="([^"]*)"/),
        parent: matchValue(attrs, /parent="([^"]*)"/),
        instance: matchValue(attrs, /instance=ExtResource\(\s*"?([^")\s]+)"?\s*\)/),
      });
    }

    return {
      ok: true,
      data: {
        path: file,
        resPath: toResPath(projectRoot, file),
        nodeCount: nodes.length,
        nodes,
        resources,
      },
    };
  }

  /**
   * Read the full text of `project.godot` plus a parsed key list. Works without
   * the engine.
   */
  readProjectSettings(projectRoot: string): GodotCliResult<{ raw: string; sections: string[] }> {
    const root = resolve(projectRoot);
    const projectFile = join(root, 'project.godot');
    if (!existsSync(projectFile)) {
      return { ok: false, error: 'No project.godot found in the project root.' };
    }
    const raw = readFileSync(projectFile, 'utf8');
    const sections: string[] = [];
    const secRe = /^\[([^\]]+)\]\s*$/gm;
    for (let m = secRe.exec(raw); m; m = secRe.exec(raw)) {
      const s = m[1];
      if (s) sections.push(s);
    }
    return { ok: true, data: { raw, sections } };
  }

  /**
   * List project files (recursively), skipping VCS/import/cache dirs. Returns
   * res:// paths with a coarse kind classification.
   */
  listProjectFiles(projectRoot: string, subdir = ''): GodotCliResult<GodotProjectFile[]> {
    const base = this.safeResolve(projectRoot, subdir || '.');
    if (!base.ok) return { ok: false, error: base.error };
    const root = resolve(projectRoot);
    const out: GodotProjectFile[] = [];
    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (DEFAULT_IGNORES.has(entry)) continue;
        const full = join(dir, entry);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(full);
        } else if (st.isFile()) {
          const ext = extOf(entry);
          out.push({
            path: full,
            resPath: toResPath(root, full),
            size: st.size,
            kind: KIND_BY_EXT[ext] ?? 'other',
          });
        }
      }
    };
    walk(base.path);
    out.sort((a, b) => a.resPath.localeCompare(b.resPath));
    return { ok: true, data: out };
  }

  /** Read a UTF-8 text file from inside the project. */
  readFile(projectRoot: string, filePath: string, maxBytes = 200_000): GodotCliResult<{ resPath: string; content: string; truncated: boolean }> {
    const abs = this.safeResolve(projectRoot, filePath);
    if (!abs.ok) return { ok: false, error: abs.error };
    if (!existsSync(abs.path)) return { ok: false, error: `File not found: ${filePath}` };
    const buf = readFileSync(abs.path);
    const truncated = buf.length > maxBytes;
    return {
      ok: true,
      data: {
        resPath: toResPath(projectRoot, abs.path),
        content: buf.subarray(0, maxBytes).toString('utf8'),
        truncated,
      },
    };
  }

  /**
   * Resolve a project-relative or res:// path to an absolute path, refusing any
   * path that escapes the project root.
   */
  private safeResolve(projectRoot: string, p: string): { ok: true; path: string } | { ok: false; error: string } {
    const root = resolve(projectRoot);
    const stripped = p.startsWith('res://') ? p.slice('res://'.length) : p;
    const abs = resolve(root, stripped);
    const rel = relative(root, abs);
    if (rel === '') return { ok: true, path: abs };
    if (rel === '..' || rel.startsWith(`..${sep}`)) {
      return { ok: false, error: `Path escapes the project root: ${p}` };
    }
    return { ok: true, path: abs };
  }
}

function parseVersion(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = s.match(/\b(\d+\.\d+(?:\.\d+)?[^\s]*)\b/);
  return m ? m[1] : undefined;
}

function matchValue(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m && m[1] !== undefined ? m[1] : null;
}

function numberOrNull(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}

function toResPath(projectRoot: string, abs: string): string {
  const rel = relative(resolve(projectRoot), resolve(abs)).split(sep).join('/');
  return `res://${rel}`;
}
