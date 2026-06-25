import { describe, it, expect } from 'vitest';
import { SecretPolicy, shannonEntropy } from '../../src/policy/secret-policy.js';
import type { SecretScanConfig } from '../../src/core/types.js';

const ENTROPY_ON: SecretScanConfig = { entropyEnabled: true, minEntropy: 4.0, minLength: 20 };
const ENTROPY_OFF: SecretScanConfig = { entropyEnabled: false, minEntropy: 4.0, minLength: 20 };

describe('shannonEntropy', () => {
  it('is 0 for empty and single-char strings', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
  });

  it('is higher for random-looking content than for words', () => {
    const random = shannonEntropy('aZ9kQ2mX7pL4wR8tV1nB');
    const word = shannonEntropy('passwordpassword');
    expect(random).toBeGreaterThan(word);
  });
});

describe('SecretPolicy entropy scanning', () => {
  it('flags a high-entropy token that no regex rule matches', () => {
    const policy = new SecretPolicy(ENTROPY_ON);
    // A bespoke key format not covered by the named rules.
    const text = 'CUSTOM_TOKEN=Zk9Qx2Lm7Pw4Rt8Vn1Bc6Hd3Sg5Yf0Aj';
    const findings = policy.scan(text);
    const entropyFinding = findings.find((f) => f.rule === 'high entropy');
    expect(entropyFinding).toBeDefined();
    expect(entropyFinding?.entropy).toBeGreaterThanOrEqual(4.0);
  });

  it('does not flag short or low-entropy tokens', () => {
    const policy = new SecretPolicy(ENTROPY_ON);
    const findings = policy.scan('const greeting = "hello world this is fine";');
    expect(findings.find((f) => f.rule === 'high entropy')).toBeUndefined();
  });

  it('respects entropyEnabled=false', () => {
    const policy = new SecretPolicy(ENTROPY_OFF);
    const findings = policy.scan('CUSTOM_TOKEN=Zk9Qx2Lm7Pw4Rt8Vn1Bc6Hd3Sg5Yf0Aj');
    expect(findings.find((f) => f.rule === 'high entropy')).toBeUndefined();
  });

  it('still catches known regex secrets alongside entropy', () => {
    const policy = new SecretPolicy(ENTROPY_ON);
    const findings = policy.scan('key = sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(findings.some((f) => f.rule === 'OpenAI key')).toBe(true);
  });

  it('honors a higher minLength threshold', () => {
    const strict = new SecretPolicy({ entropyEnabled: true, minEntropy: 4.0, minLength: 100 });
    const findings = strict.scan('CUSTOM_TOKEN=Zk9Qx2Lm7Pw4Rt8Vn1Bc6Hd3Sg5Yf0Aj');
    expect(findings.find((f) => f.rule === 'high entropy')).toBeUndefined();
  });
});
