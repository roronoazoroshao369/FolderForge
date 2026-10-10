import { describe, expect, it } from 'vitest';
import { decodeMirroredHeader, validateModernHttpEnvelope } from '../../src/server/protocol/http-headers.js';

const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'file_read', arguments: { path: '/tmp' }, _meta: meta } };
const headers = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'file_read' };

describe('2026 HTTP mirrored-header validation', () => {
  it('accepts matched 2026 modern tool request', () => {
    expect(validateModernHttpEnvelope(request, headers)).toMatchObject({ ok: true, method: 'tools/call', name: 'file_read' });
  });
  it('rejects duplicate and encoded header spoof', () => {
    expect(validateModernHttpEnvelope(request, { ...headers, 'mcp-name': ['file_read', 'file_write'] })).toMatchObject({ ok: false, status: 400, code: -32020 });
    expect(validateModernHttpEnvelope(request, { ...headers, 'mcp-name': 'file_write' })).toMatchObject({ ok: false, status: 400, code: -32020 });
    expect(() => decodeMirroredHeader('=?base64?@@@?=')).toThrow();
  });
  it('decodes nonascii header names and rejects unsafe raw values', () => {
    const name = 'đọc/tệp';
    const encoded = `=?base64?${Buffer.from(name, 'utf8').toString('base64')}?=`;
    expect(decodeMirroredHeader(encoded)).toBe(name);
    expect(validateModernHttpEnvelope({ ...request, params: { ...request.params, name } }, { ...headers, 'mcp-name': encoded })).toMatchObject({ ok: true });
    expect(validateModernHttpEnvelope({ ...request, params: { ...request.params, name } }, { ...headers, 'mcp-name': name })).toMatchObject({ ok: false, code: -32020 });
  });
  it('rejects unsupported unconfigured custom parameter header forwarding', () => {
    expect(validateModernHttpEnvelope(request, { ...headers, 'mcp-param-Tenant': 'foreign-tenant' })).toMatchObject({ ok: false, code: -32020 });
  });
  it('enforces required version and method header agreements', () => {
    expect(validateModernHttpEnvelope(request, { ...headers, 'mcp-protocol-version': '2025-11-25' })).toMatchObject({ ok: false, status: 400, code: -32020 });
    expect(validateModernHttpEnvelope(request, { ...headers, 'mcp-method': 'tools/list' })).toMatchObject({ ok: false, status: 400, code: -32020 });
  });
});
