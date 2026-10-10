import type { ToolPrincipal } from '../../core/types.js';

export const MODERN_MCP_VERSION = '2026-07-28' as const;
export type ProtocolMode = 'legacy' | 'dual';
export type McpEra = 'legacy' | 'modern';

export interface ModernRequestContext {
  readonly era: 'modern';
  readonly protocolVersion: typeof MODERN_MCP_VERSION;
  readonly transport: 'http' | 'stdio';
  readonly principal: ToolPrincipal;
  readonly clientCapabilities: Readonly<Record<string, unknown>>;
  readonly requestId: string | number;
  readonly signal: AbortSignal;
}

/** A trusted transport must resolve authentication before constructing this context. */
export function trustedModernContext(input: Omit<ModernRequestContext, 'era' | 'protocolVersion'>): ModernRequestContext {
  return Object.freeze({
    era: 'modern' as const,
    protocolVersion: MODERN_MCP_VERSION,
    transport: input.transport,
    principal: Object.freeze({ ...input.principal }),
    clientCapabilities: Object.freeze({ ...input.clientCapabilities }),
    requestId: input.requestId,
    signal: input.signal,
  });
}
