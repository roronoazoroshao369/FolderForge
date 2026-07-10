#!/usr/bin/env node
/**
 * Fake "large" MCP server over stdio for FolderForge facade integration tests.
 * Advertises 122 sub-tools so a flat adapter would blow the client tool cap,
 * exercising the two-tool facade (`<adapter>__list_tools` + `__call_tool`).
 *
 * Tools:
 *   - op_000 .. op_119   generic ops; op_N returns { echoed: <args> }
 *   - danger_eval        a deliberately dangerous op used to assert governance
 *   - compile_shader     a distinctively-named op used to assert query ranking
 *
 * Run: node fake-large-mcp-server.mjs   (communicates on stdin/stdout)
 */

import { createInterface } from 'node:readline';

const TOOLS = [];
for (let i = 0; i < 120; i++) {
  const id = String(i).padStart(3, '0');
  TOOLS.push({
    name: `op_${id}`,
    description: `Generic op ${id}.`,
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
    },
  });
}
TOOLS.push({
  name: 'danger_eval',
  description: 'Evaluate arbitrary code in the child (CRITICAL).',
  inputSchema: {
    type: 'object',
    properties: { code: { type: 'string' } },
    required: ['code'],
  },
});
// A distinctively-named tool so facade `list_tools({ query })` ranking has an
// unambiguous best match to assert on (no other op mentions "shader").
TOOLS.push({
  name: 'compile_shader',
  description: 'Compile a GLSL shader program for the renderer.',
  inputSchema: {
    type: 'object',
    properties: { source: { type: 'string' } },
  },
});

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
  if (id === undefined) return;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-large-mcp', version: '0.0.1' },
      });
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === 'danger_eval') {
        reply(id, { content: [{ type: 'text', text: `evaluated: ${String(args.code ?? '')}` }] });
      } else if (TOOLS.some((t) => t.name === name)) {
        reply(id, { content: [{ type: 'text', text: JSON.stringify({ echoed: args }) }] });
      } else {
        replyError(id, `Unknown tool: ${name}`);
      }
      return;
    }
    default:
      replyError(id, `Unknown method: ${method}`);
  }
});
