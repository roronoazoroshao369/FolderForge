import { describe, it, expect } from 'vitest';
import {
  isLoopbackHost,
  timingSafeEqualStr,
  extractBearer,
  extractApiKey,
  matchesAnyCredential,
  resolveCorsOrigin,
} from '../../src/server/transports/http.js';

describe('http transport hardening helpers', () => {
  it('identifies loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
  });

  it('compares tokens in constant time and matches exactly', () => {
    expect(timingSafeEqualStr('secret-token', 'secret-token')).toBe(true);
    expect(timingSafeEqualStr('secret-token', 'secret-toker')).toBe(false);
    expect(timingSafeEqualStr('short', 'longer-token')).toBe(false);
    expect(timingSafeEqualStr('', '')).toBe(true);
  });

  it('extracts a bearer token from the Authorization header', () => {
    expect(extractBearer({ headers: { authorization: 'Bearer abc123' } })).toBe('abc123');
    expect(extractBearer({ headers: { authorization: 'Basic abc123' } })).toBeUndefined();
    expect(extractBearer({ headers: {} })).toBeUndefined();
  });

  it('extracts a credential from the X-API-Key header', () => {
    expect(extractApiKey({ headers: { 'x-api-key': 'key-1' } })).toBe('key-1');
    expect(extractApiKey({ headers: { 'x-api-key': '  key-2  ' } })).toBe('key-2');
    expect(extractApiKey({ headers: { 'x-api-key': ['key-3', 'key-4'] } })).toBe('key-3');
    expect(extractApiKey({ headers: { 'x-api-key': '' } })).toBeUndefined();
    expect(extractApiKey({ headers: {} })).toBeUndefined();
  });

  it('matches a provided credential against the accepted list in constant time', () => {
    const accepted = ['primary-token', 'client-a-key', 'client-b-key'];
    expect(matchesAnyCredential('primary-token', accepted)).toBe(true);
    expect(matchesAnyCredential('client-b-key', accepted)).toBe(true);
    expect(matchesAnyCredential('wrong-key', accepted)).toBe(false);
    expect(matchesAnyCredential(undefined, accepted)).toBe(false);
    expect(matchesAnyCredential('primary-token', [])).toBe(false);
  });

  it('resolves CORS origins against the allowlist', () => {
    expect(resolveCorsOrigin('https://app.test', undefined)).toBeNull();
    expect(resolveCorsOrigin('https://app.test', [])).toBeNull();
    expect(resolveCorsOrigin('https://app.test', ['*'])).toBe('https://app.test');
    expect(resolveCorsOrigin(undefined, ['*'])).toBe('*');
    expect(resolveCorsOrigin('https://app.test', ['https://app.test'])).toBe('https://app.test');
    expect(resolveCorsOrigin('https://evil.test', ['https://app.test'])).toBeNull();
  });
});
