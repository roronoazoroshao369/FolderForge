import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { Server as LegacyServer } from '@modelcontextprotocol/sdk/server/index.js';
import { Server as ModernServer } from '@modelcontextprotocol/server';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startDualStdioTransport } from '../../src/server/transports/stdio.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0)) await action(); });

function harness() {
  const input = new PassThrough();
  const output = new PassThrough();
  let buffer = '';
  const messages: any[] = [];
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });
  async function next() {
    for (let i = 0; i < 100; i++) {
      if (messages.length > 0) return messages.shift();
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('No stdio protocol response');
  }
  let legacyCalls = 0;
  const started = startDualStdioTransport({
    input, output,
    makeLegacy: () => {
      const server = new LegacyServer({ name: 'legacy', version: '1.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        legacyCalls += 1;
        return { content: [{ type: 'text', text: 'DANGEROUS' }] };
      });
      return server;
    },
    makeModern: () => new ModernServer({ name: 'modern', version: '2.0' }, { capabilities: { tools: {} } }),
  });
  cleanup.push(async () => { input.end(); const stop = await started; await stop.close(); output.destroy(); });
  return { input, next, started, legacyCalls: () => legacyCalls };
}

describe('G59 stdio first-request era selection', () => {
  it('serves modern server/discover without initialized handshake', async () => {
    const h = harness();
    h.input.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'server/discover',
      params: { _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'client', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      }},
    }) + '\n');
    await h.started;
    const res = await h.next();
    expect(res.result.supportedVersions).toContain('2026-07-28');
    expect(res.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('modern');
  });
  it('G59-SEC-02: refuses a modern mutation on a locked legacy stream', async () => {
    const h = harness();
    h.input.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } },
    }) + '\n');
    await h.started;
    expect((await h.next()).result.serverInfo.name).toBe('legacy');
    h.input.write(JSON.stringify({
      jsonrpc: '2.0', id: 77, method: 'tools/call',
      params: { name: 'file_write', arguments: {}, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'modern', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } },
    }) + '\n');
    const denied = await h.next();
    expect(denied.id).toBe(77);
    expect(denied.error).toBeTruthy();
    expect(h.legacyCalls()).toBe(0);
  });

  it('G59-SEC-02: legacy initialize with invalid params cannot lock the stream', async () => {
    const h = harness();
    h.input.write(JSON.stringify({
      jsonrpc: '2.0', id: 31, method: 'initialize', params: { protocolVersion: '2025-11-25' },
    }) + '\n');
    const rejected = await h.next();
    expect(rejected.id).toBe(31);
    expect(rejected.error).toBeTruthy();
    h.input.write(JSON.stringify({
      jsonrpc: '2.0', id: 32, method: 'server/discover',
      params: { _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'valid-client', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } },
    }) + '\n');
    await h.started;
    expect((await h.next()).result.supportedVersions).toContain('2026-07-28');
  });

  it('G59-SEC-02: discovery missing JSON-RPC id does not pin stdio to modern', async () => {
    const h = harness();
    h.input.write(JSON.stringify({
      jsonrpc: '2.0', method: 'server/discover',
      params: { _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'client', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } },
    }) + '\n');
    const denied = await h.next();
    expect(denied.error).toBeTruthy();
    h.input.write(JSON.stringify({
      jsonrpc: '2.0', id: 55, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } },
    }) + '\n');
    await h.started;
    expect((await h.next()).result.serverInfo.name).toBe('legacy');
  });

  it('G59-SEC-02: invalid initial input must not permanently select an era', async () => {
    const h = harness();
    h.input.write('not a JSON RPC message\n');
    const malformed = await h.next();
    expect(malformed.error).toBeTruthy();
    h.input.write(JSON.stringify({
      jsonrpc: '2.0', id: 9, method: 'server/discover',
      params: { _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'modern', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } },
    }) + '\n');
    await h.started;
    const discovered = await h.next();
    expect(discovered.result.supportedVersions).toContain('2026-07-28');
  });

  it('keeps legacy initialize and its negotiated session unchanged', async () => {
    const h = harness();
    h.input.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-client', version: '1' }},
    }) + '\n');
    await h.started;
    const res = await h.next();
    expect(res.result.serverInfo.name).toBe('legacy');
    expect(res.result.protocolVersion).toBe('2025-11-25');
  });
});
