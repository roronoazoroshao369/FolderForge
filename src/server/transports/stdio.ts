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

import { PassThrough, type Readable, type Writable } from 'node:stream';
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
  return new Promise((resolve, reject) => {
    let first = Buffer.alloc(0);
    const MAX_FIRST_LINE = 1_048_576;
    const onError = (error: Error): void => {
      input.off('data', onData);
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      first = Buffer.concat([first, Buffer.from(chunk)]);
      if (first.length > MAX_FIRST_LINE) {
        input.pause();
        onError(new Error('First MCP stdio request exceeds allowed size'));
        return;
      }
      const separator = first.indexOf(0x0a);
      if (separator < 0) return;
      input.pause();
      input.off('data', onData);
      try {
        const packet = JSON.parse(first.subarray(0, separator).toString('utf8')) as Record<string, unknown>;
        const params = packet.params && typeof packet.params === 'object'
          ? packet.params as Record<string, unknown> : {};
        const meta = params._meta && typeof params._meta === 'object'
          ? params._meta as Record<string, unknown> : {};
        const modern = packet.method === 'server/discover' ||
          Object.keys(meta).some(key => key.startsWith('io.modelcontextprotocol/'));
        const buffered = first;
        const proxy = new PassThrough();
        if (modern) {
          const handle = serveStdio(() => options.makeModern(), {
            legacy: 'reject',
            transport: new ModernStdioServerTransport(proxy, output),
          });
          proxy.write(buffered);
          input.pipe(proxy);
          input.resume();
          resolve(handle);
          return;
        }
        const legacy = options.makeLegacy();
        const transport = new LegacyStdioServerTransport(proxy, output);
        void legacy.connect(transport).then(() => {
          proxy.write(buffered);
          input.pipe(proxy);
          input.resume();
          resolve({
            close: async () => {
              await Promise.allSettled([legacy.close(), transport.close()]);
              input.unpipe(proxy);
              proxy.destroy();
            },
          });
        }, reject);
      } catch (error) {
        reject(error);
      }
    };
    input.on('data', onData);
    input.once('error', onError);
    input.resume();
  });
}
