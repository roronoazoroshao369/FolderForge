import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { Server as LegacyServer } from '@modelcontextprotocol/sdk/server/index.js';
import { Server as ModernServer } from '@modelcontextprotocol/server';
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
  const started = startDualStdioTransport({
    input, output,
    makeLegacy: () => new LegacyServer({ name: 'legacy', version: '1.0' }, { capabilities: { tools: {} } }),
    makeModern: () => new ModernServer({ name: 'modern', version: '2.0' }, { capabilities: { tools: {} } }),
  });
  cleanup.push(async () => { input.end(); const stop = await started; await stop.close(); output.destroy(); });
  return { input, next, started };
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
