import { describe, expect, it } from 'vitest';
import { makeHttpSmokeApiKey } from '../../scripts/smoke-http-auth.mjs';

describe('authenticated HTTP smoke fixture credential', () => {
  it('is a CLI-safe value even if the random Base64URL token starts with a hyphen', () => {
    const bytes = Buffer.alloc(32, 0);
    bytes[0] = 0xfb; // Base64URL begins with '-', which the CLI interprets as an option.
    const credential = makeHttpSmokeApiKey(() => bytes);

    expect(bytes.toString('base64url').startsWith('-')).toBe(true);
    expect(credential).toMatch(/^smoke_[A-Za-z0-9_-]+$/);
    expect(credential).not.toMatch(/^-/);
    expect(credential.slice('smoke_'.length)).toBe(bytes.toString('base64url'));
  });

  it('requests 32 unpredictable bytes and preserves their encoding', () => {
    const bytes = Buffer.alloc(32, 255);
    const requested: number[] = [];
    const credential = makeHttpSmokeApiKey((size: number) => {
      requested.push(size);
      return bytes;
    });

    expect(requested).toEqual([32]);
    expect(credential).toBe(`smoke_${bytes.toString('base64url')}`);
  });
});
