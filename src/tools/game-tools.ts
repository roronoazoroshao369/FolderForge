import { defineTool } from './registry.js';
import type { ToolDefinition, ToolContext } from '../core/types.js';
import { GodotCli } from '../adapters/godot/cli.js';
import { GodotRuntime } from '../adapters/godot/runtime.js';

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

/** Resolve the Godot project root: explicit arg, else the active workspace. */
function projectRoot(ctx: ToolContext, args: Record<string, unknown>): string {
  const p = args.projectPath ?? args.projectRoot;
  return typeof p === 'string' && p.length ? p : ctx.projectRoot;
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
  ];
}
