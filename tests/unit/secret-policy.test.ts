import { describe, it, expect } from 'vitest';
import { SecretPolicy } from '../../src/policy/secret-policy.js';

const policy = new SecretPolicy();

describe('SecretPolicy.scan', () => {
  it('detects an AWS access key id', () => {
    const findings = policy.scan('aws_key = AKIAIOSFODNN7EXAMPLE');
    expect(findings.some((f) => f.rule === 'AWS access key id')).toBe(true);
  });

  it('detects a GitHub token', () => {
    const findings = policy.scan('token: ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(findings.some((f) => f.rule === 'GitHub token')).toBe(true);
  });

  it('detects a private key block', () => {
    const findings = policy.scan('-----BEGIN RSA PRIVATE KEY-----');
    expect(findings.some((f) => f.rule === 'Private key block')).toBe(true);
  });

  it('reports line numbers', () => {
    const text = 'line one\nline two\nAKIAIOSFODNN7EXAMPLE\n';
    const findings = policy.scan(text);
    const hit = findings.find((f) => f.rule === 'AWS access key id');
    expect(hit?.line).toBe(3);
  });

  it('returns no findings for clean text', () => {
    expect(policy.scan('just some normal text\nwith no secrets')).toHaveLength(0);
  });
});

describe('SecretPolicy.redact', () => {
  it('redacts an OpenAI key', () => {
    const out = policy.redact('key=sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts generic key=value assignments but keeps the key', () => {
    const out = policy.redact('password = hunter2secret');
    expect(out).toContain('password');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('hunter2secret');
  });

  it('redacts named env secret assignments', () => {
    const out = policy.redact('GITHUB_TOKEN=ghp_realtokenvalue123456789');
    expect(out).toContain('GITHUB_TOKEN=');
    expect(out).not.toContain('ghp_realtokenvalue123456789');
  });
});

describe('SecretPolicy.redactEnv', () => {
  it('redacts known and heuristic secret env vars', () => {
    const out = policy.redactEnv({
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'ghp_x',
      MY_API_KEY: 'abc',
      DB_PASSWORD: 'pw',
    });
    expect(out.PATH).toBe('/usr/bin');
    expect(out.GITHUB_TOKEN).toBe('[REDACTED]');
    expect(out.MY_API_KEY).toBe('[REDACTED]');
    expect(out.DB_PASSWORD).toBe('[REDACTED]');
  });

  it('skips undefined values', () => {
    const out = policy.redactEnv({ A: undefined, B: 'keep' });
    expect('A' in out).toBe(false);
    expect(out.B).toBe('keep');
  });
});
