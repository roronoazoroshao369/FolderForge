import { defineTool } from './registry.js';
import type { ToolDefinition, ToolContext } from '../core/types.js';
import { defaultShell, quoteShellArg } from '../core/shell.js';
import { GodotCli, GodotRuntime } from '#adapter-godot';

/**
 * Godot `game_*` tools - Step 1: adapter + headless read tier.
 *
 * These are the read-only / introspection tools (risk LOW, plus run/stop which
 * are MEDIUM and land in later steps). They all route through {@link GodotCli},
 * the headless-CLI + file-parsing channel, so they work with the editor closed
 * and (for the file-based ones) even without the Godot binary installed.
 *
 * The full 149-tool surface is documented in docs/godot-mcp.md; later steps add
 * the edit tier (Step 2), the runtime bridge (Step 3+), and the advanced tiers.
 * Every tool added here is also declared in src/policy/risk.ts and
 * src/tools/schema-lock.ts (the frozen surface is CI-guarded).
 */

function cli(ctx: ToolContext): GodotCli {
  const godot = ctx.container.config.adapters?.godot ?? {
    enabled: false,
    godotPath: 'godot',
    editorPort: 6550,
    runtimePort: 9090,
  };
  return new GodotCli(godot);
}

/** Build the runtime-bridge client (RUN channel) from the configured port. */
function runtime(ctx: ToolContext): GodotRuntime {
  const godot = ctx.container.config.adapters?.godot ?? {
    enabled: false,
    godotPath: 'godot',
    editorPort: 6550,
    runtimePort: 9090,
  };
  return new GodotRuntime(godot);
}

/**
 * Build a RUN-channel passthrough tool (Step 4+). It validates that the
 * `required` args are present and non-empty, forwards the declared input props
 * (as-is) to the runtime-bridge `op`, and surfaces the typed result. When no
 * game is running, `GodotRuntime` already returns a structured, actionable
 * error, so these tools never throw. This keeps the large runtime
 * mutation/input surface declarative and uniform; the GDScript bridge owns each
 * op's semantics (see docs/godot-mcp.md).
 */
function runtimeTool(
  name: string,
  description: string,
  mutates: boolean,
  props: Record<string, unknown>,
  op: string,
  required: string[] = []
): ToolDefinition {
  return gameTool(name, description, mutates, props, async (args, ctx) => {
    for (const key of required) {
      const v = args[key];
      if (v === undefined || v === null || (typeof v === 'string' && v.length === 0)) {
        return { ok: false, error: `${key} is required.` };
      }
    }
    const params: Record<string, unknown> = {};
    for (const key of Object.keys(props)) {
      if (args[key] !== undefined) params[key] = args[key];
    }
    const res = await runtime(ctx).send(op, params);
    return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
  });
}

/** Resolve the Godot project root: explicit arg, else the active workspace. */
function projectRoot(ctx: ToolContext, args: Record<string, unknown>): string {
  const p = args.projectPath ?? args.projectRoot;
  return typeof p === 'string' && p.length ? p : ctx.projectRoot;
}

/**
 * Launch the Godot binary as a managed process (PROC channel). Builds the
 * appropriate CLI invocation for the given mode, starts it through the shared
 * ProcessManager (so output streams and it is governed like any process), and
 * returns the sessionId. Stop with `game_stop_project`, read output with
 * `game_get_debug_output` / `process_tail`.
 */
async function launchGodot(
  ctx: ToolContext,
  args: Record<string, unknown>,
  mode: 'run' | 'editor' | 'export-release' | 'export-debug' | 'import',
  extra: { preset?: string; out?: string } = {}
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const root = projectRoot(ctx, args);
  const bin = ctx.container.config.adapters?.godot?.godotPath || 'godot';
  const shell = ctx.config?.terminal?.shell ?? ctx.container.config?.terminal?.shell ?? defaultShell();
  const quote = (value: string) => quoteShellArg(shell, value);
  const parts: string[] = [quote(bin)];
  switch (mode) {
    case 'editor':
      parts.push('--editor', '--path', quote(root));
      break;
    case 'run':
      parts.push('--path', quote(root));
      if (typeof args.scene === 'string' && args.scene.length) parts.push(quote(args.scene));
      break;
    case 'import':
      parts.push('--headless', '--path', quote(root), '--import');
      break;
    case 'export-release':
    case 'export-debug':
      parts.push(
        '--headless',
        '--path',
        quote(root),
        mode === 'export-debug' ? '--export-debug' : '--export-release',
        quote(extra.preset ?? ''),
        quote(extra.out ?? '')
      );
      break;
  }
  const command = parts.join(' ');
  const session = ctx.container.processes.start(command, root, shell);
  ctx.container.audit.record({ type: 'process_event', summary: `game ${mode}: ${session.sessionId}` });
  return { ok: true, data: { sessionId: session.sessionId, command, mode, status: session.status } };
}

function gameTool(
  name: string,
  description: string,
  mutates: boolean,
  props: Record<string, unknown>,
  handler: ToolDefinition['handler']
): ToolDefinition {
  return defineTool({
    name,
    description,
    group: 'game',
    mutates,
    inputSchema: { type: 'object', properties: props },
    handler,
  });
}

const PROJECT_PROP = {
  projectPath: {
    type: 'string',
    description: 'Path to the Godot project root. Defaults to the active workspace.',
  },
};

export function gameTools(): ToolDefinition[] {
  return [
    gameTool(
      'game_get_godot_version',
      'Return the installed Godot engine version (probes `godot --headless --version`). Reports availability: false when no Godot binary is found, rather than failing.',
      false,
      {},
      async (_args, ctx) => {
        const res = await cli(ctx).version();
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_get_project_info',
      'Read high-level metadata for a Godot project (name, config version, main scene) by parsing project.godot. No engine required.',
      false,
      { ...PROJECT_PROP },
      async (args, ctx) => {
        const res = cli(ctx).readProjectInfo(projectRoot(ctx, args));
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_read_scene',
      'Parse a Godot .tscn scene file into its node tree and external resource references. No engine required.',
      false,
      {
        ...PROJECT_PROP,
        scenePath: {
          type: 'string',
          description: 'Scene file path (project-relative or res://...), e.g. res://main.tscn.',
        },
      },
      async (args, ctx) => {
        const scene = String(args.scenePath ?? '');
        if (!scene) return { ok: false, error: 'scenePath is required.' };
        const res = cli(ctx).readScene(projectRoot(ctx, args), scene);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_read_project_settings',
      'Return the raw project.godot contents plus the list of setting sections it declares. No engine required.',
      false,
      { ...PROJECT_PROP },
      async (args, ctx) => {
        const res = cli(ctx).readProjectSettings(projectRoot(ctx, args));
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_list_project_files',
      'List files in a Godot project (recursive), skipping .git/.godot/.import caches. Returns res:// paths with a coarse kind (scene/script/resource/asset/other).',
      false,
      {
        ...PROJECT_PROP,
        subdir: {
          type: 'string',
          description: 'Optional subdirectory (project-relative or res://...) to scope the listing.',
        },
      },
      async (args, ctx) => {
        const res = cli(ctx).listProjectFiles(
          projectRoot(ctx, args),
          typeof args.subdir === 'string' ? args.subdir : ''
        );
        return res.ok
          ? { ok: true, data: { count: res.data?.length ?? 0, files: res.data } }
          : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_read_file',
      'Read a UTF-8 text file (script, scene, resource) from inside a Godot project. Output is capped; `truncated` flags when content was cut.',
      false,
      {
        ...PROJECT_PROP,
        filePath: {
          type: 'string',
          description: 'File path (project-relative or res://...) to read.',
        },
      },
      async (args, ctx) => {
        const file = String(args.filePath ?? '');
        if (!file) return { ok: false, error: 'filePath is required.' };
        const res = cli(ctx).readFile(projectRoot(ctx, args), file);
        return res.ok
          ? {
              ok: true,
              data: res.data,
              content: [{ kind: 'text', text: (res.data?.content ?? '').slice(0, 4000) }],
            }
          : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    // -----------------------------------------------------------------------
    // Step 2 - headless edit tier. These mutate project files on disk via
    // text-based edits (no running engine/editor). Risk bands are declared in
    // src/policy/risk.ts (HIGH for most edits; CRITICAL for delete + script
    // creation since those remove data / introduce executable code) and frozen
    // in src/tools/schema-lock.ts.
    // -----------------------------------------------------------------------

    gameTool(
      'game_write_file',
      'Write a UTF-8 text file (scene, script, resource, config) inside a Godot project, creating parent directories. Pass overwrite=false to refuse clobbering an existing file.',
      true,
      {
        ...PROJECT_PROP,
        filePath: { type: 'string', description: 'File path (project-relative or res://...) to write.' },
        content: { type: 'string', description: 'Full UTF-8 file contents.' },
        overwrite: { type: 'boolean', description: 'Replace an existing file (default true).' },
      },
      async (args, ctx) => {
        const file = String(args.filePath ?? '');
        if (!file) return { ok: false, error: 'filePath is required.' };
        if (typeof args.content !== 'string') return { ok: false, error: 'content is required.' };
        const res = cli(ctx).writeFile(
          projectRoot(ctx, args),
          file,
          args.content,
          args.overwrite !== false
        );
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_delete_file',
      'Delete a single file inside a Godot project. Refuses directories. CRITICAL: removes data and is gated by the approval queue.',
      true,
      {
        ...PROJECT_PROP,
        filePath: { type: 'string', description: 'File path (project-relative or res://...) to delete.' },
      },
      async (args, ctx) => {
        const file = String(args.filePath ?? '');
        if (!file) return { ok: false, error: 'filePath is required.' };
        const res = cli(ctx).deleteFile(projectRoot(ctx, args), file);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_create_directory',
      'Create a directory (recursive) inside a Godot project.',
      true,
      {
        ...PROJECT_PROP,
        dirPath: { type: 'string', description: 'Directory path (project-relative or res://...) to create.' },
      },
      async (args, ctx) => {
        const dir = String(args.dirPath ?? '');
        if (!dir) return { ok: false, error: 'dirPath is required.' };
        const res = cli(ctx).createDirectory(projectRoot(ctx, args), dir);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_rename_file',
      'Rename or move a file inside a Godot project. Pass overwrite=true to replace the destination.',
      true,
      {
        ...PROJECT_PROP,
        from: { type: 'string', description: 'Source path (project-relative or res://...).' },
        to: { type: 'string', description: 'Destination path (project-relative or res://...).' },
        overwrite: { type: 'boolean', description: 'Replace an existing destination (default false).' },
      },
      async (args, ctx) => {
        const from = String(args.from ?? '');
        const to = String(args.to ?? '');
        if (!from || !to) return { ok: false, error: 'from and to are required.' };
        const res = cli(ctx).renameFile(projectRoot(ctx, args), from, to, args.overwrite === true);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_create_scene',
      'Create a new text .tscn scene with a single root node. Pass overwrite=true to replace an existing scene.',
      true,
      {
        ...PROJECT_PROP,
        scenePath: { type: 'string', description: 'Scene path (must end in .tscn).' },
        rootName: { type: 'string', description: 'Root node name (default "Root").' },
        rootType: { type: 'string', description: 'Root node type (default "Node").' },
        overwrite: { type: 'boolean', description: 'Replace an existing scene (default false).' },
      },
      async (args, ctx) => {
        const scene = String(args.scenePath ?? '');
        if (!scene) return { ok: false, error: 'scenePath is required.' };
        const res = cli(ctx).createScene(
          projectRoot(ctx, args),
          scene,
          typeof args.rootName === 'string' ? args.rootName : 'Root',
          typeof args.rootType === 'string' ? args.rootType : 'Node',
          args.overwrite === true
        );
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_add_node',
      'Add a node to a .tscn scene under a parent (default the root ".").',
      true,
      {
        ...PROJECT_PROP,
        scenePath: { type: 'string', description: 'Scene path (project-relative or res://...).' },
        name: { type: 'string', description: 'New node name.' },
        type: { type: 'string', description: 'Godot node type, e.g. Node2D, Sprite2D.' },
        parent: { type: 'string', description: 'Parent node path within the scene (default ".").' },
      },
      async (args, ctx) => {
        const scene = String(args.scenePath ?? '');
        const name = String(args.name ?? '');
        const type = String(args.type ?? '');
        if (!scene || !name || !type) return { ok: false, error: 'scenePath, name, and type are required.' };
        const res = cli(ctx).addNode(
          projectRoot(ctx, args),
          scene,
          name,
          type,
          typeof args.parent === 'string' ? args.parent : '.'
        );
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_remove_node',
      'Remove a node (and its property lines) from a .tscn scene by name.',
      true,
      {
        ...PROJECT_PROP,
        scenePath: { type: 'string', description: 'Scene path (project-relative or res://...).' },
        name: { type: 'string', description: 'Node name to remove.' },
      },
      async (args, ctx) => {
        const scene = String(args.scenePath ?? '');
        const name = String(args.name ?? '');
        if (!scene || !name) return { ok: false, error: 'scenePath and name are required.' };
        const res = cli(ctx).removeSceneNode(projectRoot(ctx, args), scene, name);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_modify_node',
      'Set or replace a property on a node in a .tscn scene. The value is written verbatim, so pass a valid Godot literal (e.g. Vector2(10, 20), true, "text").',
      true,
      {
        ...PROJECT_PROP,
        scenePath: { type: 'string', description: 'Scene path (project-relative or res://...).' },
        name: { type: 'string', description: 'Target node name.' },
        property: { type: 'string', description: 'Property name, e.g. position, visible.' },
        value: { type: 'string', description: 'Godot literal value written verbatim.' },
      },
      async (args, ctx) => {
        const scene = String(args.scenePath ?? '');
        const name = String(args.name ?? '');
        const property = String(args.property ?? '');
        if (!scene || !name || !property) {
          return { ok: false, error: 'scenePath, name, and property are required.' };
        }
        const res = cli(ctx).modifySceneNode(
          projectRoot(ctx, args),
          scene,
          name,
          property,
          String(args.value ?? '')
        );
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_attach_script',
      'Attach a GDScript (res:// path) to a node in a .tscn scene, creating the ext_resource entry if needed.',
      true,
      {
        ...PROJECT_PROP,
        scenePath: { type: 'string', description: 'Scene path (project-relative or res://...).' },
        name: { type: 'string', description: 'Target node name.' },
        scriptPath: { type: 'string', description: 'Script res:// path to attach.' },
      },
      async (args, ctx) => {
        const scene = String(args.scenePath ?? '');
        const name = String(args.name ?? '');
        const script = String(args.scriptPath ?? '');
        if (!scene || !name || !script) {
          return { ok: false, error: 'scenePath, name, and scriptPath are required.' };
        }
        const res = cli(ctx).attachScript(projectRoot(ctx, args), scene, name, script);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_create_script',
      'Create a GDScript (.gd) file. CRITICAL: introduces executable code, so it is gated by the approval queue. Writes an "extends <base>" stub unless explicit content is supplied.',
      true,
      {
        ...PROJECT_PROP,
        scriptPath: { type: 'string', description: 'Script path (must end in .gd).' },
        extends: { type: 'string', description: 'Base class for the stub (default "Node").' },
        content: { type: 'string', description: 'Full script content; overrides the generated stub.' },
        overwrite: { type: 'boolean', description: 'Replace an existing script (default false).' },
      },
      async (args, ctx) => {
        const script = String(args.scriptPath ?? '');
        if (!script) return { ok: false, error: 'scriptPath is required.' };
        const res = cli(ctx).createScript(projectRoot(ctx, args), script, {
          ...(typeof args.extends === 'string' ? { extends: args.extends } : {}),
          ...(typeof args.content === 'string' ? { content: args.content } : {}),
          ...(args.overwrite === true ? { overwrite: true } : {}),
        });
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_create_resource',
      'Create a text .tres resource with a [resource] section and optional scalar/string properties.',
      true,
      {
        ...PROJECT_PROP,
        resPath: { type: 'string', description: 'Resource path (must end in .tres).' },
        type: { type: 'string', description: 'Resource type, e.g. Resource, Theme.' },
        properties: { type: 'object', description: 'Map of property name to value.' },
        overwrite: { type: 'boolean', description: 'Replace an existing resource (default false).' },
      },
      async (args, ctx) => {
        const path = String(args.resPath ?? '');
        const type = String(args.type ?? '');
        if (!path || !type) return { ok: false, error: 'resPath and type are required.' };
        const props =
          args.properties && typeof args.properties === 'object'
            ? (args.properties as Record<string, unknown>)
            : {};
        const res = cli(ctx).createResource(
          projectRoot(ctx, args),
          path,
          type,
          props,
          args.overwrite === true
        );
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_modify_project_settings',
      'Set a key=value setting in project.godot under a section, creating the section/key if needed. The value is written verbatim if it already looks like a Godot literal, else quoted as a string.',
      true,
      {
        ...PROJECT_PROP,
        section: { type: 'string', description: 'Settings section, e.g. application, rendering.' },
        key: { type: 'string', description: 'Setting key, e.g. config/name.' },
        value: { type: 'string', description: 'Setting value (literal or string).' },
      },
      async (args, ctx) => {
        const section = String(args.section ?? '');
        const key = String(args.key ?? '');
        if (!section || !key) return { ok: false, error: 'section and key are required.' };
        const res = cli(ctx).modifyProjectSettings(
          projectRoot(ctx, args),
          section,
          key,
          String(args.value ?? '')
        );
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_set_main_scene',
      'Set application/run/main_scene in project.godot to the given scene path.',
      true,
      {
        ...PROJECT_PROP,
        scenePath: { type: 'string', description: 'Main scene path (project-relative or res://...).' },
      },
      async (args, ctx) => {
        const scene = String(args.scenePath ?? '');
        if (!scene) return { ok: false, error: 'scenePath is required.' };
        const res = cli(ctx).setMainScene(projectRoot(ctx, args), scene);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    // -----------------------------------------------------------------------
    // Step 3 - runtime read tier (RUN channel). These talk to the live game
    // over the TCP runtime bridge (GodotRuntime). They are read-only
    // introspection (LOW) except `game_pause` / `game_wait`, which transiently
    // perturb the running game (MEDIUM), and `game_eval`, which runs arbitrary
    // GDScript in the live process (CRITICAL, approval-gated). Risk bands live
    // in src/policy/risk.ts and are frozen in src/tools/schema-lock.ts. When no
    // game is running, each tool returns a structured, actionable error.
    // -----------------------------------------------------------------------

    gameTool(
      'game_runtime_status',
      'Check whether a live Godot game is reachable on the runtime bridge (RUN channel). Returns running: true/false without failing when the game is not started.',
      false,
      {},
      async (_args, ctx) => {
        const running = await runtime(ctx).isRunning();
        return { ok: true, data: { running, port: ctx.container.config.adapters?.godot?.runtimePort ?? 9090 } };
      }
    ),

    gameTool(
      'game_get_scene_tree',
      'Snapshot the live scene tree from the running game (optionally bounded by depth). Requires a running game with the runtime bridge enabled.',
      false,
      {
        maxDepth: { type: 'number', description: 'Optional maximum tree depth to return.' },
      },
      async (args, ctx) => {
        const depth = typeof args.maxDepth === 'number' ? args.maxDepth : undefined;
        const res = await runtime(ctx).getSceneTree(depth);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_get_node_info',
      'Inspect a single live node (class, properties, children) by NodePath in the running game.',
      false,
      {
        path: { type: 'string', description: 'NodePath of the node, e.g. /root/Main/Player.' },
      },
      async (args, ctx) => {
        const path = String(args.path ?? '');
        if (!path) return { ok: false, error: 'path is required.' };
        const res = await runtime(ctx).getNodeInfo(path);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_get_ui',
      'Snapshot the live Control/UI tree of the running game.',
      false,
      {},
      async (_args, ctx) => {
        const res = await runtime(ctx).getUi();
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_get_performance',
      'Read live performance metrics (fps, frame time, memory, object/node counts) from the running game.',
      false,
      {},
      async (_args, ctx) => {
        const res = await runtime(ctx).performance();
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_get_nodes_in_group',
      'List the live node paths currently in a SceneTree group.',
      false,
      {
        group: { type: 'string', description: 'Group name to query.' },
      },
      async (args, ctx) => {
        const group = String(args.group ?? '');
        if (!group) return { ok: false, error: 'group is required.' };
        const res = await runtime(ctx).getNodesInGroup(group);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_find_nodes_by_class',
      'Find live node paths whose class matches the given className in the running game.',
      false,
      {
        className: { type: 'string', description: 'Godot class name to match, e.g. Sprite2D.' },
      },
      async (args, ctx) => {
        const className = String(args.className ?? '');
        if (!className) return { ok: false, error: 'className is required.' };
        const res = await runtime(ctx).findNodesByClass(className);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_get_errors',
      'Drain the captured engine error buffer from the running game.',
      false,
      {},
      async (_args, ctx) => {
        const res = await runtime(ctx).getErrors();
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_get_logs',
      'Tail the captured engine log from the running game (optionally the last N lines).',
      false,
      {
        lines: { type: 'number', description: 'Optional number of trailing log lines to return.' },
      },
      async (args, ctx) => {
        const lines = typeof args.lines === 'number' ? args.lines : undefined;
        const res = await runtime(ctx).getLogs(lines);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_pause',
      'Pause or resume the running game (transient, reversible). MEDIUM: perturbs the live process.',
      true,
      {
        paused: { type: 'boolean', description: 'true to pause, false to resume.' },
      },
      async (args, ctx) => {
        const res = await runtime(ctx).pause(args.paused === true);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_wait',
      'Ask the running game to advance/idle for the given number of seconds and acknowledge. MEDIUM: perturbs timing.',
      true,
      {
        seconds: { type: 'number', description: 'Seconds to wait/advance.' },
      },
      async (args, ctx) => {
        const seconds = typeof args.seconds === 'number' ? args.seconds : 0;
        if (seconds <= 0) return { ok: false, error: 'seconds must be a positive number.' };
        const res = await runtime(ctx).wait(seconds);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_eval',
      'Evaluate an arbitrary GDScript expression in the running game. CRITICAL: runs code in the live process, so it is gated by the approval queue.',
      true,
      {
        code: { type: 'string', description: 'GDScript expression/statement to evaluate.' },
      },
      async (args, ctx) => {
        const code = String(args.code ?? '');
        if (!code) return { ok: false, error: 'code is required.' };
        const res = await runtime(ctx).evaluate(code);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    // -----------------------------------------------------------------------
    // Step 4 - runtime mutation + input tier (RUN channel). All route through
    // GodotRuntime.send() via runtimeTool(). Risk bands live in
    // src/policy/risk.ts and are frozen in src/tools/schema-lock.ts. The live
    // game's runtime-bridge autoload owns each op's semantics (docs/godot-mcp.md).
    // When no game is running, every tool returns a structured error.
    // -----------------------------------------------------------------------

    // --- Family 8: runtime node manipulation ---
    runtimeTool(
      'game_get_property',
      'Read a property value from a live node by NodePath (read-only).',
      false,
      {
        path: { type: 'string', description: 'NodePath of the node, e.g. /root/Main/Player.' },
        property: { type: 'string', description: 'Property name to read, e.g. position.' },
      },
      'get_property',
      ['path', 'property']
    ),
    runtimeTool(
      'game_set_property',
      'Set a property on a live node by NodePath. HIGH: persists a live state change.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the node.' },
        property: { type: 'string', description: 'Property name to set.' },
        value: { description: 'New value (any JSON type; coerced by the bridge).' },
      },
      'set_property',
      ['path', 'property', 'value']
    ),
    runtimeTool(
      'game_call_method',
      'Call a method on a live node by NodePath with optional args. CRITICAL: arbitrary live invocation; approval-gated.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the node.' },
        method: { type: 'string', description: 'Method name to call.' },
        args: { type: 'array', description: 'Positional arguments (default []).' },
      },
      'call_method',
      ['path', 'method']
    ),
    runtimeTool(
      'game_instantiate_scene',
      'Instantiate a packed scene (res:// path) and add it under a parent in the running game.',
      true,
      {
        scenePath: { type: 'string', description: 'Scene res:// path to instantiate.' },
        parent: { type: 'string', description: 'Parent NodePath (default the current scene root).' },
      },
      'instantiate_scene',
      ['scenePath']
    ),
    runtimeTool(
      'game_runtime_remove_node',
      'Remove a live node from the running game by NodePath (queue_free). Distinct from game_remove_node, which edits a .tscn file on disk.',
      true,
      { path: { type: 'string', description: 'NodePath of the node to free.' } },
      'remove_node',
      ['path']
    ),
    runtimeTool(
      'game_change_scene',
      'Change the running game to a different packed scene (res:// path).',
      true,
      { scenePath: { type: 'string', description: 'Scene res:// path to switch to.' } },
      'change_scene',
      ['scenePath']
    ),
    runtimeTool(
      'game_reparent_node',
      'Reparent a live node to a new parent in the running game.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the node to move.' },
        newParent: { type: 'string', description: 'NodePath of the new parent.' },
      },
      'reparent_node',
      ['path', 'newParent']
    ),

    // --- Family 9: runtime signals ---
    runtimeTool(
      'game_connect_signal',
      'Connect a live node signal to a target node method in the running game.',
      true,
      {
        path: { type: 'string', description: 'Emitter NodePath.' },
        signal: { type: 'string', description: 'Signal name on the emitter.' },
        target: { type: 'string', description: 'Target NodePath that receives the call.' },
        method: { type: 'string', description: 'Method name on the target.' },
      },
      'connect_signal',
      ['path', 'signal', 'target', 'method']
    ),
    runtimeTool(
      'game_disconnect_signal',
      'Disconnect a previously connected live node signal in the running game.',
      true,
      {
        path: { type: 'string', description: 'Emitter NodePath.' },
        signal: { type: 'string', description: 'Signal name on the emitter.' },
        target: { type: 'string', description: 'Target NodePath.' },
        method: { type: 'string', description: 'Method name on the target.' },
      },
      'disconnect_signal',
      ['path', 'signal', 'target', 'method']
    ),
    runtimeTool(
      'game_emit_signal',
      'Emit a signal on a live node in the running game, with optional args.',
      true,
      {
        path: { type: 'string', description: 'Emitter NodePath.' },
        signal: { type: 'string', description: 'Signal name to emit.' },
        args: { type: 'array', description: 'Signal arguments (default []).' },
      },
      'emit_signal',
      ['path', 'signal']
    ),
    runtimeTool(
      'game_list_signals',
      'List the signals declared on a live node (read-only).',
      false,
      { path: { type: 'string', description: 'NodePath of the node.' } },
      'list_signals',
      ['path']
    ),
    runtimeTool(
      'game_await_signal',
      'Wait for the next emission of a signal on a live node and return its payload (read-only).',
      false,
      {
        path: { type: 'string', description: 'Emitter NodePath.' },
        signal: { type: 'string', description: 'Signal name to await.' },
      },
      'await_signal',
      ['path', 'signal']
    ),

    // --- Family 5 + 14: runtime input injection ---
    runtimeTool(
      'game_screenshot',
      'Capture a screenshot of the running game and return it (path or encoded data per the bridge). Read-only.',
      false,
      { path: { type: 'string', description: 'Optional output path inside the project for the screenshot.' } },
      'screenshot'
    ),
    runtimeTool(
      'game_click',
      'Inject a mouse click at screen coordinates in the running game.',
      true,
      {
        x: { type: 'number', description: 'X coordinate in pixels.' },
        y: { type: 'number', description: 'Y coordinate in pixels.' },
        button: { type: 'string', description: 'Mouse button: left | right | middle (default left).' },
      },
      'click',
      ['x', 'y']
    ),
    runtimeTool(
      'game_key_press',
      'Inject a key press-and-release in the running game.',
      true,
      { key: { type: 'string', description: 'Key name or keycode, e.g. space, Enter, A.' } },
      'key_press',
      ['key']
    ),
    runtimeTool(
      'game_mouse_move',
      'Move the mouse to screen coordinates in the running game.',
      true,
      {
        x: { type: 'number', description: 'X coordinate in pixels.' },
        y: { type: 'number', description: 'Y coordinate in pixels.' },
      },
      'mouse_move',
      ['x', 'y']
    ),
    runtimeTool(
      'game_key_hold',
      'Press and hold a key in the running game (released by game_key_release).',
      true,
      { key: { type: 'string', description: 'Key name or keycode to hold.' } },
      'key_hold',
      ['key']
    ),
    runtimeTool(
      'game_key_release',
      'Release a previously held key in the running game.',
      true,
      { key: { type: 'string', description: 'Key name or keycode to release.' } },
      'key_release',
      ['key']
    ),
    runtimeTool(
      'game_scroll',
      'Inject a mouse-wheel scroll in the running game.',
      true,
      {
        amount: { type: 'number', description: 'Scroll steps; positive = up, negative = down.' },
        x: { type: 'number', description: 'Optional X coordinate to scroll at.' },
        y: { type: 'number', description: 'Optional Y coordinate to scroll at.' },
      },
      'scroll',
      ['amount']
    ),
    runtimeTool(
      'game_mouse_drag',
      'Inject a mouse drag from one point to another in the running game.',
      true,
      {
        fromX: { type: 'number', description: 'Start X coordinate.' },
        fromY: { type: 'number', description: 'Start Y coordinate.' },
        toX: { type: 'number', description: 'End X coordinate.' },
        toY: { type: 'number', description: 'End Y coordinate.' },
        button: { type: 'string', description: 'Mouse button (default left).' },
      },
      'mouse_drag',
      ['fromX', 'fromY', 'toX', 'toY']
    ),
    runtimeTool(
      'game_gamepad',
      'Inject a gamepad button or axis event in the running game.',
      true,
      {
        control: { type: 'string', description: 'Button or axis name, e.g. a, dpad_up, left_stick_x.' },
        value: { description: 'Pressed (bool) or axis value (number, -1..1).' },
        device: { type: 'number', description: 'Gamepad device index (default 0).' },
      },
      'gamepad',
      ['control', 'value']
    ),
    runtimeTool(
      'game_touch',
      'Inject a touchscreen touch/release in the running game.',
      true,
      {
        x: { type: 'number', description: 'X coordinate.' },
        y: { type: 'number', description: 'Y coordinate.' },
        pressed: { type: 'boolean', description: 'true for touch down, false for release (default true).' },
        index: { type: 'number', description: 'Touch point index (default 0).' },
      },
      'touch',
      ['x', 'y']
    ),
    runtimeTool(
      'game_input_state',
      'Read the current input state (pressed keys/buttons, mouse position) of the running game. Read-only.',
      false,
      {},
      'input_state'
    ),
    runtimeTool(
      'game_input_action',
      'Trigger or release a named input action (from the InputMap) in the running game.',
      true,
      {
        action: { type: 'string', description: 'Input action name, e.g. ui_accept, jump.' },
        pressed: { type: 'boolean', description: 'true to press, false to release (default true).' },
        strength: { type: 'number', description: 'Action strength 0..1 (default 1).' },
      },
      'input_action',
      ['action']
    ),

    // --- Family 10 + 22: runtime animation ---
    runtimeTool(
      'game_play_animation',
      'Play an animation on a live AnimationPlayer node in the running game.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the AnimationPlayer.' },
        animation: { type: 'string', description: 'Animation name to play.' },
        speed: { type: 'number', description: 'Playback speed multiplier (default 1).' },
      },
      'play_animation',
      ['path', 'animation']
    ),
    runtimeTool(
      'game_tween_property',
      'Tween a property on a live node toward a target value over a duration.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the node.' },
        property: { type: 'string', description: 'Property to tween, e.g. position.' },
        to: { description: 'Target value.' },
        duration: { type: 'number', description: 'Duration in seconds (default 1).' },
      },
      'tween_property',
      ['path', 'property', 'to']
    ),
    runtimeTool(
      'game_animation_tree',
      'Configure or query a live AnimationTree node (set parameters, toggle active).',
      true,
      {
        path: { type: 'string', description: 'NodePath of the AnimationTree.' },
        parameter: { type: 'string', description: 'Parameter path to set, e.g. parameters/state.' },
        value: { description: 'Value to assign to the parameter.' },
      },
      'animation_tree',
      ['path']
    ),
    runtimeTool(
      'game_animation_control',
      'Control live animation playback (pause, stop, seek) on an AnimationPlayer.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the AnimationPlayer.' },
        action: { type: 'string', description: 'Control action: pause | stop | seek.' },
        time: { type: 'number', description: 'Seek time in seconds (for action=seek).' },
      },
      'animation_control',
      ['path', 'action']
    ),
    runtimeTool(
      'game_skeleton_ik',
      'Configure inverse kinematics on a live Skeleton/SkeletonIK node.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the SkeletonIK node.' },
        target: { description: 'IK target (NodePath or transform per the bridge).' },
        active: { type: 'boolean', description: 'Enable/disable the IK chain.' },
      },
      'skeleton_ik',
      ['path']
    ),

    // --- Family 23: advanced audio ---
    runtimeTool(
      'game_audio_effect',
      'Add, remove, or configure an audio effect on a live audio bus.',
      true,
      {
        bus: { type: 'string', description: 'Audio bus name.' },
        effect: { type: 'string', description: 'Effect type, e.g. Reverb, EQ.' },
        action: { type: 'string', description: 'add | remove | set (default set).' },
        params: { type: 'object', description: 'Effect parameters.' },
      },
      'audio_effect',
      ['bus', 'effect']
    ),
    runtimeTool(
      'game_audio_bus_layout',
      'Configure the live audio bus layout (create buses, set volume/mute/solo).',
      true,
      {
        bus: { type: 'string', description: 'Audio bus name.' },
        volumeDb: { type: 'number', description: 'Bus volume in dB.' },
        mute: { type: 'boolean', description: 'Mute the bus.' },
        solo: { type: 'boolean', description: 'Solo the bus.' },
      },
      'audio_bus_layout',
      ['bus']
    ),
    runtimeTool(
      'game_audio_spatial',
      'Configure spatial/positional audio on a live AudioStreamPlayer2D/3D node.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the audio player node.' },
        property: { type: 'string', description: 'Spatial property, e.g. max_distance, unit_size.' },
        value: { description: 'Value to assign.' },
      },
      'audio_spatial',
      ['path']
    ),

    // --- Family 19: system & window ---
    runtimeTool(
      'game_os_info',
      'Read OS/platform info from the running game (name, version, locale, model). Read-only.',
      false,
      {},
      'os_info'
    ),
    runtimeTool(
      'game_time_scale',
      'Set the engine time scale of the running game (slow-motion / fast-forward). Transient.',
      true,
      { scale: { type: 'number', description: 'Time scale multiplier; 1 = normal, 0.5 = half speed.' } },
      'time_scale',
      ['scale']
    ),
    runtimeTool(
      'game_window',
      'Configure the running game window (size, mode, position, title).',
      true,
      {
        property: { type: 'string', description: 'Window property, e.g. size, mode, position, title.' },
        value: { description: 'Value to assign to the property.' },
      },
      'window',
      ['property', 'value']
    ),
    runtimeTool(
      'game_process_mode',
      'Set the process mode of a live node (inherit | pausable | when_paused | always | disabled).',
      true,
      {
        path: { type: 'string', description: 'NodePath of the node.' },
        mode: { type: 'string', description: 'Process mode: inherit | pausable | when_paused | always | disabled.' },
      },
      'process_mode',
      ['path', 'mode']
    ),
    runtimeTool(
      'game_world_settings',
      'Configure live world settings (gravity, default environment, physics ticks).',
      true,
      {
        property: { type: 'string', description: 'World/physics setting, e.g. gravity, physics_ticks_per_second.' },
        value: { description: 'Value to assign.' },
      },
      'world_settings',
      ['property', 'value']
    ),
    runtimeTool(
      'game_script',
      'Attach or replace a GDScript on a live node at runtime (arbitrary code execution). CRITICAL: approval-gated even in danger mode.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the target node.' },
        source: { type: 'string', description: 'GDScript source to attach.' },
      },
      'script',
      ['path', 'source']
    ),

    // --- Family 25: UI controls ---
    runtimeTool(
      'game_ui_control',
      'Interact with a live Control node (focus, set value, toggle, press).',
      true,
      {
        path: { type: 'string', description: 'NodePath of the Control node.' },
        action: { type: 'string', description: 'Action: focus | press | toggle | set_value.' },
        value: { description: 'Value for set_value actions.' },
      },
      'ui_control',
      ['path', 'action']
    ),
    runtimeTool(
      'game_ui_text',
      'Set or read text on a live Label / LineEdit / TextEdit node.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the text node.' },
        text: { type: 'string', description: 'Text to set (omit to read current text).' },
      },
      'ui_text',
      ['path']
    ),
    runtimeTool(
      'game_ui_popup',
      'Show, hide, or position a live Popup / Window node.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the popup node.' },
        action: { type: 'string', description: 'Action: show | hide | popup_centered.' },
      },
      'ui_popup',
      ['path', 'action']
    ),
    runtimeTool(
      'game_ui_tree',
      'Manipulate a live Tree control (add/remove/select items, expand).',
      true,
      {
        path: { type: 'string', description: 'NodePath of the Tree node.' },
        action: { type: 'string', description: 'Action: select | expand | collapse | clear.' },
        item: { description: 'Target item path/index for the action.' },
      },
      'ui_tree',
      ['path', 'action']
    ),
    runtimeTool(
      'game_ui_item_list',
      'Manipulate a live ItemList control (add/remove/select items).',
      true,
      {
        path: { type: 'string', description: 'NodePath of the ItemList node.' },
        action: { type: 'string', description: 'Action: add | remove | select | clear.' },
        item: { description: 'Item text or index for the action.' },
      },
      'ui_item_list',
      ['path', 'action']
    ),
    runtimeTool(
      'game_ui_tabs',
      'Control a live TabContainer / TabBar (switch, add, remove tabs).',
      true,
      {
        path: { type: 'string', description: 'NodePath of the tab node.' },
        action: { type: 'string', description: 'Action: select | add | remove.' },
        tab: { description: 'Tab index or title for the action.' },
      },
      'ui_tabs',
      ['path', 'action']
    ),
    runtimeTool(
      'game_ui_menu',
      'Interact with a live MenuButton / PopupMenu (open, select an item).',
      true,
      {
        path: { type: 'string', description: 'NodePath of the menu node.' },
        action: { type: 'string', description: 'Action: open | select.' },
        item: { description: 'Menu item index or id for select.' },
      },
      'ui_menu',
      ['path', 'action']
    ),
    runtimeTool(
      'game_ui_range',
      'Set the value of a live Range control (Slider, ProgressBar, SpinBox).',
      true,
      {
        path: { type: 'string', description: 'NodePath of the Range node.' },
        value: { type: 'number', description: 'Value to assign within the control range.' },
      },
      'ui_range',
      ['path', 'value']
    ),

    // -----------------------------------------------------------------------
    // Step 5a - advanced runtime tier (RUN channel). Family 16 (advanced
    // runtime: camera, physics queries, spawning, shaders, audio, navigation,
    // tilemaps, collision, environment, groups, timers, particles, animation
    // authoring, state serialization, joints, bones, themes, viewport, debug
    // draw). Risk bands live in src/policy/risk.ts and are frozen in
    // src/tools/schema-lock.ts. The live game's runtime-bridge autoload owns
    // each op's semantics (docs/godot-mcp.md). Reads are LOW; transient visual
    // effects are MEDIUM; persistent live mutations are HIGH.
    // -----------------------------------------------------------------------
    runtimeTool(
      'game_get_camera',
      'Read the active live camera (2D/3D) state - position, zoom/fov, current flag. Read-only.',
      false,
      { path: { type: 'string', description: 'Optional NodePath of a specific camera; defaults to the active one.' } },
      'get_camera'
    ),
    runtimeTool(
      'game_set_camera',
      'Set live camera state (position, zoom/fov, make_current) on a Camera2D/Camera3D node.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the camera node.' },
        property: { type: 'string', description: 'Camera property, e.g. position, zoom, fov, current.' },
        value: { description: 'Value to assign.' },
      },
      'set_camera',
      ['path', 'property', 'value']
    ),
    runtimeTool(
      'game_raycast',
      'Cast a ray in the live physics world and return the first collision (collider, point, normal). Read-only query.',
      false,
      {
        from: { type: 'array', description: 'Ray origin [x, y] (2D) or [x, y, z] (3D).' },
        to: { type: 'array', description: 'Ray end point [x, y] or [x, y, z].' },
        space: { type: 'string', description: 'Physics space: 2d | 3d (default 3d).' },
      },
      'raycast',
      ['from', 'to']
    ),
    runtimeTool(
      'game_get_audio',
      'Read live audio state - bus volumes, playing streams, listener position. Read-only.',
      false,
      { bus: { type: 'string', description: 'Optional bus name to scope the query.' } },
      'get_audio'
    ),
    runtimeTool(
      'game_spawn_node',
      'Spawn a new node of a given class under a parent in the running game, with optional initial properties.',
      true,
      {
        type: { type: 'string', description: 'Godot class to instantiate, e.g. Sprite2D, RigidBody3D.' },
        parent: { type: 'string', description: 'Parent NodePath (default the current scene root).' },
        name: { type: 'string', description: 'Optional name for the new node.' },
        properties: { type: 'object', description: 'Initial property map applied after spawn.' },
      },
      'spawn_node',
      ['type']
    ),
    runtimeTool(
      'game_set_shader_param',
      'Set a shader parameter (uniform) on a live node\'s material in the running game.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the node holding the ShaderMaterial.' },
        parameter: { type: 'string', description: 'Shader uniform name.' },
        value: { description: 'Value to assign to the uniform.' },
      },
      'set_shader_param',
      ['path', 'parameter', 'value']
    ),
    runtimeTool(
      'game_audio_play',
      'Play an audio stream (res:// path) on a live AudioStreamPlayer node or spawn a one-shot.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the AudioStreamPlayer (optional for one-shot).' },
        stream: { type: 'string', description: 'Audio stream res:// path to play.' },
        bus: { type: 'string', description: 'Optional target audio bus.' },
      },
      'audio_play',
      ['stream']
    ),
    runtimeTool(
      'game_audio_bus',
      'Set live audio bus volume/mute in the running game.',
      true,
      {
        bus: { type: 'string', description: 'Audio bus name.' },
        volumeDb: { type: 'number', description: 'Volume in dB.' },
        mute: { type: 'boolean', description: 'Mute the bus.' },
      },
      'audio_bus',
      ['bus']
    ),
    runtimeTool(
      'game_navigate_path',
      'Query a navigation path between two points on the live NavigationServer (read-only).',
      false,
      {
        from: { type: 'array', description: 'Start point [x, y] or [x, y, z].' },
        to: { type: 'array', description: 'Goal point [x, y] or [x, y, z].' },
        space: { type: 'string', description: 'Navigation space: 2d | 3d (default 3d).' },
      },
      'navigate_path',
      ['from', 'to']
    ),
    runtimeTool(
      'game_tilemap',
      'Edit a live TileMap/TileMapLayer (set/erase cells, set a region).',
      true,
      {
        path: { type: 'string', description: 'NodePath of the TileMap node.' },
        action: { type: 'string', description: 'Action: set_cell | erase_cell | clear.' },
        coords: { type: 'array', description: 'Cell coordinates [x, y].' },
        source: { type: 'number', description: 'Tile source id (for set_cell).' },
        atlas: { type: 'array', description: 'Atlas coords [x, y] (for set_cell).' },
      },
      'tilemap',
      ['path', 'action']
    ),
    runtimeTool(
      'game_add_collision',
      'Add a collision shape to a live physics body node in the running game.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the physics body.' },
        shape: { type: 'string', description: 'Shape type, e.g. rectangle, circle, capsule, box, sphere.' },
        size: { description: 'Shape size/extents (number or array per shape).' },
      },
      'add_collision',
      ['path', 'shape']
    ),
    runtimeTool(
      'game_environment',
      'Configure the live WorldEnvironment (ambient light, fog, tonemap, background).',
      true,
      {
        property: { type: 'string', description: 'Environment property, e.g. ambient_light_energy, fog_enabled.' },
        value: { description: 'Value to assign.' },
      },
      'environment',
      ['property', 'value']
    ),
    runtimeTool(
      'game_manage_group',
      'Add or remove a live node from a SceneTree group in the running game.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the node.' },
        group: { type: 'string', description: 'Group name.' },
        action: { type: 'string', description: 'Action: add | remove (default add).' },
      },
      'manage_group',
      ['path', 'group']
    ),
    runtimeTool(
      'game_create_timer',
      'Create a live SceneTree timer (one-shot or repeating) and return its handle.',
      true,
      {
        seconds: { type: 'number', description: 'Timer duration in seconds.' },
        repeat: { type: 'boolean', description: 'Repeat instead of one-shot (default false).' },
      },
      'create_timer',
      ['seconds']
    ),
    runtimeTool(
      'game_set_particles',
      'Configure a live particle system node (GPUParticles2D/3D): emitting, amount, lifetime.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the particles node.' },
        property: { type: 'string', description: 'Particle property, e.g. emitting, amount, lifetime.' },
        value: { description: 'Value to assign.' },
      },
      'set_particles',
      ['path', 'property', 'value']
    ),
    runtimeTool(
      'game_create_animation',
      'Author a new animation on a live AnimationPlayer at runtime (tracks + keyframes).',
      true,
      {
        path: { type: 'string', description: 'NodePath of the AnimationPlayer.' },
        name: { type: 'string', description: 'Animation name to create.' },
        tracks: { type: 'array', description: 'Track definitions (property path + keyframes).' },
        length: { type: 'number', description: 'Animation length in seconds.' },
      },
      'create_animation',
      ['path', 'name']
    ),
    runtimeTool(
      'game_serialize_state',
      'Serialize live game/node state to a portable structure (snapshot) for save/restore. Read-only snapshot.',
      false,
      {
        path: { type: 'string', description: 'Optional root NodePath to serialize (default the scene root).' },
      },
      'serialize_state'
    ),
    runtimeTool(
      'game_physics_body',
      'Apply a live physics action to a body (impulse, force, set velocity).',
      true,
      {
        path: { type: 'string', description: 'NodePath of the physics body.' },
        action: { type: 'string', description: 'Action: apply_impulse | apply_force | set_velocity.' },
        vector: { type: 'array', description: 'Vector value [x, y] or [x, y, z].' },
      },
      'physics_body',
      ['path', 'action', 'vector']
    ),
    runtimeTool(
      'game_create_joint',
      'Create a live physics joint connecting two bodies in the running game.',
      true,
      {
        type: { type: 'string', description: 'Joint type, e.g. pin, hinge, spring, generic.' },
        bodyA: { type: 'string', description: 'NodePath of the first body.' },
        bodyB: { type: 'string', description: 'NodePath of the second body.' },
        properties: { type: 'object', description: 'Optional joint properties.' },
      },
      'create_joint',
      ['type', 'bodyA', 'bodyB']
    ),
    runtimeTool(
      'game_bone_pose',
      'Set the pose (rotation/position/scale) of a bone on a live Skeleton2D/3D node.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the Skeleton node.' },
        bone: { description: 'Bone name or index.' },
        property: { type: 'string', description: 'Pose property, e.g. rotation, position, scale.' },
        value: { description: 'Value to assign.' },
      },
      'bone_pose',
      ['path', 'bone', 'property', 'value']
    ),
    runtimeTool(
      'game_ui_theme',
      'Apply or override a live theme property on a Control node (color, font, constant, stylebox).',
      true,
      {
        path: { type: 'string', description: 'NodePath of the Control node.' },
        type: { type: 'string', description: 'Theme item type: color | font | font_size | constant | stylebox.' },
        name: { type: 'string', description: 'Theme item name, e.g. font_color.' },
        value: { description: 'Value to assign.' },
      },
      'ui_theme',
      ['path', 'type', 'name']
    ),
    runtimeTool(
      'game_viewport',
      'Configure a live Viewport/SubViewport (size, render target, world, msaa).',
      true,
      {
        path: { type: 'string', description: 'NodePath of the Viewport (default the root viewport).' },
        property: { type: 'string', description: 'Viewport property, e.g. size, msaa_3d, render_target_update_mode.' },
        value: { description: 'Value to assign.' },
      },
      'viewport',
      ['property', 'value']
    ),
    runtimeTool(
      'game_debug_draw',
      'Toggle or issue live debug drawing in the running game (collision shapes, custom primitives). Transient overlay.',
      true,
      {
        action: { type: 'string', description: 'Action: line | box | sphere | clear | toggle.' },
        params: { type: 'object', description: 'Draw parameters (points, color, duration) per action.' },
      },
      'debug_draw',
      ['action']
    ),

    // -----------------------------------------------------------------------
    // Step 5b - advanced rendering tier (RUN channel). Family 18 (networking),
    // 20 (3D rendering & geometry), 21 (2D systems), 26 (rendering & resources).
    // Networking tools reach the host and are CRITICAL (approval-gated even in
    // danger). 3D/2D construction and rendering mutate live scene state (HIGH).
    // Risk bands live in src/policy/risk.ts and are frozen in schema-lock.ts;
    // the live game's runtime-bridge autoload owns each op's semantics.
    // -----------------------------------------------------------------------

    // Family 18: networking (all CRITICAL).
    runtimeTool(
      'game_http_request',
      'Issue an HTTP request from the running game (reaches the host network). CRITICAL: approval-gated even in danger mode.',
      true,
      {
        url: { type: 'string', description: 'Request URL.' },
        method: { type: 'string', description: 'HTTP method (GET, POST, ...); default GET.' },
        headers: { type: 'object', description: 'Optional request headers.' },
        body: { type: 'string', description: 'Optional request body.' },
      },
      'http_request',
      ['url']
    ),
    runtimeTool(
      'game_websocket',
      'Open, send on, or close a WebSocket connection from the running game. CRITICAL: reaches the host network.',
      true,
      {
        action: { type: 'string', description: 'Action: connect | send | close.' },
        url: { type: 'string', description: 'WebSocket URL (for connect).' },
        message: { type: 'string', description: 'Message payload (for send).' },
      },
      'websocket',
      ['action']
    ),
    runtimeTool(
      'game_multiplayer',
      'Manage the live multiplayer peer (host/join/disconnect) in the running game. CRITICAL: opens network sockets.',
      true,
      {
        action: { type: 'string', description: 'Action: host | join | disconnect.' },
        address: { type: 'string', description: 'Peer address (for join).' },
        port: { type: 'number', description: 'Network port.' },
      },
      'multiplayer',
      ['action']
    ),
    runtimeTool(
      'game_rpc',
      'Invoke an RPC method on a networked node in the running game. CRITICAL: executes a remote procedure call.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the target node.' },
        method: { type: 'string', description: 'RPC method name.' },
        args: { type: 'array', description: 'RPC arguments.' },
      },
      'rpc',
      ['path', 'method']
    ),

    // Family 20: 3D rendering & geometry (all HIGH).
    runtimeTool(
      'game_csg',
      'Create or modify a live CSG node (union/subtract/intersect) for constructive 3D geometry.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the CSG node (or parent for create).' },
        shape: { type: 'string', description: 'CSG shape: box | sphere | cylinder | mesh | combiner.' },
        operation: { type: 'string', description: 'Boolean operation: union | intersection | subtraction.' },
        properties: { type: 'object', description: 'Optional shape/operation properties.' },
      },
      'csg',
      ['shape']
    ),
    runtimeTool(
      'game_multimesh',
      'Configure a live MultiMeshInstance (instance count, transforms) for efficient instanced 3D rendering.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the MultiMeshInstance node.' },
        count: { type: 'number', description: 'Instance count.' },
        transforms: { type: 'array', description: 'Per-instance transforms.' },
      },
      'multimesh',
      ['path']
    ),
    runtimeTool(
      'game_procedural_mesh',
      'Build a procedural mesh on a live node from vertices/indices/normals (SurfaceTool/ArrayMesh).',
      true,
      {
        path: { type: 'string', description: 'NodePath of the MeshInstance3D node.' },
        vertices: { type: 'array', description: 'Vertex positions.' },
        indices: { type: 'array', description: 'Optional index array.' },
        normals: { type: 'array', description: 'Optional normals.' },
      },
      'procedural_mesh',
      ['path', 'vertices']
    ),
    runtimeTool(
      'game_light_3d',
      'Create or configure a live 3D light (Directional/Omni/Spot): energy, color, range, shadows.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the light node (or parent for create).' },
        kind: { type: 'string', description: 'Light kind: directional | omni | spot.' },
        property: { type: 'string', description: 'Property to set, e.g. light_energy, light_color.' },
        value: { description: 'Value to assign.' },
      },
      'light_3d',
      ['path']
    ),
    runtimeTool(
      'game_mesh_instance',
      'Assign or modify the mesh/material of a live MeshInstance3D node.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the MeshInstance3D node.' },
        mesh: { type: 'string', description: 'Mesh res:// path to assign.' },
        material: { type: 'string', description: 'Material res:// path to assign.' },
      },
      'mesh_instance',
      ['path']
    ),
    runtimeTool(
      'game_gridmap',
      'Edit a live GridMap (set/erase cells using a MeshLibrary item).',
      true,
      {
        path: { type: 'string', description: 'NodePath of the GridMap node.' },
        action: { type: 'string', description: 'Action: set_cell | erase_cell | clear.' },
        coords: { type: 'array', description: 'Cell coordinates [x, y, z].' },
        item: { type: 'number', description: 'MeshLibrary item id (for set_cell).' },
      },
      'gridmap',
      ['path', 'action']
    ),
    runtimeTool(
      'game_3d_effects',
      'Toggle or configure live 3D post-processing effects (SSAO, SSR, glow, DOF) via the environment.',
      true,
      {
        effect: { type: 'string', description: 'Effect: ssao | ssr | glow | dof | sdfgi.' },
        enabled: { type: 'boolean', description: 'Enable or disable the effect.' },
        properties: { type: 'object', description: 'Optional effect parameters.' },
      },
      '3d_effects',
      ['effect']
    ),
    runtimeTool(
      'game_gi',
      'Configure live global illumination (VoxelGI / LightmapGI / SDFGI) in the running game.',
      true,
      {
        kind: { type: 'string', description: 'GI kind: voxel | lightmap | sdfgi.' },
        action: { type: 'string', description: 'Action: enable | disable | bake.' },
        properties: { type: 'object', description: 'Optional GI parameters.' },
      },
      'gi',
      ['kind', 'action']
    ),
    runtimeTool(
      'game_path_3d',
      'Create or modify a live Path3D curve (points/handles) for 3D path following.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the Path3D node (or parent for create).' },
        points: { type: 'array', description: 'Curve points [[x,y,z], ...].' },
      },
      'path_3d',
      ['path']
    ),
    runtimeTool(
      'game_sky',
      'Configure the live sky/background (procedural sky, panorama, color) on the WorldEnvironment.',
      true,
      {
        mode: { type: 'string', description: 'Sky mode: procedural | panorama | physical | color.' },
        properties: { type: 'object', description: 'Sky parameters (top/horizon color, energy, texture).' },
      },
      'sky',
      ['mode']
    ),
    runtimeTool(
      'game_camera_attributes',
      'Set live CameraAttributes (exposure, depth of field, auto-exposure) on a 3D camera.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the Camera3D node.' },
        property: { type: 'string', description: 'Attribute, e.g. exposure_multiplier, dof_blur_far_enabled.' },
        value: { description: 'Value to assign.' },
      },
      'camera_attributes',
      ['path', 'property', 'value']
    ),
    runtimeTool(
      'game_navigation_3d',
      'Manage a live 3D navigation region/agent (bake region, set target, query). 3D nav authoring.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the NavigationRegion3D / agent node.' },
        action: { type: 'string', description: 'Action: bake | set_target | enable | disable.' },
        target: { type: 'array', description: 'Target point [x, y, z] (for set_target).' },
      },
      'navigation_3d',
      ['path', 'action']
    ),
    runtimeTool(
      'game_physics_3d',
      'Run a live 3D physics action or query (shape cast, intersect, set gravity). Queries are read-only.',
      true,
      {
        action: { type: 'string', description: 'Action: shape_cast | intersect | set_gravity | apply.' },
        path: { type: 'string', description: 'Optional NodePath of the body.' },
        params: { type: 'object', description: 'Action/query parameters.' },
      },
      'physics_3d',
      ['action']
    ),

    // Family 21: 2D systems (all HIGH).
    runtimeTool(
      'game_canvas',
      'Configure a live CanvasLayer/CanvasItem (layer, offset, modulate, visibility) in the running game.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the canvas node.' },
        property: { type: 'string', description: 'Property, e.g. layer, offset, modulate, visible.' },
        value: { description: 'Value to assign.' },
      },
      'canvas',
      ['path', 'property', 'value']
    ),
    runtimeTool(
      'game_canvas_draw',
      'Issue immediate-mode 2D drawing on a live canvas item (line, rect, circle, polygon, text).',
      true,
      {
        path: { type: 'string', description: 'NodePath of the CanvasItem to draw on.' },
        primitive: { type: 'string', description: 'Primitive: line | rect | circle | polygon | text | clear.' },
        params: { type: 'object', description: 'Draw parameters (points, color, width, text).' },
      },
      'canvas_draw',
      ['path', 'primitive']
    ),
    runtimeTool(
      'game_light_2d',
      'Create or configure a live 2D light (PointLight2D/DirectionalLight2D): energy, color, texture, range.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the light node (or parent for create).' },
        kind: { type: 'string', description: 'Light kind: point | directional.' },
        property: { type: 'string', description: 'Property, e.g. energy, color, texture_scale.' },
        value: { description: 'Value to assign.' },
      },
      'light_2d',
      ['path']
    ),
    runtimeTool(
      'game_parallax',
      'Configure a live ParallaxBackground/ParallaxLayer (motion scale, offset, mirroring) for 2D scrolling.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the parallax node.' },
        property: { type: 'string', description: 'Property, e.g. motion_scale, motion_offset, motion_mirroring.' },
        value: { description: 'Value to assign.' },
      },
      'parallax',
      ['path', 'property', 'value']
    ),
    runtimeTool(
      'game_shape_2d',
      'Create or modify a live 2D shape (rectangle, circle, capsule, polygon) on a node.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the node holding the shape.' },
        shape: { type: 'string', description: 'Shape: rectangle | circle | capsule | polygon | segment.' },
        params: { type: 'object', description: 'Shape parameters (size, radius, points).' },
      },
      'shape_2d',
      ['path', 'shape']
    ),
    runtimeTool(
      'game_path_2d',
      'Create or modify a live Path2D curve (points/handles) for 2D path following.',
      true,
      {
        path: { type: 'string', description: 'NodePath of the Path2D node (or parent for create).' },
        points: { type: 'array', description: 'Curve points [[x,y], ...].' },
      },
      'path_2d',
      ['path']
    ),
    runtimeTool(
      'game_physics_2d',
      'Run a live 2D physics action or query (shape cast, intersect, set gravity). Queries are read-only.',
      true,
      {
        action: { type: 'string', description: 'Action: shape_cast | intersect | set_gravity | apply.' },
        path: { type: 'string', description: 'Optional NodePath of the body.' },
        params: { type: 'object', description: 'Action/query parameters.' },
      },
      'physics_2d',
      ['action']
    ),

    // Family 26: rendering & resources (HIGH; resource load/preload are reads).
    runtimeTool(
      'game_render_settings',
      'Configure live rendering settings (MSAA, scaling, debug draw mode, viewport flags) in the running game.',
      true,
      {
        property: { type: 'string', description: 'Render setting, e.g. msaa_3d, scaling_3d_scale, debug_draw.' },
        value: { description: 'Value to assign.' },
      },
      'render_settings',
      ['property', 'value']
    ),
    runtimeTool(
      'game_resource',
      'Manage a live resource (load, preload, save, free). load/preload are read-only fetches; save/free mutate.',
      true,
      {
        action: { type: 'string', description: 'Action: load | preload | save | free.' },
        path: { type: 'string', description: 'Resource res:// path.' },
        target: { type: 'string', description: 'Optional NodePath/property to assign the resource to.' },
      },
      'resource',
      ['action', 'path']
    ),

    // -----------------------------------------------------------------------
    // Step 5c - project management (PROC channel) + headless project/scene CLI
    // + project/editor management (Families 1, 2 writes, 15, 24, 17). These
    // close the gap to full 149-tool parity. The PROC tools launch the Godot
    // binary through the shared ProcessManager (so they stream output and are
    // governed like any other long-running process); the rest are headless,
    // text-based edits to project files via GodotCli (no running game needed).
    // -----------------------------------------------------------------------

    // Family 1: project management (PROC). Launch/run/stop go through the
    // process manager; reads are LOW.
    gameTool(
      'game_list_projects',
      'Discover Godot projects under a directory (one level deep): any folder containing project.godot. No engine required.',
      false,
      {
        searchDir: { type: 'string', description: 'Directory to scan. Defaults to the active workspace.' },
      },
      async (args, ctx) => {
        const dir = typeof args.searchDir === 'string' && args.searchDir.length ? args.searchDir : ctx.projectRoot;
        const res = cli(ctx).listProjects(dir);
        return res.ok
          ? { ok: true, data: { count: res.data?.projects.length ?? 0, ...res.data } }
          : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_run_project',
      'Run a Godot project (godot --path <root>) as a managed process. Returns a sessionId; stream output with process_tail / game_get_debug_output and stop with game_stop_project.',
      true,
      {
        ...PROJECT_PROP,
        scene: { type: 'string', description: 'Optional scene to run instead of the main scene.' },
      },
      async (args, ctx) => launchGodot(ctx, args, 'run'),
    ),

    gameTool(
      'game_launch_editor',
      'Open the Godot editor on a project (godot --editor --path <root>) as a managed process. Returns a sessionId.',
      true,
      { ...PROJECT_PROP },
      async (args, ctx) => launchGodot(ctx, args, 'editor'),
    ),

    gameTool(
      'game_stop_project',
      'Stop a running Godot process started by game_run_project / game_launch_editor / game_export_project.',
      true,
      { sessionId: { type: 'string', description: 'The process session id to stop.' } },
      async (args, ctx) => {
        const id = String(args.sessionId ?? '');
        if (!id) return { ok: false, error: 'sessionId is required.' };
        if (!ctx.container.processes.isManaged(id)) {
          return { ok: false, error: `Unknown or already-finished session: ${id}` };
        }
        const s = ctx.container.processes.stop(id);
        ctx.container.audit.record({ type: 'process_event', summary: `game_stop_project ${id}` });
        return { ok: true, data: { sessionId: s.sessionId, status: s.status } };
      }
    ),

    gameTool(
      'game_get_debug_output',
      'Read buffered stdout/stderr from a running Godot process by sessionId (secrets redacted).',
      false,
      { sessionId: { type: 'string', description: 'The process session id to read from.' } },
      async (args, ctx) => {
        const id = String(args.sessionId ?? '');
        if (!id) return { ok: false, error: 'sessionId is required.' };
        if (!ctx.container.processes.isManaged(id)) {
          return { ok: false, error: `Unknown or already-finished session: ${id}` };
        }
        const out = ctx.container.processes.read(id);
        return { ok: true, data: { ...out, output: ctx.container.policy.secret.redact(out.output) } };
      }
    ),

    // Family 17: build & export (PROC).
    gameTool(
      'game_export_project',
      'Export a Godot project with a configured preset (godot --headless --export-release <preset> <out>) as a managed process. Returns a sessionId.',
      true,
      {
        ...PROJECT_PROP,
        preset: { type: 'string', description: 'Export preset name (must exist in export_presets.cfg).' },
        outputPath: { type: 'string', description: 'Output file path for the exported build.' },
        debug: { type: 'boolean', description: 'Export a debug build (--export-debug) instead of release.' },
      },
      async (args, ctx) => {
        const preset = String(args.preset ?? '');
        const out = String(args.outputPath ?? '');
        if (!preset) return { ok: false, error: 'preset is required.' };
        if (!out) return { ok: false, error: 'outputPath is required.' };
        return launchGodot(ctx, args, args.debug ? 'export-debug' : 'export-release', { preset, out });
      }
    ),

    // Family 2 (writes): scene save + UID maintenance (CLI).
    gameTool(
      'game_save_scene',
      'Validate and rewrite a text .tscn scene (headless save round-trip). Confirms the scene parses and is well-formed.',
      true,
      {
        ...PROJECT_PROP,
        scenePath: { type: 'string', description: 'Scene file path (project-relative or res://...).' },
      },
      async (args, ctx) => {
        const scene = String(args.scenePath ?? '');
        if (!scene) return { ok: false, error: 'scenePath is required.' };
        const res = cli(ctx).saveScene(projectRoot(ctx, args), scene);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_get_uid',
      'Read the uid:// identifier from a text scene/resource header (Godot 4.4+). Returns uid:null when absent.',
      false,
      {
        ...PROJECT_PROP,
        filePath: { type: 'string', description: 'File path (project-relative or res://...).' },
      },
      async (args, ctx) => {
        const file = String(args.filePath ?? '');
        if (!file) return { ok: false, error: 'filePath is required.' };
        const res = cli(ctx).getUid(projectRoot(ctx, args), file);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_update_project_uids',
      'Regenerate the Godot UID cache (godot --headless --import) so moved/renamed resources keep stable uid:// references. Runs to completion.',
      true,
      { ...PROJECT_PROP },
      async (args, ctx) => launchGodot(ctx, args, 'import'),
    ),

    // Family 15: project creation + project-config management (CLI).
    gameTool(
      'game_create_project',
      'Create a new Godot project: make the directory and write a minimal valid project.godot. CRITICAL - it bootstraps a new project on disk; approval-gated.',
      true,
      {
        targetDir: { type: 'string', description: 'Directory to create the project in.' },
        name: { type: 'string', description: 'Project display name (config/name).' },
        features: { type: 'string', description: 'Godot feature/version tag, e.g. "4.4". Defaults to 4.4.' },
        mainScene: { type: 'string', description: 'Optional main scene res:// path.' },
        overwrite: { type: 'boolean', description: 'Overwrite an existing project.godot.' },
      },
      async (args, ctx) => {
        const dir = String(args.targetDir ?? '');
        const name = String(args.name ?? '');
        if (!dir) return { ok: false, error: 'targetDir is required.' };
        if (!name) return { ok: false, error: 'name is required.' };
        const res = cli(ctx).createProject(dir, name, {
          ...(typeof args.features === 'string' ? { features: args.features } : {}),
          ...(typeof args.mainScene === 'string' ? { mainScene: args.mainScene } : {}),
          overwrite: args.overwrite === true,
        });
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_manage_autoloads',
      'Add or remove an autoload (singleton) in project.godot under [autoload].',
      true,
      {
        ...PROJECT_PROP,
        op: { type: 'string', description: 'add | remove.' },
        name: { type: 'string', description: 'Autoload singleton name.' },
        scriptPath: { type: 'string', description: 'res:// script/scene path (required for add).' },
      },
      async (args, ctx) => {
        const op = String(args.op ?? '');
        const name = String(args.name ?? '');
        if (op !== 'add' && op !== 'remove') return { ok: false, error: 'op must be "add" or "remove".' };
        if (!name) return { ok: false, error: 'name is required.' };
        const res = cli(ctx).manageAutoloads(
          projectRoot(ctx, args), op, name,
          typeof args.scriptPath === 'string' ? args.scriptPath : undefined
        );
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_manage_input_map',
      'Define or remove an input action (InputMap) in project.godot under [input].',
      true,
      {
        ...PROJECT_PROP,
        op: { type: 'string', description: 'add | remove.' },
        action: { type: 'string', description: 'Input action name.' },
        keys: { type: 'array', description: 'Physical key names for the action (add only).' },
      },
      async (args, ctx) => {
        const op = String(args.op ?? '');
        const action = String(args.action ?? '');
        if (op !== 'add' && op !== 'remove') return { ok: false, error: 'op must be "add" or "remove".' };
        if (!action) return { ok: false, error: 'action is required.' };
        const keys = Array.isArray(args.keys) ? args.keys.map(String) : [];
        const res = cli(ctx).manageInputMap(projectRoot(ctx, args), op, action, keys);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_manage_export_presets',
      'Set an export preset key in export_presets.cfg via a section/key/value edit. Bootstraps the file if missing.',
      true,
      {
        ...PROJECT_PROP,
        preset: { type: 'string', description: 'Preset index/section, e.g. "preset.0".' },
        key: { type: 'string', description: 'Preset key, e.g. name, platform, export_path.' },
        value: { type: 'string', description: 'Value to assign.' },
      },
      async (args, ctx) => {
        const preset = String(args.preset ?? '');
        const key = String(args.key ?? '');
        const value = String(args.value ?? '');
        if (!preset || !key) return { ok: false, error: 'preset and key are required.' };
        const res = cli(ctx).setExportPreset(projectRoot(ctx, args), preset, key, value);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    // Family 24: editor & project tools (CLI, project.godot-backed).
    gameTool(
      'game_manage_layers',
      'Name a physics/render layer in project.godot under [layer_names], e.g. 2d_physics/3d_render.',
      true,
      {
        ...PROJECT_PROP,
        kind: { type: 'string', description: 'Layer group, e.g. 2d_physics | 2d_render | 3d_physics | 3d_render.' },
        index: { type: 'number', description: 'Layer index (1-32).' },
        name: { type: 'string', description: 'Human-readable layer name.' },
      },
      async (args, ctx) => {
        const kind = String(args.kind ?? '');
        const name = String(args.name ?? '');
        const index = Number(args.index);
        if (!kind || !name) return { ok: false, error: 'kind and name are required.' };
        if (!Number.isInteger(index)) return { ok: false, error: 'index must be an integer.' };
        const res = cli(ctx).manageLayers(projectRoot(ctx, args), kind, index, name);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_manage_plugins',
      'Enable or disable an editor plugin in project.godot under [editor_plugins].',
      true,
      {
        ...PROJECT_PROP,
        op: { type: 'string', description: 'enable | disable.' },
        pluginPath: { type: 'string', description: 'Plugin addon name or res://addons/<name>/plugin.cfg path.' },
      },
      async (args, ctx) => {
        const op = String(args.op ?? '');
        const pluginPath = String(args.pluginPath ?? '');
        if (op !== 'enable' && op !== 'disable') return { ok: false, error: 'op must be "enable" or "disable".' };
        if (!pluginPath) return { ok: false, error: 'pluginPath is required.' };
        const res = cli(ctx).managePlugins(projectRoot(ctx, args), op, pluginPath);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    gameTool(
      'game_manage_translations',
      'Register translation files in project.godot under [internationalization] locale/translations.',
      true,
      {
        ...PROJECT_PROP,
        files: { type: 'array', description: 'res:// .po/.translation file paths.' },
      },
      async (args, ctx) => {
        const files = Array.isArray(args.files) ? args.files.map(String) : [];
        if (files.length === 0) return { ok: false, error: 'files must be a non-empty array.' };
        const res = cli(ctx).manageTranslations(projectRoot(ctx, args), files);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    // --- Step 5d: remaining editor/scene helpers (149/149) ---

    // Family 2: attach a texture to a sprite-like node in a scene.
    gameTool(
      'game_load_sprite',
      'Attach a texture (res:// path) to a sprite-like node in a .tscn: ensures a Texture2D ext_resource and sets the node property (default "texture").',
      true,
      {
        ...PROJECT_PROP,
        scenePath: { type: 'string', description: 'res:// or project-relative .tscn path.' },
        node: { type: 'string', description: 'Target node name.' },
        texturePath: { type: 'string', description: 'res:// path to the texture asset.' },
        property: { type: 'string', description: 'Node property to set (default "texture").' },
      },
      async (args, ctx) => {
        const scenePath = String(args.scenePath ?? '');
        const node = String(args.node ?? '');
        const texturePath = String(args.texturePath ?? '');
        if (!scenePath || !node || !texturePath) {
          return { ok: false, error: 'scenePath, node, and texturePath are required.' };
        }
        const property = typeof args.property === 'string' && args.property.length ? args.property : 'texture';
        const res = cli(ctx).loadSprite(projectRoot(ctx, args), scenePath, node, texturePath, property);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    // Family 2: export a scene's meshes to a MeshLibrary resource.
    gameTool(
      'game_export_mesh_library',
      'Export a scene to a MeshLibrary resource (.meshlib/.tres/.res) referencing the source scene. Refuses to clobber unless overwrite=true.',
      true,
      {
        ...PROJECT_PROP,
        scenePath: { type: 'string', description: 'res:// or project-relative source .tscn.' },
        outPath: { type: 'string', description: 'Output MeshLibrary path (.meshlib/.tres/.res).' },
        overwrite: { type: 'boolean', description: 'Replace an existing output file.' },
      },
      async (args, ctx) => {
        const scenePath = String(args.scenePath ?? '');
        const outPath = String(args.outPath ?? '');
        if (!scenePath || !outPath) return { ok: false, error: 'scenePath and outPath are required.' };
        const res = cli(ctx).exportMeshLibrary(projectRoot(ctx, args), scenePath, outPath, args.overwrite === true);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    // Family 24: manage [connection] entries in a scene.
    gameTool(
      'game_manage_scene_signals',
      'Manage [connection] entries in a .tscn: op connect | disconnect | list. connect/disconnect require signal, from, to, method.',
      true,
      {
        ...PROJECT_PROP,
        scenePath: { type: 'string', description: 'res:// or project-relative .tscn path.' },
        op: { type: 'string', description: 'connect | disconnect | list.' },
        signal: { type: 'string', description: 'Signal name (connect/disconnect).' },
        from: { type: 'string', description: 'Emitter node path (connect/disconnect).' },
        to: { type: 'string', description: 'Receiver node path (connect/disconnect).' },
        method: { type: 'string', description: 'Receiver method (connect/disconnect).' },
      },
      async (args, ctx) => {
        const scenePath = String(args.scenePath ?? '');
        const op = String(args.op ?? '');
        if (!scenePath) return { ok: false, error: 'scenePath is required.' };
        if (op !== 'connect' && op !== 'disconnect' && op !== 'list') {
          return { ok: false, error: 'op must be "connect", "disconnect", or "list".' };
        }
        const res = cli(ctx).manageSceneSignals(projectRoot(ctx, args), scenePath, op, {
          signal: args.signal ? String(args.signal) : undefined,
          from: args.from ? String(args.from) : undefined,
          to: args.to ? String(args.to) : undefined,
          method: args.method ? String(args.method) : undefined,
        });
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    // Family 24: create/overwrite a shader file (CRITICAL - executable GPU code).
    gameTool(
      'game_manage_shader',
      'Create or overwrite a .gdshader file (CRITICAL). Writes a canvas_item stub unless explicit content is supplied.',
      true,
      {
        ...PROJECT_PROP,
        shaderPath: { type: 'string', description: 'res:// or project-relative .gdshader path.' },
        content: { type: 'string', description: 'Full shader source (optional).' },
        shaderType: { type: 'string', description: 'shader_type for the stub (default canvas_item).' },
        overwrite: { type: 'boolean', description: 'Replace an existing shader.' },
      },
      async (args, ctx) => {
        const shaderPath = String(args.shaderPath ?? '');
        if (!shaderPath) return { ok: false, error: 'shaderPath is required.' };
        const res = cli(ctx).manageShader(projectRoot(ctx, args), shaderPath, {
          content: args.content ? String(args.content) : undefined,
          shaderType: args.shaderType ? String(args.shaderType) : undefined,
          overwrite: args.overwrite === true,
        });
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    // Family 24: create/update a Theme resource.
    gameTool(
      'game_manage_theme_resource',
      'Create or update a Theme .tres resource. With no properties it bootstraps an empty Theme; with properties it upserts scalar/string entries.',
      true,
      {
        ...PROJECT_PROP,
        resPath: { type: 'string', description: 'res:// or project-relative .tres path.' },
        properties: { type: 'object', description: 'Key/value resource properties to upsert.' },
        overwrite: { type: 'boolean', description: 'Replace an existing resource on create.' },
      },
      async (args, ctx) => {
        const resPath = String(args.resPath ?? '');
        if (!resPath) return { ok: false, error: 'resPath is required.' };
        const properties =
          args.properties && typeof args.properties === 'object'
            ? (args.properties as Record<string, unknown>)
            : {};
        const res = cli(ctx).manageThemeResource(projectRoot(ctx, args), resPath, properties, args.overwrite === true);
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    // Family 24: generic text-resource management (create | set | read).
    gameTool(
      'game_manage_resource',
      'Manage a text .tres resource: op create (needs type) | set (needs key/value) | read. All paths are project-root-guarded.',
      true,
      {
        ...PROJECT_PROP,
        op: { type: 'string', description: 'create | set | read.' },
        resPath: { type: 'string', description: 'res:// or project-relative .tres path.' },
        type: { type: 'string', description: 'Resource type (op=create).' },
        key: { type: 'string', description: 'Property key (op=set).' },
        value: { description: 'Property value (op=set).' },
        overwrite: { type: 'boolean', description: 'Replace an existing resource (op=create).' },
      },
      async (args, ctx) => {
        const op = String(args.op ?? '');
        const resPath = String(args.resPath ?? '');
        if (!resPath) return { ok: false, error: 'resPath is required.' };
        if (op !== 'create' && op !== 'set' && op !== 'read') {
          return { ok: false, error: 'op must be "create", "set", or "read".' };
        }
        const res = cli(ctx).manageResource(projectRoot(ctx, args), op, resPath, {
          type: args.type ? String(args.type) : undefined,
          key: args.key ? String(args.key) : undefined,
          value: args.value,
          overwrite: args.overwrite === true,
        });
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'Godot operation failed' };
      }
    ),

    // Family 24: set/query the runtime locale (RUN channel).
    runtimeTool(
      'game_locale',
      'Get or set the running game locale. Pass locale to set the TranslationServer locale; omit to read the current locale.',
      true,
      {
        locale: { type: 'string', description: 'BCP-47 locale code, e.g. "en", "fr". Omit to read.' },
      },
      'locale'
    ),
  ];
}
