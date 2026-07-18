#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'success';
const pidFile = process.argv[3];
if (pidFile) writeFileSync(pidFile, String(process.pid), 'utf8');

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function initialize(id) {
  send({
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'diagnostic-fixture', version: '1.0.0' },
    },
  });
}

if (mode === 'exit-before-init') {
  process.stderr.write('Playwright adapter boot failed: invalid adapter arguments\n');
  process.exit(1);
}

if (mode === 'stderr-flood-exit') {
  process.stderr.write(`${'x'.repeat(24 * 1024)}\nOPENAI_API_KEY=sk-${'a'.repeat(32)}\n`);
  process.exit(1);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (mode === 'malformed') {
    process.stdout.write('this is not json-rpc\n');
    return;
  }

  if (message.method === 'initialize') {
    if (mode === 'initialize-timeout') return;
    initialize(message.id);
    return;
  }

  if (message.method === 'notifications/initialized') return;

  if (message.method === 'tools/list') {
    if (mode === 'tools-list-timeout') return;
    if (mode === 'invalid-tools-list') {
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo text.',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
            },
          },
        ],
      },
    });
    return;
  }

  if (message.method === 'tools/call') {
    if (mode === 'crash-after-ready') {
      process.stderr.write('runtime browser crash\n');
      process.exit(7);
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: String(message.params?.arguments?.text ?? '') }] },
    });
  }
});
