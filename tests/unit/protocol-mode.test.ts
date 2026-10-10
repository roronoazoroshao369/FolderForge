import { describe, expect, it } from 'vitest';
import { defaultConfig, validateConfig } from '../../src/runtime/config.js';
import { trustedModernContext } from '../../src/server/protocol/request-context.js';

describe('G59 protocol selection', () => {
  it('defaults to legacy without affecting existing transports', () => {
    const config = defaultConfig(process.cwd());
    expect(config.server.mcpProtocol?.mode).toBe('legacy');
    expect(config.server.transport).toBe('stdio');
  });

  it('permits explicitly selected dual and rejects unknown protocol mode', () => {
    const config = defaultConfig(process.cwd());
    config.server.mcpProtocol = { mode: 'dual' };
    expect(() => validateConfig(config)).not.toThrow();
    (config.server.mcpProtocol as { mode: string }).mode = 'unsafe';
    expect(() => validateConfig(config)).toThrow(/mcpProtocol.mode/);
  });

  it('uses trusted server-derived principal instead of untrusted client metadata', () => {
    const principal = { id: 'owner-verified', role: 'agent' as const };
    const context = trustedModernContext({
      principal,
      transport: 'http',
      requestId: 42,
      clientCapabilities: { principal: { id: 'attacker' } },
      signal: new AbortController().signal,
    });
    expect(context.principal.id).toBe('owner-verified');
    expect(context.protocolVersion).toBe('2026-07-28');
  });
});
