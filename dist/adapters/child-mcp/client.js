import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../../core/logger.js';
import { terminateChildProcessTree } from '../../core/process-tree.js';
import { readFolderForgeVersion } from '../../core/version.js';
import { SecretPolicy } from '../../policy/secret-policy.js';
export function classifyChildFailureDisposition(kind) {
    switch (kind) {
        case 'executable_not_found':
        case 'npm_package_resolution_failure':
        case 'missing_chromium':
        case 'permission_or_quarantine':
        case 'architecture_mismatch':
        case 'unsupported_node_version':
        case 'invalid_adapter_arguments':
            return 'configuration';
        case 'unsupported_protocol_version':
        case 'tools_list_failure':
        case 'tools_list_limit_exceeded':
        case 'tools_list_pagination_cycle':
        case 'malformed_json_rpc':
            return 'compatibility';
        case 'json_rpc_message_too_large':
        case 'stdout_buffer_limit_exceeded':
        case 'pending_request_limit_exceeded':
            return 'resource';
        case 'shutdown_failure':
            return 'shutdown';
        default:
            return 'transient';
    }
}
export class ChildMcpError extends Error {
    diagnostic;
    constructor(message, diagnostic) {
        super(message);
        this.diagnostic = diagnostic;
        this.name = 'ChildMcpError';
    }
}
export class ChildMcpRequestError extends ChildMcpError {
    code;
    data;
    constructor(message, diagnostic, code, data) {
        super(message, diagnostic);
        this.code = code;
        this.data = data;
        this.name = 'ChildMcpRequestError';
    }
}
const DEFAULT_STDERR_LIMIT = 16 * 1024;
const DEFAULT_REQUEST_TIMEOUT = 30_000;
const DEFAULT_MAX_CATALOG_TOOLS = 10_000;
const DEFAULT_MAX_CATALOG_PAGES = 1_000;
const DEFAULT_MAX_JSON_RPC_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDOUT_BUFFER_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_PENDING_REQUESTS = 256;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;
const secretPolicy = new SecretPolicy();
const SENSITIVE_ARG_RE = /(?:^|[-_])(token|secret|password|passwd|api[-_]?key|cookie|authorization)(?:$|[=_-])/i;
export function redactChildArgs(args) {
    let redactNext = false;
    return args.map((arg) => {
        if (redactNext) {
            redactNext = false;
            return '[REDACTED]';
        }
        const equals = arg.indexOf('=');
        const optionName = equals >= 0 ? arg.slice(0, equals) : arg;
        if (SENSITIVE_ARG_RE.test(optionName)) {
            if (equals >= 0)
                return `${arg.slice(0, equals + 1)}[REDACTED]`;
            redactNext = true;
            return arg;
        }
        const knownRedacted = secretPolicy.redact(arg);
        if (knownRedacted !== arg)
            return knownRedacted;
        // Preserve actionable filesystem paths. Random-looking non-path arguments
        // are safer to suppress than to expose in startup diagnostics.
        if (/[\\/]/.test(arg) && !arg.includes('://'))
            return arg;
        return secretPolicy.scan(arg).length > 0 ? '[REDACTED]' : arg;
    });
}
export function classifyChildFailure(phase, input) {
    const text = `${input.message ?? ''}\n${input.stderr ?? ''}`.toLowerCase();
    if (input.code === 'ENOENT')
        return 'executable_not_found';
    if (input.timedOut && phase === 'initialize')
        return 'initialize_timeout';
    if (input.timedOut && phase === 'tools/list')
        return 'tools_list_timeout';
    if (input.timedOut)
        return 'request_timeout';
    if (/malformed|invalid json|json-rpc/.test(text))
        return 'malformed_json_rpc';
    if (/could not determine executable|npm err|package.*not found|e404|enotcached/.test(text)) {
        return 'npm_package_resolution_failure';
    }
    if (/network|fetch failed|eai_again|enotfound|econnreset|cache.*miss|offline/.test(text)) {
        return 'network_or_cache_failure';
    }
    if (/executable.*doesn.t exist|browser.*not found|chromium.*not found|playwright install/.test(text)) {
        return 'missing_chromium';
    }
    if (/browser.*launch|failed to launch|target page.*closed/.test(text))
        return 'browser_launch_failure';
    if (/permission denied|operation not permitted|eacces|quarantine|not authorized/.test(text)) {
        return 'permission_or_quarantine';
    }
    if (/wrong architecture|bad cpu type|exec format|architecture mismatch/.test(text)) {
        return 'architecture_mismatch';
    }
    if (/unsupported node|node.js.*required|requires node/.test(text))
        return 'unsupported_node_version';
    if (/unknown option|unknown argument|invalid(?:\s+adapter)?\s+arguments?/.test(text))
        return 'invalid_adapter_arguments';
    if (phase === 'spawn')
        return 'spawn_error';
    if (phase === 'initialize')
        return 'child_exited_before_initialize';
    if (phase === 'tools/list')
        return 'tools_list_failure';
    if (phase === 'runtime')
        return 'runtime_crash';
    if (phase === 'shutdown')
        return 'shutdown_failure';
    return 'unknown';
}
function remediationFor(kind) {
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
        case 'json_rpc_message_too_large':
        case 'stdout_buffer_limit_exceeded':
            return 'The child exceeded FolderForge protocol output bounds. Review the child for stdout flooding or unexpectedly large MCP payloads.';
        case 'pending_request_limit_exceeded':
            return 'Reduce concurrent child operations or wait for current requests to complete before retrying.';
        case 'heartbeat_timeout':
            return 'The idle child stopped responding to MCP ping. FolderForge closed it so the registry can recover after backoff.';
        default:
            return 'Run `folderforge doctor` and inspect the adapter readiness finding and stderr tail.';
    }
}
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function isRequestId(value) {
    return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
}
function isJsonRpcError(value) {
    return Boolean(value &&
        typeof value === 'object' &&
        Number.isInteger(value.code) &&
        typeof value.message === 'string');
}
function abortError(reason, fallback) {
    const message = reason instanceof Error
        ? reason.message
        : typeof reason === 'string' && reason.length > 0
            ? reason
            : fallback;
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}
function positiveSafeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive safe integer.`);
    }
    return value;
}
function nonNegativeSafeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative safe integer.`);
    }
    return value;
}
function emptyTransportStats() {
    return {
        bytesReceived: 0,
        bytesSent: 0,
        messagesReceived: 0,
        messagesSent: 0,
        requestsSent: 0,
        responsesReceived: 0,
        notificationsReceived: 0,
        heartbeatsSent: 0,
    };
}
/** Minimal JSON-RPC client over a child MCP server's stdio. */
export class StdioChildClient {
    options;
    child = null;
    pending = new Map();
    nextId = 1;
    buffer = Buffer.alloc(0);
    initialized = false;
    stderrTail = '';
    stderrRawTail = '';
    stopping = false;
    lastFailure = null;
    negotiatedProtocol = null;
    serverToolsListChanged = false;
    heartbeatTimer = null;
    heartbeatInFlight = false;
    transport = emptyTransportStats();
    requestTimeoutMs;
    stderrLimit;
    maxCatalogTools;
    maxCatalogPages;
    maxJsonRpcMessageBytes;
    maxStdoutBufferBytes;
    maxPendingRequests;
    heartbeatIntervalMs;
    heartbeatTimeoutMs;
    redact;
    utf8 = new TextDecoder('utf-8', { fatal: true });
    constructor(options) {
        this.options = options;
        this.requestTimeoutMs = positiveSafeInteger(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT, 'requestTimeoutMs');
        this.stderrLimit = positiveSafeInteger(options.stderrLimit ?? DEFAULT_STDERR_LIMIT, 'stderrLimit');
        this.maxCatalogTools = positiveSafeInteger(options.maxCatalogTools ?? DEFAULT_MAX_CATALOG_TOOLS, 'maxCatalogTools');
        this.maxCatalogPages = positiveSafeInteger(options.maxCatalogPages ?? DEFAULT_MAX_CATALOG_PAGES, 'maxCatalogPages');
        this.maxJsonRpcMessageBytes = positiveSafeInteger(options.maxJsonRpcMessageBytes ?? DEFAULT_MAX_JSON_RPC_MESSAGE_BYTES, 'maxJsonRpcMessageBytes');
        this.maxStdoutBufferBytes = positiveSafeInteger(options.maxStdoutBufferBytes ?? DEFAULT_MAX_STDOUT_BUFFER_BYTES, 'maxStdoutBufferBytes');
        if (this.maxStdoutBufferBytes < this.maxJsonRpcMessageBytes) {
            throw new Error('maxStdoutBufferBytes must be greater than or equal to maxJsonRpcMessageBytes.');
        }
        this.maxPendingRequests = positiveSafeInteger(options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS, 'maxPendingRequests');
        this.heartbeatIntervalMs = nonNegativeSafeInteger(options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS, 'heartbeatIntervalMs');
        this.heartbeatTimeoutMs = positiveSafeInteger(options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS, 'heartbeatTimeoutMs');
        this.redact = options.redact ?? ((text) => secretPolicy.redact(text));
    }
    async start() {
        if (this.isReady())
            return;
        if (this.child)
            this.stop();
        this.clearHeartbeat();
        this.stopping = false;
        this.stderrTail = '';
        this.stderrRawTail = '';
        this.buffer = Buffer.alloc(0);
        this.negotiatedProtocol = null;
        this.serverToolsListChanged = false;
        this.heartbeatInFlight = false;
        this.transport = emptyTransportStats();
        this.nextId = 1;
        let child;
        try {
            child = spawn(this.options.command, this.options.args, {
                cwd: this.options.cwd,
                env: this.options.inheritEnv === false
                    ? { ...(this.options.env ?? {}) }
                    : { ...process.env, ...(this.options.env ?? {}) },
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
            this.child = child;
            child.stdout.on('data', (chunk) => this.onData(child, chunk));
            child.stderr.on('data', (chunk) => this.onStderr(child, chunk));
            child.on('exit', (code, signal) => this.onExit(child, code, signal));
            child.stdin.on('error', (error) => {
                if (this.child === child && !this.stopping) {
                    this.failConnection(this.connectionPhase(), error.message, { spawnError: error });
                }
            });
            await new Promise((resolveSpawn, rejectSpawn) => {
                const onSpawn = () => {
                    child.off('error', onError);
                    resolveSpawn();
                };
                const onError = (error) => {
                    child.off('spawn', onSpawn);
                    rejectSpawn(this.failConnection('spawn', error.message, { spawnError: error }));
                };
                child.once('spawn', onSpawn);
                child.once('error', onError);
            });
        }
        catch (error) {
            if (error instanceof ChildMcpError)
                throw error;
            throw this.failConnection('spawn', error instanceof Error ? error.message : String(error), error instanceof Error ? { spawnError: error } : {});
        }
        try {
            const initialized = (await this.request('initialize', {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: 'folderforge', version: readFolderForgeVersion() },
            }, this.requestTimeoutMs, 'initialize'));
            const negotiated = initialized?.protocolVersion;
            if (typeof negotiated !== 'string' ||
                !SUPPORTED_PROTOCOL_VERSIONS.some((version) => version === negotiated)) {
                throw this.failConnection('initialize', `child selected unsupported protocol version: ${String(negotiated)}`, { kind: 'unsupported_protocol_version' });
            }
            const capabilities = initialized.capabilities && typeof initialized.capabilities === 'object'
                ? initialized.capabilities
                : {};
            const toolsCapability = capabilities.tools && typeof capabilities.tools === 'object'
                ? capabilities.tools
                : {};
            this.negotiatedProtocol = negotiated;
            this.serverToolsListChanged = toolsCapability.listChanged === true;
            this.notify('notifications/initialized', {});
            this.initialized = true;
            this.lastFailure = null;
            this.startHeartbeat();
        }
        catch (error) {
            this.stop();
            throw error;
        }
    }
    connectionPhase() {
        if (this.stopping)
            return 'shutdown';
        return this.initialized ? 'runtime' : 'initialize';
    }
    onStderr(child, chunk) {
        if (this.child !== child)
            return;
        const rawLimit = this.stderrLimit + 4096;
        this.stderrRawTail = `${this.stderrRawTail}${chunk.toString('utf8')}`.slice(-rawLimit);
        this.stderrTail = this.redact(this.stderrRawTail).slice(-this.stderrLimit);
        logger.debug({
            adapter: this.options.adapter,
            child: this.options.command,
            bytes: chunk.length,
            bufferedBytes: Buffer.byteLength(this.stderrRawTail),
        }, 'child stderr captured');
    }
    onExit(child, code, signal) {
        if (this.child !== child)
            return;
        const phase = this.initialized ? 'runtime' : 'initialize';
        const wasStopping = this.stopping;
        this.child = null;
        this.initialized = false;
        this.negotiatedProtocol = null;
        this.serverToolsListChanged = false;
        this.clearHeartbeat();
        this.buffer = Buffer.alloc(0);
        if (wasStopping)
            return;
        const error = this.failConnection(phase, `child process exited${code === null ? '' : ` with code ${code}`}`, { exitCode: code, signal, terminate: false });
        logger.warn({ diagnostic: error.diagnostic }, 'child MCP adapter failed');
    }
    onData(child, chunk) {
        if (this.child !== child)
            return;
        this.transport.bytesReceived += chunk.length;
        let remaining = chunk;
        while (remaining.length > 0) {
            const newline = remaining.indexOf(0x0a);
            if (newline < 0) {
                const bufferedBytes = this.buffer.length + remaining.length;
                if (bufferedBytes > this.maxStdoutBufferBytes) {
                    this.failConnection(this.connectionPhase(), `Child stdout exceeded ${this.maxStdoutBufferBytes} bytes without a line terminator.`, { kind: 'stdout_buffer_limit_exceeded' });
                    return;
                }
                if (bufferedBytes > this.maxJsonRpcMessageBytes) {
                    this.failConnection(this.connectionPhase(), `Child JSON-RPC message exceeded ${this.maxJsonRpcMessageBytes} bytes before its line terminator.`, { kind: 'json_rpc_message_too_large' });
                    return;
                }
                this.buffer = this.buffer.length === 0
                    ? Buffer.from(remaining)
                    : Buffer.concat([this.buffer, remaining]);
                return;
            }
            const segment = remaining.subarray(0, newline);
            const lineBytes = this.buffer.length + segment.length;
            if (lineBytes > this.maxJsonRpcMessageBytes) {
                this.failConnection(this.connectionPhase(), `Child JSON-RPC message exceeded ${this.maxJsonRpcMessageBytes} bytes.`, { kind: 'json_rpc_message_too_large' });
                return;
            }
            const lineBuffer = this.buffer.length === 0
                ? segment
                : Buffer.concat([this.buffer, segment]);
            this.buffer = Buffer.alloc(0);
            remaining = remaining.subarray(newline + 1);
            if (lineBuffer.length === 0)
                continue;
            if (!this.handleJsonRpcLine(child, lineBuffer))
                return;
        }
    }
    handleJsonRpcLine(child, lineBuffer) {
        let line;
        try {
            line = this.utf8.decode(lineBuffer).trim();
        }
        catch {
            this.failConnection(this.connectionPhase(), 'Child stdout contained invalid UTF-8.', {
                kind: 'malformed_json_rpc',
            });
            return false;
        }
        if (!line)
            return true;
        this.transport.messagesReceived += 1;
        let decoded;
        try {
            decoded = JSON.parse(line);
        }
        catch {
            this.failConnection(this.connectionPhase(), 'Malformed JSON-RPC received from child stdout.', {
                kind: 'malformed_json_rpc',
            });
            return false;
        }
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
            this.failConnection(this.connectionPhase(), 'Child stdout contained a non-object JSON-RPC message.', {
                kind: 'malformed_json_rpc',
            });
            return false;
        }
        const msg = decoded;
        const messagePhase = typeof msg.id === 'number'
            ? this.pending.get(msg.id)?.phase ?? this.connectionPhase()
            : this.connectionPhase();
        if (msg.jsonrpc !== '2.0') {
            this.failConnection(messagePhase, 'Child sent a JSON-RPC message without jsonrpc="2.0".', {
                kind: 'malformed_json_rpc',
            });
            return false;
        }
        const hasId = hasOwn(msg, 'id');
        if (typeof msg.method === 'string') {
            if (hasId) {
                if (!isRequestId(msg.id)) {
                    this.failConnection(this.connectionPhase(), 'Child sent a request with an invalid id.', {
                        kind: 'malformed_json_rpc',
                    });
                    return false;
                }
                if (msg.method === 'ping') {
                    this.sendMessage(child, { jsonrpc: '2.0', id: msg.id, result: {} }, this.connectionPhase());
                }
                else {
                    this.sendMessage(child, {
                        jsonrpc: '2.0',
                        id: msg.id,
                        error: { code: -32601, message: `Method not found: ${msg.method}` },
                    }, this.connectionPhase());
                }
                return true;
            }
            this.transport.notificationsReceived += 1;
            if (msg.method === 'notifications/tools/list_changed') {
                const validParams = msg.params === undefined ||
                    (msg.params !== null && typeof msg.params === 'object' && !Array.isArray(msg.params));
                if (validParams && this.serverToolsListChanged)
                    this.options.onToolsListChanged?.();
            }
            return true;
        }
        if (!hasId || !isRequestId(msg.id)) {
            this.failConnection(this.connectionPhase(), 'Child sent a response with an invalid id.', {
                kind: 'malformed_json_rpc',
            });
            return false;
        }
        if (typeof msg.id !== 'number' || !this.pending.has(msg.id))
            return true;
        const pending = this.pending.get(msg.id);
        const hasResult = hasOwn(msg, 'result');
        const hasError = hasOwn(msg, 'error');
        if (hasResult === hasError || (hasError && !isJsonRpcError(msg.error))) {
            this.failConnection(pending.phase, `Child sent an invalid response for ${pending.method}.`, {
                kind: 'malformed_json_rpc',
            });
            return false;
        }
        this.transport.responsesReceived += 1;
        this.pending.delete(msg.id);
        pending.cleanup();
        if (hasError) {
            const rpcError = msg.error;
            pending.reject(this.requestFailure(pending.phase, `Child MCP ${pending.method} failed: ${rpcError.message}`, { kind: 'json_rpc_error', code: rpcError.code, data: rpcError.data }));
        }
        else {
            pending.resolve(msg.result);
        }
        return true;
    }
    sendMessage(child, message, phase) {
        if (this.child !== child || child.stdin.destroyed || child.stdin.writableEnded)
            return false;
        try {
            const payload = `${JSON.stringify(message)}\n`;
            child.stdin.write(payload);
            this.transport.bytesSent += Buffer.byteLength(payload);
            this.transport.messagesSent += 1;
            return true;
        }
        catch (error) {
            this.failConnection(phase, error instanceof Error ? error.message : String(error));
            return false;
        }
    }
    notify(method, params) {
        const child = this.child;
        if (!child)
            return false;
        return this.sendMessage(child, { jsonrpc: '2.0', method, params }, this.connectionPhase());
    }
    clearHeartbeat() {
        if (this.heartbeatTimer)
            clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        this.heartbeatInFlight = false;
    }
    startHeartbeat() {
        this.clearHeartbeat();
        if (this.heartbeatIntervalMs === 0)
            return;
        this.heartbeatTimer = setInterval(() => void this.runHeartbeat(), this.heartbeatIntervalMs);
        this.heartbeatTimer.unref();
    }
    async runHeartbeat() {
        if (!this.isReady() || this.stopping || this.heartbeatInFlight || this.pending.size > 0)
            return;
        const child = this.child;
        if (!child)
            return;
        this.heartbeatInFlight = true;
        this.transport.heartbeatsSent += 1;
        try {
            await this.dispatchRequest('ping', {}, this.heartbeatTimeoutMs, 'runtime', undefined, 'heartbeat');
        }
        catch (error) {
            if (this.child === child && this.isReady() && !this.stopping) {
                const timedOut = error instanceof ChildMcpError && error.diagnostic.timedOut;
                this.failConnection('runtime', 'child heartbeat did not complete successfully', {
                    kind: 'heartbeat_timeout',
                    ...(timedOut ? { timedOut: true } : {}),
                });
            }
        }
        finally {
            this.heartbeatInFlight = false;
        }
    }
    request(method, params, timeoutMs = this.requestTimeoutMs, phase = 'runtime', signal) {
        return this.dispatchRequest(method, params, timeoutMs, phase, signal, 'user');
    }
    dispatchRequest(method, params, timeoutMs, phase, signal, kind) {
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
        if (this.pending.size >= this.maxPendingRequests) {
            return Promise.reject(this.requestFailure(phase, `pending request limit exceeded (${this.maxPendingRequests})`, { kind: 'pending_request_limit_exceeded' }));
        }
        const id = this.nextId++;
        const message = { jsonrpc: '2.0', id, method, params };
        let serializedBytes;
        try {
            serializedBytes = Buffer.byteLength(JSON.stringify(message)) + 1;
        }
        catch (error) {
            return Promise.reject(this.requestFailure(phase, `request could not be serialized: ${error instanceof Error ? error.message : String(error)}`, { kind: 'json_rpc_error' }));
        }
        if (serializedBytes > this.maxJsonRpcMessageBytes) {
            return Promise.reject(this.requestFailure(phase, `outbound JSON-RPC message exceeded ${this.maxJsonRpcMessageBytes} bytes`, { kind: 'json_rpc_message_too_large' }));
        }
        return new Promise((resolveRequest, rejectRequest) => {
            let timer = null;
            const cleanup = () => {
                if (timer)
                    clearTimeout(timer);
                timer = null;
                signal?.removeEventListener('abort', onAbort);
            };
            const cancelPending = (error, reason) => {
                if (!this.pending.has(id))
                    return;
                this.pending.delete(id);
                cleanup();
                if (phase !== 'initialize') {
                    this.notify('notifications/cancelled', { requestId: id, reason });
                }
                rejectRequest(error);
            };
            const onAbort = () => {
                if (phase === 'initialize') {
                    this.failConnection('initialize', 'initialize request aborted by caller', {
                        kind: 'shutdown_failure',
                    });
                    return;
                }
                cancelPending(abortError(signal?.reason, `Child MCP ${method} cancelled.`), signal?.reason instanceof Error ? signal.reason.message : 'Caller cancelled the request.');
            };
            this.pending.set(id, {
                method,
                phase,
                kind,
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
                if (!this.pending.has(id))
                    return;
                if (phase === 'initialize') {
                    this.failConnection(phase, `child request timed out: ${method}`, { timedOut: true });
                    return;
                }
                cancelPending(this.requestFailure(phase, `child request timed out: ${method}`, { timedOut: true }), `Request timed out after ${timeoutMs}ms.`);
            }, timeoutMs);
            if (!this.sendMessage(child, message, phase) && this.pending.has(id)) {
                this.pending.delete(id);
                cleanup();
                rejectRequest(this.requestFailure(phase, 'child transport is not writable'));
            }
            else if (this.pending.has(id)) {
                this.transport.requestsSent += 1;
            }
        });
    }
    async listTools(timeoutOrOptions = this.requestTimeoutMs) {
        const options = typeof timeoutOrOptions === 'number'
            ? { timeoutMs: timeoutOrOptions }
            : timeoutOrOptions;
        const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
        const tools = [];
        const seenCursors = new Set();
        let cursor;
        for (let page = 1;; page += 1) {
            const res = (await this.request('tools/list', cursor === undefined ? {} : { cursor }, timeoutMs, 'tools/list', options.signal));
            if (!res ||
                !Array.isArray(res.tools) ||
                !res.tools.every((tool) => Boolean(tool) &&
                    typeof tool === 'object' &&
                    typeof tool.name === 'string' &&
                    tool.name.length > 0)) {
                throw this.failConnection('tools/list', 'tools/list returned an invalid result.', {
                    kind: 'tools_list_failure',
                });
            }
            tools.push(...res.tools);
            if (tools.length > this.maxCatalogTools) {
                throw this.failConnection('tools/list', `child catalog exceeded ${this.maxCatalogTools} tools`, { kind: 'tools_list_limit_exceeded' });
            }
            if (res.nextCursor === undefined)
                return tools;
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
                throw this.failConnection('tools/list', `child catalog exceeded ${this.maxCatalogPages} pages`, { kind: 'tools_list_limit_exceeded' });
            }
            seenCursors.add(res.nextCursor);
            cursor = res.nextCursor;
        }
    }
    async callTool(name, args, options = {}) {
        return this.request('tools/call', { name, arguments: args }, options.timeoutMs ?? this.requestTimeoutMs, 'runtime', options.signal);
    }
    isReady() {
        return this.initialized && this.child !== null;
    }
    protocolVersion() {
        return this.negotiatedProtocol;
    }
    supportsToolsListChanged() {
        return this.serverToolsListChanged;
    }
    pid() {
        return this.child?.pid;
    }
    diagnostic() {
        return this.lastFailure ? { ...this.lastFailure, args: [...this.lastFailure.args] } : null;
    }
    transportStats() {
        let pendingRequests = 0;
        let pendingHeartbeatRequests = 0;
        for (const pending of this.pending.values()) {
            if (pending.kind === 'heartbeat')
                pendingHeartbeatRequests += 1;
            else
                pendingRequests += 1;
        }
        return { ...this.transport, pendingRequests, pendingHeartbeatRequests };
    }
    async stopAndWait(timeoutMs = 1_000) {
        if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
            throw new RangeError('timeoutMs must be a positive finite number.');
        }
        const child = this.child;
        if (!child)
            return;
        const exitPromise = new Promise((resolveExit) => {
            child.once('exit', () => resolveExit(true));
        });
        this.stop();
        if (child.exitCode !== null || child.signalCode !== null)
            return;
        const exited = await Promise.race([
            exitPromise,
            new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), timeoutMs)),
        ]);
        if (exited || child.exitCode !== null || child.signalCode !== null)
            return;
        terminateChildProcessTree(child, true);
        await Promise.race([
            exitPromise,
            new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), timeoutMs)),
        ]);
    }
    stop() {
        const child = this.child;
        this.stopping = true;
        this.clearHeartbeat();
        this.child = null;
        this.initialized = false;
        this.negotiatedProtocol = null;
        this.serverToolsListChanged = false;
        this.buffer = Buffer.alloc(0);
        const error = abortError(undefined, 'Child MCP client stopped.');
        for (const pending of this.pending.values())
            pending.reject(error);
        this.pending.clear();
        if (child)
            terminateChildProcessTree(child);
    }
    diagnosticFor(phase, message, options = {}) {
        const spawnError = options.spawnError;
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
    requestFailure(phase, message, options = {}) {
        const diagnostic = this.diagnosticFor(phase, message, {
            ...(options.timedOut !== undefined ? { timedOut: options.timedOut } : {}),
            ...(options.kind ? { kind: options.kind } : {}),
        });
        return new ChildMcpRequestError(`${this.options.adapter} adapter request failed during ${phase}: ${message}`, diagnostic, options.code, options.data);
    }
    failConnection(phase, message, options = {}) {
        const diagnostic = this.diagnosticFor(phase, message, options);
        this.lastFailure = diagnostic;
        this.initialized = false;
        this.negotiatedProtocol = null;
        this.serverToolsListChanged = false;
        this.clearHeartbeat();
        this.buffer = Buffer.alloc(0);
        this.options.onDiagnostic?.(diagnostic);
        const error = new ChildMcpError(`${this.options.adapter} adapter failed during ${phase}: ${message}`, diagnostic);
        for (const pending of this.pending.values())
            pending.reject(error);
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
