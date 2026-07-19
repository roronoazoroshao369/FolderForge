import readline from 'node:readline';
import { writeFile } from 'node:fs/promises';

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

lines.on('line', async (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (!request || request.jsonrpc !== '2.0' || request.id === undefined) return;
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: request.params?.protocolVersion ?? '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'folderforge-sandbox-benchmark', version: '1.0.0' }
    }});
    return;
  }
  if (request.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: request.id, result: { tools: [{
      name: 'inspect_boundary',
      description: 'Report sandbox evidence and write a bounded workspace file.',
      inputSchema: { type: 'object', properties: {} }
    }] }});
    return;
  }
  if (request.method === 'tools/call' && request.params?.name === 'inspect_boundary') {
    let workspaceWrite = false;
    try {
      await writeFile('/workspace/sandbox-proof.txt', 'sandbox workspace write\n');
      workspaceWrite = true;
    } catch {}
    send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({
      workspaceWrite,
      undeclaredSecretVisible: Boolean(process.env.FOLDERFORGE_BENCHMARK_UNDECLARED_SECRET),
      declaredValue: process.env.BENCHMARK_ALLOWED ?? null,
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      cwd: process.cwd()
    }) }] }});
    return;
  }
  send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
});
