import { spawn } from 'node:child_process';
import { logger } from '../../core/logger.js';
import { terminateChildProcessTree } from '../../core/process-tree.js';
import { SecretPolicy } from '../../policy/secret-policy.js';
export class ChildMcpError extends Error {
    diagnostic;
    constructor(message, diagnostic) {
        super(message);
        this.diagnostic = diagnostic;
        this.name = 'ChildMcpError';
    }
}
const DEFAULT_STDERR_LIMIT = 16 * 1024;
const DEFAULT_REQUEST_TIMEOUT = 30_000;
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
        case 'malformed_json_rpc':
            return 'The child wrote invalid data to its MCP stdout channel. Verify package integrity and adapter compatibility.';
        default:
            return 'Run `folderforge doctor` and inspect the adapter readiness finding and stderr tail.';
    }
}
/** Minimal JSON-RPC client over a child MCP server's stdio. */
export class StdioChildClient {
    options;
    child = null;
    pending = new Map();
    nextId = 1;
    buffer = '';
    initialized = false;
    currentPhase = 'spawn';
    stderrTail = '';
    stderrRawTail = '';
    stopping = false;
    lastFailure = null;
    requestTimeoutMs;
    stderrLimit;
    redact;
    constructor(options) {
        this.options = options;
        this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT;
        this.stderrLimit = options.stderrLimit ?? DEFAULT_STDERR_LIMIT;
        this.redact = options.redact ?? ((text) => secretPolicy.redact(text));
    }
    async start() {
        if (this.isReady())
            return;
        if (this.child)
            this.stop();
        this.stopping = false;
        this.stderrTail = '';
        this.stderrRawTail = '';
        this.buffer = '';
        this.currentPhase = 'spawn';
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
            child.stdout.on('data', (chunk) => this.onData(chunk));
            child.stderr.on('data', (chunk) => this.onStderr(chunk));
            child.on('exit', (code, signal) => this.onExit(code, signal));
            child.stdin.on('error', (error) => {
                if (!this.stopping)
                    this.fail(this.currentPhase, error.message, { spawnError: error });
            });
            await new Promise((resolveSpawn, rejectSpawn) => {
                const onSpawn = () => {
                    child.off('error', onError);
                    resolveSpawn();
                };
                const onError = (error) => {
                    child.off('spawn', onSpawn);
                    rejectSpawn(this.fail('spawn', error.message, { spawnError: error }));
                };
                child.once('spawn', onSpawn);
                child.once('error', onError);
            });
        }
        catch (error) {
            if (error instanceof ChildMcpError)
                throw error;
            throw this.fail('spawn', error instanceof Error ? error.message : String(error), error instanceof Error ? { spawnError: error } : {});
        }
        try {
            this.currentPhase = 'initialize';
            await this.request('initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'folderforge', version: '0.1.0' },
            }, this.requestTimeoutMs, 'initialize');
            this.notify('notifications/initialized', {});
            this.initialized = true;
            this.currentPhase = 'runtime';
            this.lastFailure = null;
        }
        catch (error) {
            this.stop();
            throw error;
        }
    }
    onStderr(chunk) {
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
    onExit(code, signal) {
        const phase = this.currentPhase;
        const wasStopping = this.stopping;
        this.child = null;
        this.initialized = false;
        if (wasStopping)
            return;
        const error = this.fail(phase, `child process exited${code === null ? '' : ` with code ${code}`}`, {
            exitCode: code,
            signal,
            terminate: false,
        });
        logger.warn({ diagnostic: error.diagnostic }, 'child MCP adapter failed');
    }
    onData(chunk) {
        this.buffer += chunk.toString('utf8');
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (!line)
                continue;
            let msg;
            try {
                msg = JSON.parse(line);
            }
            catch {
                this.fail(this.currentPhase, 'Malformed JSON-RPC received from child stdout.', {
                    kind: 'malformed_json_rpc',
                });
                return;
            }
            if (typeof msg.id !== 'number' || !this.pending.has(msg.id))
                continue;
            const pending = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error)
                pending.reject(this.fail(pending.phase, msg.error.message ?? `Child MCP ${pending.method} failed.`, {
                    terminate: pending.phase !== 'runtime',
                }));
            else
                pending.resolve(msg.result);
        }
    }
    notify(method, params) {
        if (!this.child)
            return;
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    }
    request(method, params, timeoutMs = this.requestTimeoutMs, phase = 'runtime') {
        if (!this.child) {
            return Promise.reject(this.fail(phase, 'child not started', { terminate: false }));
        }
        this.currentPhase = phase;
        const id = this.nextId++;
        const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
        return new Promise((resolveRequest, rejectRequest) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                rejectRequest(this.fail(phase, `child request timed out: ${method}`, { timedOut: true }));
            }, timeoutMs);
            this.pending.set(id, {
                method,
                phase,
                resolve: (value) => {
                    clearTimeout(timer);
                    if (phase !== 'initialize')
                        this.currentPhase = 'runtime';
                    resolveRequest(value);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    rejectRequest(error);
                },
            });
            try {
                this.child.stdin.write(payload);
            }
            catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                rejectRequest(this.fail(phase, error instanceof Error ? error.message : String(error)));
            }
        });
    }
    async listTools(timeoutMs = this.requestTimeoutMs) {
        const res = (await this.request('tools/list', {}, timeoutMs, 'tools/list'));
        if (!res || !Array.isArray(res.tools)) {
            throw this.fail('tools/list', 'tools/list returned an invalid result.', { kind: 'tools_list_failure' });
        }
        this.currentPhase = 'runtime';
        return res.tools;
    }
    async callTool(name, args) {
        return this.request('tools/call', { name, arguments: args }, this.requestTimeoutMs, 'runtime');
    }
    isReady() {
        return this.initialized && this.child !== null;
    }
    pid() {
        return this.child?.pid;
    }
    diagnostic() {
        return this.lastFailure ? { ...this.lastFailure, args: [...this.lastFailure.args] } : null;
    }
    async stopAndWait(timeoutMs = 1_000) {
        const child = this.child;
        this.stop();
        if (!child || child.exitCode !== null || child.signalCode !== null)
            return;
        const exited = await Promise.race([
            new Promise((resolveExit) => child.once('exit', () => resolveExit(true))),
            new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), timeoutMs)),
        ]);
        if (!exited && child.exitCode === null && child.signalCode === null) {
            terminateChildProcessTree(child, true);
        }
    }
    stop() {
        const child = this.child;
        this.stopping = true;
        this.child = null;
        this.initialized = false;
        this.currentPhase = 'shutdown';
        for (const pending of this.pending.values())
            pending.reject(new Error('child stopped'));
        this.pending.clear();
        if (child)
            terminateChildProcessTree(child);
    }
    fail(phase, message, options = {}) {
        const spawnError = options.spawnError;
        const kind = options.kind ?? classifyChildFailure(phase, {
            message,
            stderr: this.stderrTail,
            ...(options.timedOut !== undefined ? { timedOut: options.timedOut } : {}),
            ...(spawnError?.code ? { code: spawnError.code } : {}),
        });
        const safeArgs = redactChildArgs(this.options.args);
        const diagnostic = {
            adapter: this.options.adapter,
            command: this.options.command,
            args: safeArgs,
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
        this.lastFailure = diagnostic;
        this.options.onDiagnostic?.(diagnostic);
        const error = new ChildMcpError(`${this.options.adapter} adapter failed during ${phase}: ${message}`, diagnostic);
        for (const pending of this.pending.values())
            pending.reject(error);
        this.pending.clear();
        if (options.terminate !== false && this.child) {
            const child = this.child;
            this.child = null;
            this.initialized = false;
            this.stopping = true;
            terminateChildProcessTree(child);
        }
        return error;
    }
}
