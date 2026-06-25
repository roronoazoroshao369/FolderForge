import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../src/policy/rate-limiter.js';
import type { RateLimitConfig } from '../../src/core/types.js';

function makeConfig(over: Partial<RateLimitConfig> = {}): RateLimitConfig {
  return {
    enabled: true,
    default: { maxCalls: 3, windowMs: 1000 },
    overrides: {},
    ...over,
  };
}

describe('RateLimiter', () => {
  it('allows calls up to the window limit then blocks', () => {
    let now = 0;
    const rl = new RateLimiter(makeConfig(), () => now);
    expect(rl.hit('file_read').allowed).toBe(true);
    expect(rl.hit('file_read').allowed).toBe(true);
    expect(rl.hit('file_read').allowed).toBe(true);
    const blocked = rl.hit('file_read');
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/Rate limit/);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('frees up capacity after the window slides', () => {
    let now = 0;
    const rl = new RateLimiter(makeConfig(), () => now);
    rl.hit('x');
    rl.hit('x');
    rl.hit('x');
    expect(rl.hit('x').allowed).toBe(false);
    now = 1001; // window has passed
    expect(rl.hit('x').allowed).toBe(true);
  });

  it('tracks each tool independently', () => {
    let now = 0;
    const rl = new RateLimiter(makeConfig(), () => now);
    rl.hit('a');
    rl.hit('a');
    rl.hit('a');
    expect(rl.hit('a').allowed).toBe(false);
    expect(rl.hit('b').allowed).toBe(true);
  });

  it('applies per-tool overrides', () => {
    let now = 0;
    const rl = new RateLimiter(
      makeConfig({ overrides: { git_push: { maxCalls: 1, windowMs: 1000 } } }),
      () => now
    );
    expect(rl.hit('git_push').allowed).toBe(true);
    expect(rl.hit('git_push').allowed).toBe(false);
  });

  it('enforces a rolling daily quota independent of the window', () => {
    let now = 0;
    const rl = new RateLimiter(
      makeConfig({ default: { maxCalls: 100, windowMs: 10, dailyQuota: 2 } }),
      () => now
    );
    expect(rl.hit('t').allowed).toBe(true);
    now = 20; // outside the 10ms window, but same day
    expect(rl.hit('t').allowed).toBe(true);
    now = 40;
    const blocked = rl.hit('t');
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/Daily quota/);
  });

  it('check() does not consume quota; hit() does', () => {
    let now = 0;
    const rl = new RateLimiter(makeConfig({ default: { maxCalls: 1, windowMs: 1000 } }), () => now);
    expect(rl.check('t').allowed).toBe(true);
    expect(rl.check('t').allowed).toBe(true); // still allowed, nothing recorded
    expect(rl.hit('t').allowed).toBe(true);
    expect(rl.hit('t').allowed).toBe(false);
  });

  it('is a no-op when disabled', () => {
    const rl = new RateLimiter(makeConfig({ enabled: false }));
    for (let i = 0; i < 100; i++) expect(rl.hit('t').allowed).toBe(true);
  });

  it('reports usage via snapshot', () => {
    let now = 0;
    const rl = new RateLimiter(makeConfig(), () => now);
    rl.hit('t');
    rl.hit('t');
    const snap = rl.snapshot();
    const entry = snap.find((s) => s.tool === 't');
    expect(entry?.windowCount).toBe(2);
  });
});
