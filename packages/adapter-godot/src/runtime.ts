import { Socket } from 'node:net';
import type { GodotAdapterConfig } from './types.js';

/**
 * Godot runtime-bridge adapter (Step 3 - RUN channel).
 *
 * This is the **RUN channel** of the Godot integration: it talks to a small
 * GDScript autoload ("runtime bridge") running *inside the live game* over a
 * line-delimited JSON TCP protocol. It is how the runtime read tier
 * (scene-tree inspection, performance metrics, logs/errors, eval, ...) reaches
 * the running process - the headless CLI channel cannot see runtime state.
 *
 * Wire protocol (newline-delimited JSON, one object per line):
 *   request : {"id": <n>, "op": "<name>", "params": { ... }}\n
 *   response: {"id": <n>, "ok": true,  "data": { ... }}\n
 *          or {"id": <n>, "ok": false, "error": "<message>"}\n
 *
 * Design notes:
 *  - "Is the game running?" is a normal, recoverable state. A refused/closed
 *    connection returns a structured, actionable error (start the game with the
 *    FolderForge runtime bridge autoload enabled) instead of throwing.
 *  - One short-lived connection per call keeps the adapter stateless and robust:
 *    construction is cheap and there is no reconnect/queue bookkeeping to leak.
 *  - The bridge (GDScript addon, shipped separately) owns the semantics of each
 *    op; this adapter only frames requests and surfaces typed results.
 */

export interface GodotRuntimeResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface BridgeResponse {
  id?: number;
  ok?: boolean;
  data?: unknown;
  error?: string;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_TIMEOUT_MS = 10_000;

export class GodotRuntime {
  private readonly host: string;
  private readonly port: number;

  constructor(
    config: Pick<GodotAdapterConfig, 'runtimePort'>,
    host: string = DEFAULT_HOST,
  ) {
    this.host = host;
    this.port = config.runtimePort;
  }

  /** True if a runtime bridge accepts a connection (the game is running). */
  async isRunning(): Promise<boolean> {
    const res = await this.send('ping', {}, 2_000);
    return res.ok;
  }

  // -- runtime read tier (Step 3) --------------------------------------------

  /** Snapshot the live scene tree (optionally bounded by depth). */
  getSceneTree(maxDepth?: number): Promise<GodotRuntimeResult<unknown>> {
    return this.send('get_scene_tree', maxDepth === undefined ? {} : { maxDepth });
  }

  /** Inspect a single node's class, properties, and children by NodePath. */
  getNodeInfo(path: string): Promise<GodotRuntimeResult<unknown>> {
    return this.send('get_node_info', { path });
  }

  /** Snapshot the live Control/UI tree. */
  getUi(): Promise<GodotRuntimeResult<unknown>> {
    return this.send('get_ui', {});
  }

  /** Performance metrics (fps, frame time, memory, object/node counts, ...). */
  performance(): Promise<GodotRuntimeResult<unknown>> {
    return this.send('performance', {});
  }

  /** Pause or resume the running game (transient, reversible -> MEDIUM). */
  pause(paused: boolean): Promise<GodotRuntimeResult<unknown>> {
    return this.send('pause', { paused });
  }

  /** Ask the game to advance/idle for `seconds` and acknowledge. */
  wait(seconds: number): Promise<GodotRuntimeResult<unknown>> {
    return this.send('wait', { seconds });
  }

  /** List node paths currently in a SceneTree group. */
  getNodesInGroup(group: string): Promise<GodotRuntimeResult<unknown>> {
    return this.send('get_nodes_in_group', { group });
  }

  /** Find node paths whose class matches `className`. */
  findNodesByClass(className: string): Promise<GodotRuntimeResult<unknown>> {
    return this.send('find_nodes_by_class', { className });
  }

  /** Drain the captured engine error buffer. */
  getErrors(): Promise<GodotRuntimeResult<unknown>> {
    return this.send('get_errors', {});
  }

  /** Tail the captured engine log (optionally the last `lines`). */
  getLogs(lines?: number): Promise<GodotRuntimeResult<unknown>> {
    return this.send('get_logs', lines === undefined ? {} : { lines });
  }

  /** Evaluate an arbitrary GDScript expression in the running game (CRITICAL). */
  evaluate(code: string): Promise<GodotRuntimeResult<unknown>> {
    return this.send('eval', { code });
  }

  // -- transport -------------------------------------------------------------

  /**
   * Open a short-lived TCP connection, send one request line, and resolve with
   * the first matching response line. Connection/timeout failures resolve to a
   * structured "not running" error rather than rejecting.
   */
  send(
    op: string,
    params: Record<string, unknown>,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ): Promise<GodotRuntimeResult<unknown>> {
    return new Promise((resolvePromise) => {
      const socket = new Socket();
      let buffer = '';
      let settled = false;
      const id = Math.floor(Math.random() * 1e9);

      const finish = (res: GodotRuntimeResult<unknown>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolvePromise(res);
      };

      const timer = setTimeout(
        () => finish({ ok: false, error: `Godot runtime request timed out: ${op}` }),
        timeoutMs
      );

      socket.setEncoding('utf8');

      socket.on('connect', () => {
        socket.write(`${JSON.stringify({ id, op, params })}\n`);
      });

      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let msg: BridgeResponse;
          try {
            msg = JSON.parse(line) as BridgeResponse;
          } catch {
            continue; // ignore non-JSON noise
          }
          if (msg.id !== undefined && msg.id !== id) continue;
          if (msg.ok === false) {
            finish({ ok: false, error: msg.error ?? `Godot runtime op failed: ${op}` });
          } else {
            finish({ ok: true, data: msg.data ?? null });
          }
          return;
        }
      });

      socket.on('error', () => {
        finish({
          ok: false,
          error:
            `No running Godot game found on ${this.host}:${this.port}. Start the game ` +
            `with the FolderForge runtime bridge autoload enabled, then retry.`,
        });
      });

      socket.on('close', () => {
        finish({
          ok: false,
          error:
            `Godot runtime connection closed before a response (${op}). Is the game ` +
            `still running with the runtime bridge enabled?`,
        });
      });

      socket.connect(this.port, this.host);
    });
  }
}
