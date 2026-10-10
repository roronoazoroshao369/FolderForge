import type { IncomingHttpHeaders } from 'node:http';
import { MODERN_MCP_VERSION } from './request-context.js';

export type ModernHttpValidation =
  | { ok: true; method: string; name?: string; protocolVersion: typeof MODERN_MCP_VERSION }
  | { ok: false; status: 400 | 404; code: number; error: string };

const sentinel = /^=\?base64\?([a-zA-Z0-9+/]+={0,2})\?=$/;
const plainAscii = /^[\x20-\x7e]*$/;

export function decodeMirroredHeader(value: string): string {
  const b64 = sentinel.exec(value);
  if (b64) {
    const decoded = Buffer.from(b64[1]!, 'base64');
    if (decoded.toString('base64') !== b64[1] || decoded.toString('utf8').includes('\ufffd')) {
      throw new Error('Invalid canonical Base64 header');
    }
    return decoded.toString('utf8');
  }
  if (value.startsWith('=?base64?') || !plainAscii.test(value) || value.trim() !== value) {
    throw new Error('Header requires canonical Base64 sentinel');
  }
  return value;
}

function header(headers: IncomingHttpHeaders, key: string): string | undefined {
  const entries = Object.entries(headers).filter(([name]) => name.toLowerCase() === key.toLowerCase());
  if (entries.length > 1 || entries.some(([, v]) => Array.isArray(v))) throw new Error(`Duplicate ${key}`);
  return entries[0]?.[1] as string | undefined;
}
const bad = (error: string): ModernHttpValidation => ({ ok: false, status: 400, code: -32020, error });

export function validateModernHttpEnvelope(body: unknown, headers: IncomingHttpHeaders): ModernHttpValidation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Malformed JSON-RPC body');
  const msg = body as Record<string, unknown>;
  const isNotification = typeof msg.method === 'string' && msg.method.startsWith('notifications/') && !('id' in msg);
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' ||
      (!('id' in msg) && !isNotification)) return bad('Invalid JSON-RPC request');
  const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params)
    ? msg.params as Record<string, unknown> : {};
  const meta = params._meta && typeof params._meta === 'object' && !Array.isArray(params._meta)
    ? params._meta as Record<string, unknown> : {};
  const bodyVersion = meta['io.modelcontextprotocol/protocolVersion'];
  try {
    const version = header(headers, 'mcp-protocol-version');
    const method = header(headers, 'mcp-method');
    if (!version || version !== bodyVersion) return bad('MCP-Protocol-Version differs from body');
    if (!method || method !== msg.method) return bad('Mcp-Method differs from body');
    const name = msg.method === 'resources/read' ? params.uri
      : ['tools/call', 'prompts/get'].includes(msg.method) ? params.name : undefined;
    // No G59 tool schemas advertise the optional x-mcp-header extension.
    // Until we can validate against an annotated schema, reject supplied
    // Mcp-Param-* values rather than ignoring a potentially routed claim.
    if (Object.keys(headers).some(key => key.toLowerCase().startsWith('mcp-param-'))) {
      return bad('Unsupported Mcp-Param header');
    }
    const mirroredName = header(headers, 'mcp-name');
    if (name !== undefined) {
      if (typeof name !== 'string' || !mirroredName || decodeMirroredHeader(mirroredName) !== name) return bad('Mcp-Name differs from body');
    } else if (mirroredName !== undefined) return bad('Unexpected Mcp-Name');
    if (bodyVersion !== MODERN_MCP_VERSION) return bad('Invalid MCP version');
    return { ok: true, method: msg.method, protocolVersion: MODERN_MCP_VERSION, ...(typeof name === 'string' ? { name } : {}) };
  } catch (error) {
    return bad(error instanceof Error ? error.message : String(error));
  }
}
