import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../../core/logger.js';
import { terminateChildProcessTree } from '../../core/process-tree.js';
import { readFolderForgeVersion } from '../../core/version.js';
import { SecretPolicy } from '../../policy/secret-policy.js';

interface PendingRequest {
  method: string;
  phase: ChildFailurePhase;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  cleanup: () => void;
}

interface ChildJsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface ChildJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface ChildInitializeResult {
  protocolVersion?: unknown;
  capabilities?: unknown;
}

export interface ChildToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export type ChildFailurePhase = 'resolve' | 'spawn' | 'initialize' | 'tools/list' | 'runtime' | 'shutdown';

export type ChildFailureKind =
  | 'executable_not_found'
  | 'spawn_error'
  | 'npm_package_resolution_failure'
  | 'network_or_cache_failure'
  | 'child_exited_before_initialize'
  | 'initialize_timeout'
  | 'unsupported_protocol_version'
  | 'tools_list_failure'
  | 'tools_list_timeout'
  | 'tools_list_limit_exceeded'
  | 'tools_list_pagination_cycle'
  | 'request_timeout'
  | 'json_rpc_error'
  | 'malformed_json_rpc'
  | 'missing_chromium'
  | 'browser_launch_failure'
  | 'permission_or_quarantine'
  | 'architecture_mismatch'
  | 'unsupported_node_version'
  | 'invalid_adapter_arguments'
  | 'runtime_crash'
  | 'shutdown_failure'
  | 'unknown';

export interface ChildMcpDiagnostic {
  adapter: string;
  command: string;
  args: string[];
  cwd: string;
  phase: ChildFailurePhase;
  kind: ChildFailureKind;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError: string;
  stderrTail: string;
  timedOut: boolean;
  remediation: string;
  occurredAt: string;
}

export class ChildMcpError extends Error {
  constructor(
    message: string,
    readonly diagnostic: ChildMcpDiagnostic
  ) {
    super(message);
    this.name = 'ChildMcpError';
  }
}

export class ChildMcpRequestError extends ChildMcpError {
  constructor(
    message: string,
    diagnostic: ChildMcpDiagnostic,
    readonly code?: number,
    readonly data?: unknown
  ) {
    super(message, diagnostic);
    this.name = 'ChildMcpRequestError';
  }
}

export interface ChildMcpRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface StdioChildClientOptions {
  adapter: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  inheritEnv?: boolean;
  requestTimeoutMs?: number;
  stderrLimit?: number;
  maxCatalogTools?: number;
  maxCatalogPages?: number;
  redact?: (text: string) => string;
  onDiagnostic?: (diagnostic: ChildMcpDiagnostic) => void;
  onToolsListChanged?: () => void;
}

const DEFAULT_STDERR_LIMIT = 16 * 1024;
const DEFAULT_REQUEST_TIMEOUT = 30_000;
const DEFAULT_MAX_CATALOG_TOOLS = 10_000;
const DEFAULT_MAX_CATALOG_PAGES = 1_000;
const secretPolicy = new SecretPolicy();

const SENSITIVE_ARG_RE = /(?:^|[-_])(token|secret|password|passwd|api[-_]?key|cookie|authorization)(?:$|[=_-])/i;

export function redactChildArgs(args: string[]): string[] {
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return '[REDACTED]';
    }
    const equals = arg.indexOf('=');
    const optionName = equals >= 0 ? arg.slice(0, equals) : arg;
    if (SENSITIVE_ARG_RE.test(optionName)) {
      if (equals >= 0) return `${arg.slice(0, equals + 1)}[REDACTED]`;
      redactNext = true;
      return arg;
    }
    const knownRedacted = secretPolicy.redact(arg);
    if (knownRedacted !== arg) return knownRedacted;
    // Preserve actionable filesystem paths. Random-looking non-path arguments
    // are safer to suppress than to expose in startup diagnostics.
    if (/[\\/]/.test(arg) && !arg.includes('://')) return arg;
    return secretPolicy.scan(arg).length > 0 ? '[REDACTED]' : arg;
  });
}

export function classifyChildFailure(
  phase: ChildFailurePhase,
  input: { message?: string; stderr?: string; timedOut?: boolean; code?: string }
): ChildFailureKind {
  const text = `${input.message ?? ''}\n${input.stderr ?? ''}`.toLowerCase();
  if (input.code === 'ENOENT') return 'executable_not_found';
  if (input.timedOut && phase === 'initialize') return 'initialize_timeout';
  if (input.timedOut && phase === 'tools/list') return 'tools_list_timeout';
  if (input.timedOut) return 'request_timeout';
  if (/malformed|invalid json|json-rpc/.test(text)) return 'malformed_json_rpc';
  if (/could not determine executable|npm err|package.*not found|e404|enotcached/.test(text)) {
    return 'npm_package_resolution_failure';
  }
  if (/network|fetch failed|eai_again|enotfound|econnreset|cache.*miss|offline/.test(text)) {
    return 'network_or_cache_failure';
  }
  if (/executable.*doesn.t exist|browser.*not found|chromium.*not found|playwright install/.test(text)) {
    return 'missing_chromium';
  }
  if (/browser.*launch|failed to launch|target page.*closed/.test(text)) return 'browser_launch_failure';
  if (/permission denied|operation not permitted|eacces|quarantine|not authorized/.test(text)) {
    return 'permission_or_quarantine';
  }
  if (/wrong architecture|bad cpu type|exec format|architecture mismatch/.test(text)) {
    return 'architecture_mismatch';
  }
  if (/unsupported node|node.js.*required|requires node/.test(text)) return 'unsupported_node_version';
  if (/unknown option|unknown argument|invalid(?:\s+adapter)?\s+arguments?/.test(text)) return 'invalid_adapter_arguments';
  if (phase === 'spawn') return 'spawn_error';
  if (phase === 'initialize') return 'child_exited_before_initialize';
  if (phase === 'tools/list') return 'tools_list_failure';
  if (phase === 'runtime') return 'runtime_crash';
  if (phase === 'shutdown') return 'shutdown_failure';
  return 'unknown';
}

function remediationFor(kind: ChildFailureKind): string {
  switch (kind) {
    case 'missing_chromium':
    case 'browser_launch_failure':
      return 'Run `folderforge setup browser`, then run `folderforge doctor` again.';
    case 'executable_not_found':
      return 'Verify the configured adapter command and the active Node installation, then run `folderforge doctor`.';
    case 'npm_package_resolution_failure':
    case 'network_or_cache_failure':
      return 'Reinstall FolderForge so its package-local dependencies are complete; built-in Playwright must not require network access at startup.';
    case 'permission_or_quarantine':
      return 'Check executable permissions and macOS quarantine/Gatekeeper state for the Node and Playwright package files.';
    case 'architecture_mismatch':
      return 'Install a Node.js and FolderForge package matching the machine architecture.';
    case 'unsupported_node_version':
      return 'Select Node.js 22 or newer and reinstall FolderForge under that Node installation.';
    case 'invalid_adapter_arguments':
      return 'Review adapters.playwright.args or restore the generated package-local Playwright adapter arguments.';
    case 'initialize_timeout':
    case 'tools_list_timeout':
      return 'Run `folderforge doctor` and inspect the bounded child stderr diagnostic; verify the adapter is not blocked by security software.';
    case 'unsupported_protocol_version':
      return 'Upgrade FolderForge or use a child MCP server that negotiates one of the protocol versions supported by the installed MCP SDK.';
    case 'tools_list_limit_exceeded':
    case 'tools_list_pagination_cycle':
      return 'Review the child MCP catalog pagination. FolderForge stopped discovery to avoid an unbounded or cyclic tools/list response.';
    case 'request_timeout':
      return 'Retry the operation. FolderForge cancelled the timed-out child request without tearing down unrelated in-flight work.';
    case 'json_rpc_error':
      return 'Review the child MCP error message and arguments; the connection remained available for unrelated requests.';
    case 'malformed_json_rpc':
      return 'The child wrote invalid data to its MCP stdout channel. Verify package integrity and adapter compatibility.';
    default:
      return 'Run `folderforge doctor` and inspect the adapter readiness finding and stderr tail.';
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRequestId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
}

function isJsonRpcError(value: unknown): value is ChildJsonRpcError {
  return Boolean(
    value &&
      typeof value === 'object' &&
      Number.isInteger((value as ChildJsonRpcError).code) &&
      typeof (value as ChildJsonRpcError).message === 'string'
  );
}

function abortError(reason: unknown, fallback: string): Error {
  const message = reason instanceof Error
    ? reason.message
    : typeof reason === 'string' && reason.length > 0
      ? reason
      : fallback;
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/** Minimal JSON-RPC client over a child MCP server's stdio. */
export class StdioChildClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = '';
  private initialized = false;
  private stderrTail = '';
  private stderrRawTail = '';
  private stopping = false;
  private lastFailure: ChildMcpDiagnostic | null = null;
  private negotiatedProtocol: string | null = null;
  private serverToolsListChanged = false;
  private readonly requestTimeoutMs: number;
  private readonly stderrLimit: number;
  private readonly maxCatalogTools: number;
  private readonly maxCatalogPages: number;
  private readonly redact: (text: string) => string;

  constructor(private readonly options: StdioChildClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT;
    this.stderrLimit = options.stderrLimit ?? DEFAULT_STDERR_LIMIT;
    this.maxCatalogTools = options.maxCatalogTools ?? DEFAULT_MAX_CATALOG_TOOLS;
    this.maxCatalogPages = options.maxCatalogPages ?? DEFAULT_MAX_CATALOG_PAGES;
    if (!Number.isSafeInteger(this.maxCatalogTools) || this.maxCatalogTools < 1) {
      throw new Error('maxCatalogTools must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(this.maxCatalogPages) || this.maxCatalogPages < 1) {
      throw new Error('maxCatalogPages must be a positive safe integer.');
    }
    this.redact = options.redact ?? ((text) => secretPolicy.redact(text));
  }

  async start(): Promise<void> {
    if (this.isReady()) return;
    if (this.child) this.stop();
    this.stopping = false;
    this.stderrTail = '';
    this.stderrRawTail = '';
    this.buffer = '';
    this.negotiatedProtocol = null;
    this.serverToolsListChanged = false;
    this.nextId = 1;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.command, this.options.args, {
        cwd: this.options.cwd,
        env: this.options.inheritEnv === false
          ? { ...(this.options.env ?? {}) }
          : { ...process.env, ...(this.options.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
      this.child = child;
      child.stdout.on('data', (chunk: Buffer) => this.onData(child, chunk));
      child.stderr.on('data', (chunk: Buffer) => this.onStderr(child, chunk));
      child.on('exit', (code, signal) => this.onExit(child, code, signal));
      child.stdin.on('error', (error) => {
        if (this.child === child && !this.stopping) {
          this.failConnection(this.connectionPhase(), error.message, { spawnError: error });
        }
      });
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        const onSpawn = (): void => {
          child.off('error', onError);
          resolveSpawn();
        };
        const onError = (error: NodeJS.ErrnoException): void => {
          child.off('spawn', onSpawn);
          rejectSpawn(this.failConnection('spawn', error.message, { spawnError: error }));
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
      });
    } catch (error) {
      if (error instanceof ChildMcpError) throw error;
      throw this.failConnection(
        'spawn',
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? { spawnError: error } : {}
      );
    }

    try {
      const initialized = (await this.request(
        'initialize',
        {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'folderforge', version: readFolderForgeVersion() },
        },
        this.requestTimeoutMs,
        'initialize'
      )) as ChildInitializeResult;
      const negotiated = initialized?.protocolVersion;
      if (
        typeof negotiated !== 'string' ||
        !SUPPORTED_PROTOCOL_VERSIONS.some((version) => version === negotiated)
      ) {
        throw this.failConnection(
          'initialize',
          `child selected unsupported protocol version: ${String(negotiated)}`,
          { kind: 'unsupported_protocol_version' }
        );
      }
      const capabilities =
        initialized.capabilities && typeof initialized.capabilities === 'object'
          ? (initialized.capabilities as Record<string, unknown>)
          : {};
      const toolsCapability =
        capabilities.tools && typeof capabilities.tools === 'object'
          ? (capabilities.tools as Record<string, unknown>)
          : {};
      this.negotiatedProtocol = negotiated;
      this.serverToolsListChanged = toolsCapability.listChanged === true;
      this.notify('notifications/initialized', {});
      this.initialized = true;
      this.lastFailure = null;
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  private connectionPhase(): ChildFailurePhase {
    if (this.stopping) return 'shutdown';
    return this.initialized ? 'runtime' : 'initialize';
  }

  private onStderr(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (this.child !== child) return;
    const rawLimit = this.stderrLimit + 4096;
    this.stderrRawTail = `${this.stderrRawTail}${chunk.toString('utf8')}`.slice(-rawLimit);
    this.stderrTail = this.redact(this.stderrRawTail).slice(-this.stderrLimit);
    logger.debug(
      {
        adapter: this.options.adapter,
        child: this.options.command,
        bytes: chunk.length,
        bufferedBytes: Buffer.byteLength(this.stderrRawTail),
      },
      'child stderr captured'
    );
  }

  private onExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (this.child !== child) return;
    const phase = this.initialized ? 'runtime' : 'initialize';
    const wasStopping = this.stopping;
    this.child = null;
    this.initialized = false;
    this.negotiatedProtocol = null;
    this.serverToolsListChanged = false;
    if (wasStopping) return;
    const error = this.failConnection(
      phase,
      `child process exited${code === null ? '' : ` with code ${code}`}`,
      { exitCode: code, signal, terminate: false }
    );
    logger.warn({ diagnostic: error.diagnostic }, 'child MCP adapter failed');
  }

  private onData(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (this.child !== child) return;
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;

      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch {
        this.failConnection(this.connectionPhase(), 'Malformed JSON-RPC received from child stdout.', {
          kind: 'malformed_json_rpc',
        });
        return;
      }
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        this.failConnection(this.connectionPhase(), 'Child stdout contained a non-object JSON-RPC message.', {
          kind: 'malformed_json_rpc',
        });
        return;
      }
      const msg = decoded as ChildJsonRpcMessage;
      const messagePhase =
        typeof msg.id === 'number'
          ? this.pending.get(msg.id)?.phase ?? this.connectionPhase()
          : this.connectionPhase();
      if (msg.jsonrpc !== '2.0') {
        this.failConnection(messagePhase, 'Child sent a JSON-RPC message without jsonrpc="2.0".', {
          kind: 'malformed_json_rpc',
        });
        return;
      }

      const hasId = hasOwn(msg, 'id');
      if (typeof msg.method === 'string') {
        if (hasId) {
          if (!isRequestId(msg.id)) {
            this.failConnection(this.connectionPhase(), 'Child sent a request with an invalid id.', {
              kind: 'malformed_json_rpc',
            });
            return;
          }
          if (msg.method === 'ping') {
            this.sendMessage(child, { jsonrpc: '2.0', id: msg.id, result: {} }, this.connectionPhase());
          } else {
            this.sendMessage(
              child,
              {
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32601, message: `Method not found: ${msg.method}` },
              },
              this.connectionPhase()
            );
          }
          continue;
        }

        if (msg.method === 'notifications/tools/list_changed') {
          const validParams =
            msg.params === undefined ||
            (msg.params !== null && typeof msg.params === 'object' && !Array.isArray(msg.params));
          if (validParams && this.serverToolsListChanged) this.options.onToolsListChanged?.();
        }
        continue;
      }

      if (!hasId || !isRequestId(msg.id)) {
        this.failConnection(this.connectionPhase(), 'Child sent a response with an invalid id.', {
          kind: 'malformed_json_rpc',
        });
        return;
      }
      if (typeof msg.id !== 'number' || !this.pending.has(msg.id)) continue;

      const pending = this.pending.get(msg.id)!;
      const hasResult = hasOwn(msg, 'result');
      const hasError = hasOwn(msg, 'error');
      if (hasResult === hasError || (hasError && !isJsonRpcError(msg.error))) {
        this.failConnection(pending.phase, `Child sent an invalid response for ${pending.method}.`, {
          kind: 'malformed_json_rpc',
        });
        return;
      }

      this.pending.delete(msg.id);
      pending.cleanup();
      if (hasError) {
        const rpcError = msg.error as ChildJsonRpcError;
        pending.reject(this.requestFailure(
          pending.phase,
          `Child MCP ${pending.method} failed: ${rpcError.message}`,
          { kind: 'json_rpc_error', code: rpcError.code, data: rpcError.data }
        ));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private sendMessage(
    child: ChildProcessWithoutNullStreams,
    message: Record<string, unknown>,
    phase: ChildFailurePhase
  ): boolean {
    if (this.child !== child || child.stdin.destroyed || child.stdin.writableEnded) return false;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch (error) {
      this.failConnection(phase, error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private notify(method: string, params: unknown): boolean {
    const child = this.child;
    if (!child) return false;
    return this.sendMessage(child, { jsonrpc: '2.0', method, params }, this.connectionPhase());
  }

  request(
    method: string,
    params: unknown,
    timeoutMs = this.requestTimeoutMs,
    phase: ChildFailurePhase = 'runtime',
    signal?: AbortSignal
  ): Promise<unknown> {
    const child = this.child;
    if (!child) {
      return Promise.reject(this.requestFailure(phase, 'child not started'));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(new RangeError('timeoutMs must be a positive finite number.'));
    }
    if (signal?.aborted) {
      return Promise.reject(abortError(signal.reason, `Child MCP ${method} cancelled.`));
    }

    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      let timer: NodeJS.Timeout | null = null;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        timer = null;
        signal?.removeEventListener('abort', onAbort);
      };
      const cancelPending = (error: Error, reason: string): void => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        cleanup();
        if (phase !== 'initialize') {
          this.notify('notifications/cancelled', { requestId: id, reason });
        }
        rejectRequest(error);
      };
      const onAbort = (): void => {
        if (phase === 'initialize') {
          this.failConnection('initialize', 'initialize request aborted by caller', {
            kind: 'shutdown_failure',
          });
          return;
        }
        cancelPending(
          abortError(signal?.reason, `Child MCP ${method} cancelled.`),
          signal?.reason instanceof Error ? signal.reason.message : 'Caller cancelled the request.'
        );
      };

      this.pending.set(id, {
        method,
        phase,
        cleanup,
        resolve: (value) => {
          cleanup();
          resolveRequest(value);
        },
        reject: (error) => {
          cleanup();
          rejectRequest(error);
        },
      });

      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }

      timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        if (phase === 'initialize') {
          this.failConnection(phase, `child request timed out: ${method}`, { timedOut: true });
          return;
        }
        cancelPending(
          this.requestFailure(phase, `child request timed out: ${method}`, { timedOut: true }),
          `Request timed out after ${timeoutMs}ms.`
        );
      }, timeoutMs);

      if (!this.sendMessage(child, { jsonrpc: '2.0', id, method, params }, phase) && this.pending.has(id)) {
        this.pending.delete(id);
        cleanup();
        rejectRequest(this.requestFailure(phase, 'child transport is not writable'));
      }
    });
  }

  async listTools(
    timeoutOrOptions: number | ChildMcpRequestOptions = this.requestTimeoutMs
  ): Promise<ChildToolDescriptor[]> {
    const options = typeof timeoutOrOptions === 'number'
      ? { timeoutMs: timeoutOrOptions }
      : timeoutOrOptions;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const tools: ChildToolDescriptor[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 1; ; page += 1) {
      const res = (await this.request(
        'tools/list',
        cursor === undefined ? {} : { cursor },
        timeoutMs,
        'tools/list',
        options.signal
      )) as { tools?: unknown; nextCursor?: unknown };
      if (
        !res ||
        !Array.isArray(res.tools) ||
        !res.tools.every(
          (tool): tool is ChildToolDescriptor =>
            Boolean(tool) &&
            typeof tool === 'object' &&
            typeof (tool as ChildToolDescriptor).name === 'string' &&
            (tool as ChildToolDescriptor).name.length > 0
        )
      ) {
        throw this.failConnection('tools/list', 'tools/list returned an invalid result.', {
          kind: 'tools_list_failure',
        });
      }
      tools.push(...res.tools);
      if (tools.length > this.maxCatalogTools) {
        throw this.failConnection(
          'tools/list',
          `child catalog exceeded ${this.maxCatalogTools} tools`,
          { kind: 'tools_list_limit_exceeded' }
        );
      }
      if (res.nextCursor === undefined) return tools;
      if (typeof res.nextCursor !== 'string' || res.nextCursor.length === 0) {
        throw this.failConnection('tools/list', 'tools/list returned an invalid nextCursor.', {
          kind: 'tools_list_failure',
        });
      }
      if (seenCursors.has(res.nextCursor)) {
        throw this.failConnection('tools/list', `tools/list repeated cursor: ${res.nextCursor}`, {
          kind: 'tools_list_pagination_cycle',
        });
      }
      if (page >= this.maxCatalogPages) {
        throw this.failConnection(
          'tools/list',
          `child catalog exceeded ${this.maxCatalogPages} pages`,
          { kind: 'tools_list_limit_exceeded' }
        );
      }
      seenCursors.add(res.nextCursor);
      cursor = res.nextCursor;
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: ChildMcpRequestOptions = {}
  ): Promise<unknown> {
    return this.request(
      'tools/call',
      { name, arguments: args },
      options.timeoutMs ?? this.requestTimeoutMs,
      'runtime',
      options.signal
    );
  }

  isReady(): boolean {
    return this.initialized && this.child !== null;
  }

  protocolVersion(): string | null {
    return this.negotiatedProtocol;
  }

  supportsToolsListChanged(): boolean {
    return this.serverToolsListChanged;
  }

  pid(): number | undefined {
    return this.child?.pid;
  }

  diagnostic(): ChildMcpDiagnostic | null {
    return this.lastFailure ? { ...this.lastFailure, args: [...this.lastFailure.args] } : null;
  }

  async stopAndWait(timeoutMs = 1_000): Promise<void> {
    const child = this.child;
    this.stop();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = await Promise.race([
      new Promise<boolean>((resolveExit) => child.once('exit', () => resolveExit(true))),
      new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), timeoutMs)),
    ]);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      terminateChildProcessTree(child, true);
    }
  }

  stop(): void {
    const child = this.child;
    this.stopping = true;
    this.child = null;
    this.initialized = false;
    this.negotiatedProtocol = null;
    this.serverToolsListChanged = false;
    this.buffer = '';
    const error = abortError(undefined, 'Child MCP client stopped.');
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (child) terminateChildProcessTree(child);
  }

  private diagnosticFor(
    phase: ChildFailurePhase,
    message: string,
    options: {
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      spawnError?: Error;
      timedOut?: boolean;
      kind?: ChildFailureKind;
    } = {}
  ): ChildMcpDiagnostic {
    const spawnError = options.spawnError as NodeJS.ErrnoException | undefined;
    const kind = options.kind ?? classifyChildFailure(phase, {
      message,
      stderr: this.stderrTail,
      ...(options.timedOut !== undefined ? { timedOut: options.timedOut } : {}),
      ...(spawnError?.code ? { code: spawnError.code } : {}),
    });
    return {
      adapter: this.options.adapter,
      command: this.options.command,
      args: redactChildArgs(this.options.args),
      cwd: this.options.cwd ?? process.cwd(),
      phase,
      kind,
      exitCode: options.exitCode ?? this.child?.exitCode ?? null,
      signal: options.signal ?? this.child?.signalCode ?? null,
      spawnError: this.redact(spawnError?.message ?? ''),
      stderrTail: this.stderrTail,
      timedOut: options.timedOut === true,
      remediation: remediationFor(kind),
      occurredAt: new Date().toISOString(),
    };
  }

  private requestFailure(
    phase: ChildFailurePhase,
    message: string,
    options: {
      timedOut?: boolean;
      kind?: ChildFailureKind;
      code?: number;
      data?: unknown;
    } = {}
  ): ChildMcpRequestError {
    const diagnostic = this.diagnosticFor(phase, message, {
      ...(options.timedOut !== undefined ? { timedOut: options.timedOut } : {}),
      ...(options.kind ? { kind: options.kind } : {}),
    });
    return new ChildMcpRequestError(
      `${this.options.adapter} adapter request failed during ${phase}: ${message}`,
      diagnostic,
      options.code,
      options.data
    );
  }

  private failConnection(
    phase: ChildFailurePhase,
    message: string,
    options: {
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      spawnError?: Error;
      timedOut?: boolean;
      kind?: ChildFailureKind;
      terminate?: boolean;
    } = {}
  ): ChildMcpError {
    const diagnostic = this.diagnosticFor(phase, message, options);
    this.lastFailure = diagnostic;
    this.initialized = false;
    this.negotiatedProtocol = null;
    this.serverToolsListChanged = false;
    this.options.onDiagnostic?.(diagnostic);
    const error = new ChildMcpError(
      `${this.options.adapter} adapter failed during ${phase}: ${message}`,
      diagnostic
    );
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (options.terminate !== false && this.child) {
      const child = this.child;
      this.child = null;
      this.stopping = true;
      terminateChildProcessTree(child);
    }
    return error;
  }
}
