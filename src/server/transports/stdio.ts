import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { logger } from '../../core/logger.js';

/**
 * Bind the MCP server to the stdio transport.
 *
 * stdin/stdout carry the JSON-RPC channel, so logs must go to stderr only
 * (see core/logger.ts). Returns once the transport is connected.
 */
export async function startStdioTransport(server: Server): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('MCP stdio transport connected');
  return transport;
}

import { Transform, type Readable, type Writable } from 'node:stream';
import { classifyMcpEra, modernMetadata } from '../protocol/era-router.js';
import { StdioServerTransport as LegacyStdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StdioServerTransport as ModernStdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Server as ModernServer } from '@modelcontextprotocol/server';

/**
 * The opening RPC pins exactly one protocol era to this stdio process.
 * Unlike SDK v2's generic legacy fallback, this keeps the *existing* v1
 * MCP server, including its legacy Tasks and notification handlers.
 */
export async function startDualStdioTransport(options: {
  makeLegacy: () => Server;
  makeModern: () => ModernServer;
  input?: Readable;
  output?: Writable;
}): Promise<{ close(): Promise<void> }> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const MAX_MESSAGE = 1_048_576;
  const writeError = (id: unknown, code: number, message: string): void => {
    output.write(JSON.stringify({
      jsonrpc: '2.0', id: typeof id === 'number' || typeof id === 'string' ? id : null,
      error: { code, message },
    }) + '\n');
  };
  const decode = (line: string): Record<string, unknown> | null => {
    try {
      const packet: unknown = JSON.parse(line);
      return packet && typeof packet === 'object' && !Array.isArray(packet)
        ? packet as Record<string, unknown> : null;
    } catch { return null; }
  };

  return new Promise((resolve, reject) => {
    let first = Buffer.alloc(0);
    let selected = false;
    const onError = (error: Error): void => {
      input.off('data', onData);
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      first = Buffer.concat([first, Buffer.from(chunk)]);
      if (first.length > MAX_MESSAGE && !first.includes(0x0a)) {
        input.pause();
        onError(new Error('First MCP stdio request exceeds allowed size'));
        return;
      }
      while (!selected) {
        const separator = first.indexOf(0x0a);
        if (separator < 0) return;
        const line = first.subarray(0, separator).toString('utf8');
        const rest = first.subarray(separator + 1);
        first = Buffer.from(rest);
        if (Buffer.byteLength(line) > MAX_MESSAGE) {
          writeError(null, -32600, 'MCP message too large');
          continue;
        }
        const packet = decode(line);
        if (!packet || packet.jsonrpc !== '2.0' || typeof packet.method !== 'string') {
          writeError(packet?.id, -32600, 'Invalid initial MCP JSON-RPC request');
          continue;
        }
        const decision = classifyMcpEra({
          mode: 'dual', transport: 'stdio', method: packet.method, params: packet.params,
        });
        const validOpening = !('error' in decision) &&
          (decision.era === 'modern' || packet.method === 'initialize');
        if (!validOpening) {
          writeError(packet.id, -32600, 'Expected valid MCP opening request');
          continue;
        }
        selected = true;
        input.pause();
        input.off('data', onData);
        const era = decision.era;
        let queued = Buffer.alloc(0);
        const guard = new Transform({
          transform(chunk, _encoding, callback) {
            queued = Buffer.concat([queued, Buffer.from(chunk)]);
            while (true) {
              const i = queued.indexOf(0x0a);
              if (i < 0) break;
              const raw = queued.subarray(0, i);
              queued = Buffer.from(queued.subarray(i + 1));
              if (raw.length > MAX_MESSAGE) {
                writeError(null, -32600, 'MCP message too large');
                continue;
              }
              const next = decode(raw.toString('utf8'));
              if (!next) {
                writeError(null, -32700, 'Invalid MCP JSON');
                continue;
              }
              const meta = modernMetadata(next.params);
              const marker = next.method === 'server/discover' ||
                (meta !== null && Object.keys(meta).some(key => key.startsWith('io.modelcontextprotocol/')));
              const crossEra = era === 'legacy' ? marker :
                'error' in classifyMcpEra({
                  mode: 'dual', transport: 'stdio', method: next.method, params: next.params,
                  lockedEra: 'modern',
                });
              if (crossEra) {
                writeError(next.id, -32602, 'Mixed MCP protocol era on one stdio stream');
                continue;
              }
              this.push(Buffer.concat([raw, Buffer.from('\n')]));
            }
            if (queued.length > MAX_MESSAGE) {
              writeError(null, -32600, 'MCP message too large');
              queued = Buffer.alloc(0);
            }
            callback();
          },
          flush(callback) {
            if (queued.length > 0) writeError(null, -32700, 'Incomplete MCP JSON line');
            callback();
          },
        });
        // Preserve the validated first request; inspect every subsequent
        // message before either underlying SDK can execute a tool handler.
        const initial = Buffer.concat([Buffer.from(line + '\n'), first]);
        if (era === 'modern') {
          const handle = serveStdio(() => options.makeModern(), {
            legacy: 'reject', transport: new ModernStdioServerTransport(guard, output),
          });
          // Feed the first validated message directly, then route all subsequent
          // bytes through a classifier with no silent cross-era downgrade.
          guard.write(Buffer.from(line + '\n'));
          if (first.length) guard.write(first);
          input.pipe(guard);
          input.resume();
          resolve({ close: async () => {
            input.unpipe(guard);
            await handle.close();
            guard.destroy();
          } });
        } else {
          const legacy = options.makeLegacy();
          const transport = new LegacyStdioServerTransport(guard, output);
          void legacy.connect(transport).then(() => {
            guard.write(Buffer.from(line + '\n'));
            if (initial.length > line.length + 1) guard.write(first);
            input.pipe(guard);
            input.resume();
            resolve({ close: async () => {
              input.unpipe(guard);
              await Promise.allSettled([legacy.close(), transport.close()]);
              guard.destroy();
            } });
          }, reject);
        }
        return;
      }
    };
    input.on('data', onData);
    input.once('error', onError);
    input.resume();
  });
}
