import { defineTool } from './registry.js';
import type { ToolDefinition, ToolContext } from '../core/types.js';
import { GodotCli } from '../adapters/godot/cli.js';

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
  ];
}
