#!/usr/bin/env node
/**
 * Minimal fake MCP server over stdio, used by FolderForge adapter integration
 * tests. It speaks just enough of the MCP wire protocol that
 * `StdioChildClient` can initialize, list tools, and call one tool.
 *
 * Implements:
 *   - initialize            -> returns server info + capabilities
 *   - notifications/initialized (notification, ignored)
 *   - tools/list            -> two demo tools (echo, add)
 *   - tools/call            -> runs echo/add and returns a text content block
 *
 * Run: node fake-mcp-server.mjs   (communicates on stdin/stdout)
 */

import { createInterface } from 'node:readline';

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the provided text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, message) {
  send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
}

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = msg;

  // Notifications have no id and need no response.
  if (id === undefined) return;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '0.0.1' },
      });
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === 'echo') {
        reply(id, { content: [{ type: 'text', text: String(args.text ?? '') }] });
      } else if (name === 'add') {
        const sum = Number(args.a ?? 0) + Number(args.b ?? 0);
        reply(id, { content: [{ type: 'text', text: String(sum) }] });
      } else {
        replyError(id, `Unknown tool: ${name}`);
      }
      return;
    }
    default:
      replyError(id, `Unknown method: ${method}`);
  }
});
