#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'success';
const pidFile = process.argv[3];
if (pidFile) writeFileSync(pidFile, String(process.pid), 'utf8');

let catalogRevision = 1;
let listCount = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function initialize(id, params) {
  const protocolVersion = mode === 'unsupported-protocol'
    ? '2099-01-01'
    : mode === 'legacy-protocol'
      ? '2024-11-05'
      : params?.protocolVersion;
  const listChanged = mode === 'list-change';
  send({
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion,
      capabilities: { tools: listChanged ? { listChanged: true } : {} },
      serverInfo: { name: 'diagnostic-fixture', version: '1.0.0' },
    },
  });
}

function tool(name) {
  return {
    name,
    description: `${name} tool.`,
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
    },
  };
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
    initialize(message.id, message.params);
    return;
  }

  if (message.method === 'notifications/initialized') return;

  if (message.method === 'tools/list') {
    if (mode === 'tools-list-timeout') return;
    if (mode === 'invalid-tools-list') {
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    }
    if (mode === 'paginated-tools') {
      const cursor = message.params?.cursor;
      if (cursor === undefined) {
        send({ jsonrpc: '2.0', id: message.id, result: { tools: [tool('page-one')], nextCursor: 'page-2' } });
      } else if (cursor === 'page-2') {
        send({ jsonrpc: '2.0', id: message.id, result: { tools: [tool('page-two')], nextCursor: 'page-3' } });
      } else if (cursor === 'page-3') {
        send({ jsonrpc: '2.0', id: message.id, result: { tools: [tool('page-three')] } });
      } else {
        send({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
      }
      return;
    }
    if (mode === 'pagination-cycle') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: [tool(`cycle-${listCount += 1}`)], nextCursor: 'repeat' },
      });
      return;
    }
    if (mode === 'list-change' || mode === 'unadvertised-list-change') {
      listCount += 1;
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: [tool(`echo-v${catalogRevision}`)] },
      });
      if (listCount === 1) {
        catalogRevision = 2;
        setTimeout(() => {
          send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
        }, 10);
      }
      return;
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { tools: [tool('echo')] },
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
