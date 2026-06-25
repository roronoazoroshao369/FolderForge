import type { RateLimitConfig, RateLimitRule } from '../core/types.js';

export interface RateDecision {
  allowed: boolean;
  /** Reason when blocked (window or daily quota). */
  reason?: string;
  /** Ms until the next call would be permitted by the sliding window. */
  retryAfterMs?: number;
  /** Calls used in the current window. */
  windowCount: number;
  /** Calls used so far today (rolling 24h). */
  dailyCount: number;
}

interface Bucket {
  /** Timestamps (ms) of recent calls within the longest relevant horizon. */
  hits: number[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sliding-window per-tool rate limiter with an optional rolling daily quota.
 *
 * The limiter is intentionally in-memory and per-process: it guards a single
 * running server against runaway agents, not a distributed cluster. Each tool
 * gets its own bucket; the effective rule is `overrides[tool]` falling back to
 * `default`.
 *
 * Call {@link check} to evaluate without recording, or {@link hit} to evaluate
 * and record an accepted call. The registry uses {@link hit} so that denied
 * calls do not consume quota.
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private config: RateLimitConfig,
    private now: () => number = Date.now
  ) {}

  ruleFor(tool: string): RateLimitRule {
    return this.config.overrides[tool] ?? this.config.default;
  }

  /** Evaluate without recording a call. */
  check(tool: string): RateDecision {
    return this.evaluate(tool, false);
  }

  /** Evaluate and, if allowed, record the call against the bucket. */
  hit(tool: string): RateDecision {
    return this.evaluate(tool, true);
  }

  private evaluate(tool: string, record: boolean): RateDecision {
    if (!this.config.enabled) {
      return { allowed: true, windowCount: 0, dailyCount: 0 };
    }
    const rule = this.ruleFor(tool);
    const t = this.now();
    const bucket = this.buckets.get(tool) ?? { hits: [] };

    // Drop anything older than the longest horizon we care about.
    const horizon = Math.max(rule.windowMs, rule.dailyQuota ? DAY_MS : 0);
    bucket.hits = bucket.hits.filter((ts) => t - ts < horizon);

    const windowStart = t - rule.windowMs;
    const windowHits = bucket.hits.filter((ts) => ts >= windowStart);
    const dayHits = rule.dailyQuota ? bucket.hits.filter((ts) => ts >= t - DAY_MS) : [];

    const windowCount = windowHits.length;
    const dailyCount = dayHits.length;

    if (windowCount >= rule.maxCalls) {
      const oldest = windowHits[0] ?? t;
      const retryAfterMs = Math.max(0, oldest + rule.windowMs - t);
      return {
        allowed: false,
        reason: `Rate limit: ${tool} allows ${rule.maxCalls} calls per ${rule.windowMs}ms.`,
        retryAfterMs,
        windowCount,
        dailyCount,
      };
    }

    if (rule.dailyQuota !== undefined && dailyCount >= rule.dailyQuota) {
      const oldest = dayHits[0] ?? t;
      const retryAfterMs = Math.max(0, oldest + DAY_MS - t);
      return {
        allowed: false,
        reason: `Daily quota reached: ${tool} allows ${rule.dailyQuota} calls per 24h.`,
        retryAfterMs,
        windowCount,
        dailyCount,
      };
    }

    if (record) {
      bucket.hits.push(t);
      this.buckets.set(tool, bucket);
      return { allowed: true, windowCount: windowCount + 1, dailyCount: dailyCount + 1 };
    }
    this.buckets.set(tool, bucket);
    return { allowed: true, windowCount, dailyCount };
  }

  /** Snapshot of current usage per tool, for the dashboard and tooling. */
  snapshot(): Array<{ tool: string; windowCount: number; dailyCount: number; rule: RateLimitRule }> {
    const t = this.now();
    const out: Array<{ tool: string; windowCount: number; dailyCount: number; rule: RateLimitRule }> = [];
    for (const [tool, bucket] of this.buckets) {
      const rule = this.ruleFor(tool);
      const windowCount = bucket.hits.filter((ts) => ts >= t - rule.windowMs).length;
      const dailyCount = bucket.hits.filter((ts) => ts >= t - DAY_MS).length;
      out.push({ tool, windowCount, dailyCount, rule });
    }
    return out;
  }

  reset(tool?: string): void {
    if (tool) this.buckets.delete(tool);
    else this.buckets.clear();
  }
}
