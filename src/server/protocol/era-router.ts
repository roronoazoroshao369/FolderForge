import type { IncomingHttpHeaders } from 'node:http';
import { MODERN_MCP_VERSION, type McpEra, type ProtocolMode } from './request-context.js';

export type EraDecision =
  | { era: McpEra; protocolVersion: string }
  | { error: 'mixed_era' | 'missing_version' | 'unsupported_version' | 'malformed_request' };

export function modernMetadata(params: unknown): Record<string, unknown> | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const meta = (params as Record<string, unknown>)._meta;
  return meta && typeof meta === 'object' && !Array.isArray(meta)
    ? meta as Record<string, unknown> : null;
}

export function classifyMcpEra(input: {
  mode: ProtocolMode;
  transport: 'stdio' | 'http';
  method: unknown;
  params: unknown;
  headers?: IncomingHttpHeaders;
  lockedEra?: McpEra;
}): EraDecision {
  if (typeof input.method !== 'string' || !input.method) return { error: 'malformed_request' };
  const meta = modernMetadata(input.params);
  const version = meta?.['io.modelcontextprotocol/protocolVersion'];
  const headerVersion = input.headers?.['mcp-protocol-version'];
  const knownLegacyHttpHeader = typeof headerVersion === 'string' &&
    ['2025-11-25', '2025-06-18', '2025-03-26'].includes(headerVersion);
  const modernShape = version !== undefined || input.method === 'server/discover'
    || (headerVersion !== undefined && !knownLegacyHttpHeader)
    || input.headers?.['mcp-method'] !== undefined;
  if (!modernShape) {
    if (input.lockedEra === 'modern') return { error: 'mixed_era' };
    return { era: 'legacy', protocolVersion: '2025-11-25' };
  }
  if (input.method === 'initialize' || input.lockedEra === 'legacy') return { error: 'mixed_era' };
  if (version === undefined) return { error: 'missing_version' };
  if (version !== MODERN_MCP_VERSION || input.mode !== 'dual') return { error: 'unsupported_version' };
  const info = meta?.['io.modelcontextprotocol/clientInfo'];
  const caps = meta?.['io.modelcontextprotocol/clientCapabilities'];
  if (!info || typeof info !== 'object' || Array.isArray(info) ||
      typeof (info as Record<string, unknown>).name !== 'string' ||
      !(info as Record<string, unknown>).name ||
      typeof (info as Record<string, unknown>).version !== 'string' ||
      !(info as Record<string, unknown>).version ||
      !caps || typeof caps !== 'object' || Array.isArray(caps)) {
    return { error: 'malformed_request' };
  }
  return { era: 'modern', protocolVersion: MODERN_MCP_VERSION };
}
