import { execa } from 'execa';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  renameSync,
} from 'node:fs';
import { resolve, join, relative, sep, dirname } from 'node:path';
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

  // -------------------------------------------------------------------------
  // Step 2 - headless edit tier. All of these mutate files on disk inside the
  // project root (guarded by safeResolve). They are text-based edits to the
  // Godot `.tscn` / `project.godot` / source files, so they need no running
  // engine or editor. Risk bands (HIGH, plus CRITICAL for delete/script) are
  // declared in src/policy/risk.ts and gated by the normal pipeline.
  // -------------------------------------------------------------------------

  /** Write a UTF-8 text file, creating parent dirs. Refuses to clobber unless overwrite. */
  writeFile(
    projectRoot: string,
    filePath: string,
    content: string,
    overwrite = true
  ): GodotCliResult<{ resPath: string; bytes: number; created: boolean }> {
    const abs = this.safeResolve(projectRoot, filePath);
    if (!abs.ok) return { ok: false, error: abs.error };
    const existed = existsSync(abs.path);
    if (existed && !overwrite) {
      return { ok: false, error: `File exists (pass overwrite=true to replace): ${filePath}` };
    }
    mkdirSync(dirname(abs.path), { recursive: true });
    writeFileSync(abs.path, content, 'utf8');
    return {
      ok: true,
      data: { resPath: toResPath(projectRoot, abs.path), bytes: Buffer.byteLength(content), created: !existed },
    };
  }

  /** Delete a file (CRITICAL). Refuses directories to avoid mass deletion. */
  deleteFile(projectRoot: string, filePath: string): GodotCliResult<{ resPath: string }> {
    const abs = this.safeResolve(projectRoot, filePath);
    if (!abs.ok) return { ok: false, error: abs.error };
    if (!existsSync(abs.path)) return { ok: false, error: `File not found: ${filePath}` };
    if (statSync(abs.path).isDirectory()) {
      return { ok: false, error: `Refusing to delete a directory: ${filePath}` };
    }
    rmSync(abs.path);
    return { ok: true, data: { resPath: toResPath(projectRoot, abs.path) } };
  }

  /** Create a directory (recursive). */
  createDirectory(projectRoot: string, dirPath: string): GodotCliResult<{ resPath: string; created: boolean }> {
    const abs = this.safeResolve(projectRoot, dirPath);
    if (!abs.ok) return { ok: false, error: abs.error };
    const existed = existsSync(abs.path);
    mkdirSync(abs.path, { recursive: true });
    return { ok: true, data: { resPath: toResPath(projectRoot, abs.path), created: !existed } };
  }

  /** Rename/move a file inside the project. Refuses to clobber unless overwrite. */
  renameFile(
    projectRoot: string,
    from: string,
    to: string,
    overwrite = false
  ): GodotCliResult<{ from: string; to: string }> {
    const src = this.safeResolve(projectRoot, from);
    if (!src.ok) return { ok: false, error: src.error };
    const dst = this.safeResolve(projectRoot, to);
    if (!dst.ok) return { ok: false, error: dst.error };
    if (!existsSync(src.path)) return { ok: false, error: `Source not found: ${from}` };
    if (existsSync(dst.path) && !overwrite) {
      return { ok: false, error: `Destination exists (pass overwrite=true): ${to}` };
    }
    mkdirSync(dirname(dst.path), { recursive: true });
    renameSync(src.path, dst.path);
    return {
      ok: true,
      data: { from: toResPath(projectRoot, src.path), to: toResPath(projectRoot, dst.path) },
    };
  }

  /**
   * Create a new `.tscn` scene with a single root node. Refuses to clobber
   * unless overwrite. The format is the minimal valid text scene Godot 4 emits.
   */
  createScene(
    projectRoot: string,
    scenePath: string,
    rootName = 'Root',
    rootType = 'Node',
    overwrite = false
  ): GodotCliResult<{ resPath: string }> {
    const abs = this.safeResolve(projectRoot, scenePath);
    if (!abs.ok) return { ok: false, error: abs.error };
    if (!abs.path.endsWith('.tscn')) {
      return { ok: false, error: 'Scene path must end in .tscn' };
    }
    if (existsSync(abs.path) && !overwrite) {
      return { ok: false, error: `Scene exists (pass overwrite=true): ${scenePath}` };
    }
    const body = `[gd_scene format=3]\n\n[node name="${rootName}" type="${rootType}"]\n`;
    mkdirSync(dirname(abs.path), { recursive: true });
    writeFileSync(abs.path, body, 'utf8');
    return { ok: true, data: { resPath: toResPath(projectRoot, abs.path) } };
  }

  /** Append a node to a scene under `parent` (default the root, ".") . */
  addNode(
    projectRoot: string,
    scenePath: string,
    name: string,
    type: string,
    parent = '.'
  ): GodotCliResult<{ resPath: string; nodeCount: number }> {
    const loaded = this.loadScene(projectRoot, scenePath);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    let text = loaded.text;
    if (new RegExp(`\\[node name="${escapeRe(name)}"[^\\]]*parent="${escapeRe(parent)}"`).test(text)) {
      return { ok: false, error: `Node "${name}" already exists under parent "${parent}".` };
    }
    const block = `\n[node name="${name}" type="${type}" parent="${parent}"]\n`;
    text = `${text.replace(/\s*$/, '')}\n${block}`;
    writeFileSync(loaded.path, text, 'utf8');
    const count = (text.match(/^\[node\s/gm) ?? []).length;
    return { ok: true, data: { resPath: toResPath(projectRoot, loaded.path), nodeCount: count } };
  }

  /** Remove a node block (and its property lines) by name. */
  removeSceneNode(
    projectRoot: string,
    scenePath: string,
    name: string
  ): GodotCliResult<{ resPath: string; removed: boolean }> {
    const loaded = this.loadScene(projectRoot, scenePath);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    const blockRe = new RegExp(
      `\\n?\\[node name="${escapeRe(name)}"[^\\]]*\\][^\\[]*`,
      'm'
    );
    if (!blockRe.test(loaded.text)) {
      return { ok: false, error: `Node "${name}" not found in ${scenePath}.` };
    }
    const text = loaded.text.replace(blockRe, '\n');
    writeFileSync(loaded.path, text.replace(/\n{3,}/g, '\n\n'), 'utf8');
    return { ok: true, data: { resPath: toResPath(projectRoot, loaded.path), removed: true } };
  }

  /** Set/replace a property line inside a node block. */
  modifySceneNode(
    projectRoot: string,
    scenePath: string,
    name: string,
    property: string,
    value: string
  ): GodotCliResult<{ resPath: string }> {
    const loaded = this.loadScene(projectRoot, scenePath);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    const updated = upsertNodeProperty(loaded.text, name, property, value);
    if (updated === null) return { ok: false, error: `Node "${name}" not found in ${scenePath}.` };
    writeFileSync(loaded.path, updated, 'utf8');
    return { ok: true, data: { resPath: toResPath(projectRoot, loaded.path) } };
  }

  /**
   * Attach a script (res:// path) to a node: ensure an ext_resource entry for
   * the script, then set `script = ExtResource("id")` on the node block.
   */
  attachScript(
    projectRoot: string,
    scenePath: string,
    name: string,
    scriptResPath: string
  ): GodotCliResult<{ resPath: string; scriptId: string }> {
    const loaded = this.loadScene(projectRoot, scenePath);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    let text = loaded.text;
    // Reuse an existing ext_resource for this script, else create one.
    let id: string | null = matchValue(
      text,
      new RegExp(`\\[ext_resource[^\\]]*path="${escapeRe(scriptResPath)}"[^\\]]*id="?([^"\\s\\]]+)"?`)
    );
    if (id === null) {
      id = `${nextExtId(text)}_${randomTag()}`;
      const extLine = `[ext_resource type="Script" path="${scriptResPath}" id="${id}"]\n`;
      text = insertExtResource(text, extLine);
    }
    const updated = upsertNodeProperty(text, name, 'script', `ExtResource("${id}")`);
    if (updated === null) return { ok: false, error: `Node "${name}" not found in ${scenePath}.` };
    writeFileSync(loaded.path, withLoadSteps(updated), 'utf8');
    return { ok: true, data: { resPath: toResPath(projectRoot, loaded.path), scriptId: id } };
  }

  /**
   * Create a GDScript file (CRITICAL - it is executable code). Writes a minimal
   * `extends <base>` stub unless explicit content is supplied.
   */
  createScript(
    projectRoot: string,
    scriptPath: string,
    opts: { extends?: string; content?: string; overwrite?: boolean } = {}
  ): GodotCliResult<{ resPath: string }> {
    const abs = this.safeResolve(projectRoot, scriptPath);
    if (!abs.ok) return { ok: false, error: abs.error };
    if (!abs.path.endsWith('.gd')) return { ok: false, error: 'Script path must end in .gd' };
    if (existsSync(abs.path) && !opts.overwrite) {
      return { ok: false, error: `Script exists (pass overwrite=true): ${scriptPath}` };
    }
    const content = opts.content ?? `extends ${opts.extends ?? 'Node'}\n\n\nfunc _ready() -> void:\n\tpass\n`;
    mkdirSync(dirname(abs.path), { recursive: true });
    writeFileSync(abs.path, content, 'utf8');
    return { ok: true, data: { resPath: toResPath(projectRoot, abs.path) } };
  }

  /**
   * Create a text `.tres` resource with a [resource] section and optional
   * scalar/string properties.
   */
  createResource(
    projectRoot: string,
    resPath: string,
    type: string,
    properties: Record<string, unknown> = {},
    overwrite = false
  ): GodotCliResult<{ resPath: string }> {
    const abs = this.safeResolve(projectRoot, resPath);
    if (!abs.ok) return { ok: false, error: abs.error };
    if (!abs.path.endsWith('.tres')) return { ok: false, error: 'Resource path must end in .tres' };
    if (existsSync(abs.path) && !overwrite) {
      return { ok: false, error: `Resource exists (pass overwrite=true): ${resPath}` };
    }
    const props = Object.entries(properties)
      .map(([k, v]) => `${k} = ${serializeValue(v)}`)
      .join('\n');
    const body = `[gd_resource type="${type}" format=3]\n\n[resource]\n${props ? `${props}\n` : ''}`;
    mkdirSync(dirname(abs.path), { recursive: true });
    writeFileSync(abs.path, body, 'utf8');
    return { ok: true, data: { resPath: toResPath(projectRoot, abs.path) } };
  }

  /**
   * Set a `key=value` setting in `project.godot` under the given section,
   * creating the section/key if needed. `value` is written verbatim if it
   * already looks like a Godot literal, else quoted as a string.
   */
  modifyProjectSettings(
    projectRoot: string,
    section: string,
    key: string,
    value: string
  ): GodotCliResult<{ section: string; key: string }> {
    const root = resolve(projectRoot);
    const projectFile = join(root, 'project.godot');
    if (!existsSync(projectFile)) return { ok: false, error: 'No project.godot found in the project root.' };
    const literal = looksLikeLiteral(value) ? value : `"${value}"`;
    const updated = upsertIniKey(readFileSync(projectFile, 'utf8'), section, key, literal);
    writeFileSync(projectFile, updated, 'utf8');
    return { ok: true, data: { section, key } };
  }

  /**
   * Scan a directory (non-recursive by default, one level deep) for Godot
   * projects - any immediate subdirectory containing a `project.godot`. The
   * search root itself is included when it is a project. No engine required.
   */
  listProjects(searchDir: string): GodotCliResult<{ root: string; projects: { path: string; name: string }[] }> {
    const root = resolve(searchDir);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      return { ok: false, error: `Not a directory: ${searchDir}` };
    }
    const found: { path: string; name: string }[] = [];
    const consider = (dir: string): void => {
      const pf = join(dir, 'project.godot');
      if (existsSync(pf)) {
        const info = this.readProjectInfo(dir);
        found.push({ path: dir, name: info.ok ? (info.data?.name ?? '') : '' });
      }
    };
    consider(root);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        consider(join(root, entry.name));
      }
    }
    return { ok: true, data: { root, projects: found } };
  }

  /**
   * Create a new Godot project: make the directory (if needed) and write a
   * minimal valid `project.godot` (config_version 5, the Godot 4.x format).
   * Refuses to clobber an existing project unless `overwrite`. No engine
   * required - the file is the canonical bootstrap Godot itself accepts.
   */
  createProject(
    targetDir: string,
    name: string,
    opts: { features?: string; mainScene?: string; overwrite?: boolean } = {}
  ): GodotCliResult<{ projectRoot: string; projectFile: string; created: boolean }> {
    const root = resolve(targetDir);
    const projectFile = join(root, 'project.godot');
    const existed = existsSync(projectFile);
    if (existed && !opts.overwrite) {
      return { ok: false, error: `A project.godot already exists at ${targetDir} (pass overwrite=true).` };
    }
    mkdirSync(root, { recursive: true });
    const features = opts.features ?? '4.4';
    const mainLine = opts.mainScene
      ? `run/main_scene="${opts.mainScene.startsWith('res://') ? opts.mainScene : `res://${opts.mainScene.replace(/^\.?\//, '')}`}"\n`
      : '';
    const body =
      `; Engine configuration file.\n` +
      `; Generated by FolderForge.\n\n` +
      `config_version=5\n\n` +
      `[application]\n\n` +
      `config/name="${name}"\n` +
      mainLine +
      `config/features=PackedStringArray("${features}")\n`;
    writeFileSync(projectFile, body, 'utf8');
    return { ok: true, data: { projectRoot: root, projectFile, created: !existed } };
  }

  /**
   * "Save" a text `.tscn` scene: validate it loads and rewrite it normalized.
   * For text scenes this is an idempotent round-trip (no engine needed); it is
   * the headless equivalent of a save so callers can confirm a scene is valid.
   */
  saveScene(projectRoot: string, scenePath: string): GodotCliResult<{ resPath: string; nodeCount: number }> {
    const loaded = this.loadScene(projectRoot, scenePath);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    writeFileSync(loaded.path, loaded.text, 'utf8');
    const count = (loaded.text.match(/^\[node\s/gm) ?? []).length;
    return { ok: true, data: { resPath: toResPath(projectRoot, loaded.path), nodeCount: count } };
  }

  /**
   * Read the `uid="uid://..."` token from a text scene/resource header, when
   * present (Godot 4.4+ writes one). Returns `uid: null` when the file predates
   * UIDs or has none. No engine required.
   */
  getUid(projectRoot: string, filePath: string): GodotCliResult<{ resPath: string; uid: string | null }> {
    const abs = this.safeResolve(projectRoot, filePath);
    if (!abs.ok) return { ok: false, error: abs.error };
    if (!existsSync(abs.path)) return { ok: false, error: `File not found: ${filePath}` };
    const head = readFileSync(abs.path, 'utf8').slice(0, 2000);
    return {
      ok: true,
      data: { resPath: toResPath(projectRoot, abs.path), uid: matchValue(head, /uid="?(uid:\/\/[^"\s\]]+)"?/) },
    };
  }

  /**
   * Add/remove an autoload (singleton) entry in `project.godot` under
   * `[autoload]`. `op`: `add` writes `name="*res://path"` (the leading `*`
   * enables the singleton), `remove` deletes the key. No engine required.
   */
  manageAutoloads(
    projectRoot: string,
    op: 'add' | 'remove',
    name: string,
    scriptPath?: string
  ): GodotCliResult<{ autoload: string; op: string }> {
    if (op === 'add') {
      if (!scriptPath) return { ok: false, error: 'scriptPath is required to add an autoload.' };
      const res = scriptPath.startsWith('res://') ? scriptPath : `res://${scriptPath.replace(/^\.?\//, '')}`;
      const r = this.modifyProjectSettings(projectRoot, 'autoload', name, `"*${res}"`);
      if (!r.ok) return { ok: false, error: r.error ?? 'Godot operation failed' };
      return { ok: true, data: { autoload: name, op } };
    }
    const r = this.removeProjectKey(projectRoot, 'autoload', name);
    if (!r.ok) return { ok: false, error: r.error ?? 'Godot operation failed' };
    return { ok: true, data: { autoload: name, op } };
  }

  /**
   * Define an input action in `project.godot` under `[input]`. Writes a Godot
   * InputMap entry with the given physical key/button events. No engine needed.
   */
  manageInputMap(
    projectRoot: string,
    op: 'add' | 'remove',
    action: string,
    keys: string[] = []
  ): GodotCliResult<{ action: string; op: string }> {
    if (op === 'remove') {
      const r = this.removeProjectKey(projectRoot, 'input', action);
      if (!r.ok) return { ok: false, error: r.error ?? 'Godot operation failed' };
      return { ok: true, data: { action, op } };
    }
    const events = keys
      .map((k) => `Object(InputEventKey,"keycode":${JSON.stringify(k)})`)
      .join(', ');
    const literal = `{\n"deadzone": 0.5,\n"events": [${events}]\n}`;
    const r = this.modifyProjectSettings(projectRoot, 'input', action, literal);
    if (!r.ok) return { ok: false, error: r.error ?? 'Godot operation failed' };
    return { ok: true, data: { action, op } };
  }

  /**
   * Register a translation `.po`/`.translation` file in `project.godot` under
   * `[internationalization]` `locale/translations`. No engine needed.
   */
  manageTranslations(
    projectRoot: string,
    files: string[]
  ): GodotCliResult<{ count: number }> {
    const list = files
      .map((f) => `"${f.startsWith('res://') ? f : `res://${f.replace(/^\.?\//, '')}"`}`)
      .join(', ');
    const r = this.modifyProjectSettings(
      projectRoot,
      'internationalization',
      'locale/translations',
      `PackedStringArray(${list})`
    );
    if (!r.ok) return { ok: false, error: r.error ?? 'Godot operation failed' };
    return { ok: true, data: { count: files.length } };
  }

  /**
   * Name a 2D or 3D physics/render layer in `project.godot` under `[layer_names]`.
   * `kind` selects the layer group (e.g. `2d_physics`, `3d_render`). No engine.
   */
  manageLayers(
    projectRoot: string,
    kind: string,
    index: number,
    name: string
  ): GodotCliResult<{ key: string }> {
    const key = `${kind}/layer_${index}`;
    const r = this.modifyProjectSettings(projectRoot, 'layer_names', key, `"${name}"`);
    if (!r.ok) return { ok: false, error: r.error ?? 'Godot operation failed' };
    return { ok: true, data: { key } };
  }

  /**
   * Enable/disable an editor plugin in `project.godot` under
   * `[editor_plugins]` `enabled`. This is a coarse text edit of the enabled
   * PackedStringArray. No engine needed.
   */
  managePlugins(
    projectRoot: string,
    op: 'enable' | 'disable',
    pluginPath: string
  ): GodotCliResult<{ plugin: string; op: string }> {
    const root = resolve(projectRoot);
    const projectFile = join(root, 'project.godot');
    if (!existsSync(projectFile)) return { ok: false, error: 'No project.godot found in the project root.' };
    const res = pluginPath.startsWith('res://') ? pluginPath : `res://addons/${pluginPath}/plugin.cfg`;
    const text = readFileSync(projectFile, 'utf8');
    const current = matchValue(text, /enabled\s*=\s*PackedStringArray\(([^)]*)\)/);
    const items = current
      ? current.split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean)
      : [];
    const set = new Set(items);
    if (op === 'enable') set.add(res);
    else set.delete(res);
    const literal = `PackedStringArray(${[...set].map((i) => `"${i}"`).join(', ')})`;
    writeFileSync(projectFile, upsertIniKey(text, 'editor_plugins', 'enabled', literal), 'utf8');
    return { ok: true, data: { plugin: res, op } };
  }

  /**
   * Set a `key=value` in `export_presets.cfg` under a `[preset.N]`-style
   * section, creating the file/section/key as needed. This is the headless
   * way to script export presets without opening the editor. No engine needed.
   */
  setExportPreset(
    projectRoot: string,
    section: string,
    key: string,
    value: string
  ): GodotCliResult<{ section: string; key: string }> {
    const root = resolve(projectRoot);
    const file = join(root, 'export_presets.cfg');
    const literal = looksLikeLiteral(value) ? value : `"${value}"`;
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    writeFileSync(file, upsertIniKey(text, section, key, literal), 'utf8');
    return { ok: true, data: { section, key } };
  }

  /** Remove a `key` from a `[section]` of `project.godot`. */
  private removeProjectKey(
    projectRoot: string,
    section: string,
    key: string
  ): GodotCliResult<{ removed: boolean }> {
    const root = resolve(projectRoot);
    const projectFile = join(root, 'project.godot');
    if (!existsSync(projectFile)) return { ok: false, error: 'No project.godot found in the project root.' };
    const text = readFileSync(projectFile, 'utf8');
    const lineRe = new RegExp(`^${escapeRe(key)}\\s*=.*$\\n?`, 'm');
    if (!lineRe.test(text)) return { ok: true, data: { removed: false } };
    writeFileSync(projectFile, text.replace(lineRe, ''), 'utf8');
    return { ok: true, data: { removed: true } };
  }

  /** Convenience: set `application/run/main_scene` in project.godot. */
  setMainScene(projectRoot: string, scenePath: string): GodotCliResult<{ mainScene: string }> {
    const resPath = scenePath.startsWith('res://') ? scenePath : `res://${scenePath.replace(/^\.?\//, '')}`;
    const res = this.modifyProjectSettings(projectRoot, 'application', 'run/main_scene', `"${resPath}"`);
    if (!res.ok) return { ok: false, error: res.error ?? 'Failed to set main scene' };
    return { ok: true, data: { mainScene: resPath } };
  }

  /** Load a `.tscn` for editing: resolve, existence + text-format guard, read. */
  private loadScene(
    projectRoot: string,
    scenePath: string
  ): { ok: true; path: string; text: string } | { ok: false; error: string } {
    const abs = this.safeResolve(projectRoot, scenePath);
    if (!abs.ok) return { ok: false, error: abs.error };
    if (!existsSync(abs.path)) return { ok: false, error: `Scene not found: ${scenePath}` };
    if (!abs.path.endsWith('.tscn')) {
      return { ok: false, error: 'Only text .tscn scenes can be edited.' };
    }
    return { ok: true, path: abs.path, text: readFileSync(abs.path, 'utf8') };
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

// --- edit-tier helpers (Step 2) -------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function randomTag(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Next free ext_resource integer id (max existing leading int + 1). */
function nextExtId(text: string): number {
  let max = 0;
  const re = /\[ext_resource[^\]]*id="?(\d+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/** Insert an ext_resource line after the gd_scene header (or other ext lines). */
function insertExtResource(text: string, line: string): string {
  const lastExt = [...text.matchAll(/\[ext_resource[^\]]*\]\n/g)].pop();
  if (lastExt && lastExt.index !== undefined) {
    const at = lastExt.index + lastExt[0].length;
    return `${text.slice(0, at)}${line}${text.slice(at)}`;
  }
  // No ext_resources yet: place right after the gd_scene header line.
  const header = text.match(/\[gd_scene[^\]]*\]\n/);
  if (header && header.index !== undefined) {
    const at = header.index + header[0].length;
    return `${text.slice(0, at)}\n${line}${text.slice(at)}`;
  }
  return `${line}${text}`;
}

/** Keep the gd_scene `load_steps` in sync with the ext_resource count. */
function withLoadSteps(text: string): string {
  const extCount = (text.match(/\[ext_resource\s/g) ?? []).length;
  const loadSteps = extCount + 1;
  if (/\[gd_scene[^\]]*load_steps=\d+/.test(text)) {
    return text.replace(/(\[gd_scene[^\]]*load_steps=)\d+/, `$1${loadSteps}`);
  }
  return text.replace(/\[gd_scene\b/, `[gd_scene load_steps=${loadSteps}`);
}

/**
 * Set/replace a `property = value` line inside a node block identified by name.
 * Returns null when the node is not found. Properties are inserted directly
 * under the matched `[node ...]` header line.
 */
function upsertNodeProperty(
  text: string,
  nodeName: string,
  property: string,
  value: string
): string | null {
  const headerRe = new RegExp(`\\[node name="${escapeRe(nodeName)}"[^\\]]*\\]`, 'm');
  const header = text.match(headerRe);
  if (!header || header.index === undefined) return null;
  const blockStart = header.index + header[0].length;
  const rest = text.slice(blockStart);
  const nextHeader = rest.search(/\n\[/);
  const blockEnd = nextHeader === -1 ? text.length : blockStart + nextHeader;
  const block = text.slice(blockStart, blockEnd);
  const propRe = new RegExp(`(^|\\n)${escapeRe(property)}\\s*=\\s*[^\\n]*`);
  let newBlock: string;
  if (propRe.test(block)) {
    newBlock = block.replace(propRe, `$1${property} = ${value}`);
  } else {
    newBlock = `\n${property} = ${value}${block.startsWith('\n') ? '' : '\n'}${block}`;
  }
  return text.slice(0, blockStart) + newBlock + text.slice(blockEnd);
}

/** Whether a raw setting value already looks like a Godot literal (not a string). */
function looksLikeLiteral(v: string): boolean {
  const t = v.trim();
  if (t === 'true' || t === 'false') return true;
  if (/^-?\d+(\.\d+)?$/.test(t)) return true;
  // Quoted strings, arrays, dictionaries, and constructor calls are literals.
  if (/^".*"$/.test(t)) return true;
  if (/^[[{].*[\]}]$/.test(t)) return true;
  if (/^[A-Z][A-Za-z0-9_]*\(.*\)$/.test(t)) return true;
  return false;
}

/** Serialize a JS value to a Godot resource literal. */
function serializeValue(v: unknown): string {
  if (typeof v === 'string') return looksLikeLiteral(v) ? v : `"${v}"`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return 'null';
  return `"${String(v)}"`;
}

/**
 * Upsert a `key=value` under `[section]` in an INI-style project.godot.
 * Creates the section at the end if it does not exist; replaces the key in
 * place if it does.
 */
function upsertIniKey(text: string, section: string, key: string, value: string): string {
  const lines = text.split('\n');
  const sectionHeader = `[${section}]`;
  let secStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() === sectionHeader) {
      secStart = i;
      break;
    }
  }
  const line = `${key}=${value}`;
  if (secStart === -1) {
    const tail = text.endsWith('\n') ? '' : '\n';
    return `${text}${tail}\n${sectionHeader}\n\n${line}\n`;
  }
  // Find the section's extent (until the next header or EOF).
  let secEnd = lines.length;
  for (let i = secStart + 1; i < lines.length; i++) {
    if (/^\[[^\]]+\]\s*$/.test(lines[i] ?? '')) {
      secEnd = i;
      break;
    }
  }
  const keyRe = new RegExp(`^${escapeRe(key)}\\s*=`);
  for (let i = secStart + 1; i < secEnd; i++) {
    if (keyRe.test(lines[i] ?? '')) {
      lines[i] = line;
      return lines.join('\n');
    }
  }
  // Insert before the trailing blank line of the section, if any.
  let insertAt = secEnd;
  while (insertAt - 1 > secStart && (lines[insertAt - 1] ?? '').trim() === '') insertAt--;
  lines.splice(insertAt, 0, line);
  return lines.join('\n');
}
