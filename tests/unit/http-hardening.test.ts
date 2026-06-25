import { describe, it, expect } from 'vitest';
import {
  isLoopbackHost,
  timingSafeEqualStr,
  extractBearer,
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

  it('resolves CORS origins against the allowlist', () => {
    expect(resolveCorsOrigin('https://app.test', undefined)).toBeNull();
    expect(resolveCorsOrigin('https://app.test', [])).toBeNull();
    expect(resolveCorsOrigin('https://app.test', ['*'])).toBe('https://app.test');
    expect(resolveCorsOrigin(undefined, ['*'])).toBe('*');
    expect(resolveCorsOrigin('https://app.test', ['https://app.test'])).toBe('https://app.test');
    expect(resolveCorsOrigin('https://evil.test', ['https://app.test'])).toBeNull();
  });
});
