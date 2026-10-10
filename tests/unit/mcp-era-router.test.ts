import { describe, expect, it } from 'vitest';
import { classifyMcpEra } from '../../src/server/protocol/era-router.js';

const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
describe('version-aware MCP era classification', () => {
  it('keeps legacy initialize and modern discover distinct', () => {
    expect(classifyMcpEra({ mode: 'dual', transport: 'stdio', method: 'initialize', params: { protocolVersion: '2025-11-25' } })).toMatchObject({ era: 'legacy' });
    expect(classifyMcpEra({ mode: 'dual', transport: 'stdio', method: 'server/discover', params: { _meta: meta } })).toMatchObject({ era: 'modern', protocolVersion: '2026-07-28' });
  });
  it('rejects missing or unsupported version and mixed-era messages', () => {
    expect(classifyMcpEra({ mode: 'dual', transport: 'stdio', method: 'server/discover', params: {} })).toEqual({ error: 'missing_version' });
    expect(classifyMcpEra({ mode: 'dual', transport: 'stdio', method: 'tools/list', params: { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } } })).toEqual({ error: 'unsupported_version' });
    expect(classifyMcpEra({ mode: 'dual', transport: 'stdio', method: 'initialize', params: { _meta: meta } })).toEqual({ error: 'mixed_era' });
    expect(classifyMcpEra({ mode: 'dual', transport: 'stdio', method: 'server/discover', params: { _meta: meta }, lockedEra: 'legacy' })).toEqual({ error: 'mixed_era' });
  });
  it('never silently upgrades a legacy-only server', () => {
    expect(classifyMcpEra({ mode: 'legacy', transport: 'http', method: 'server/discover', params: { _meta: meta } })).toEqual({ error: 'unsupported_version' });
  });
});
