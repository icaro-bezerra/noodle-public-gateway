export type RateLimitRule = {
  /** Sustained requests per second; 0 disables the limit */
  perSecond: number;
  /** Requests allowed in a burst above the sustained rate */
  burst: number;
};

type Bucket = { tokens: number; updatedAt: number };

/** Buckets idle this long are full again, so they can be forgotten */
const IDLE_MS = 10 * 60 * 1000;
/** Bound on tracked clients, so a flood of spoofed or rotating addresses cannot exhaust memory */
const MAX_BUCKETS = 100_000;

/**
 * Token buckets keyed by gallery, client and request class. Returns the seconds to wait when a request is over the
 * limit, or 0 when it may go through.
 */
export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  take(key: string, rule: RateLimitRule): number {
    if (rule.perSecond <= 0) {
      return 0;
    }
    const now = this.#now();
    let bucket = this.#buckets.get(key);
    if (bucket) {
      // re-insert so iteration order tracks recency and eviction drops the stalest bucket
      this.#buckets.delete(key);
      bucket.tokens = Math.min(rule.burst, bucket.tokens + ((now - bucket.updatedAt) / 1000) * rule.perSecond);
      bucket.updatedAt = now;
    } else {
      bucket = { tokens: rule.burst, updatedAt: now };
      if (this.#buckets.size >= MAX_BUCKETS) {
        this.#buckets.delete(this.#buckets.keys().next().value!);
      }
    }
    this.#buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - bucket.tokens) / rule.perSecond);
  }

  /** Drops buckets that have refilled completely; call periodically */
  sweep() {
    const cutoff = this.#now() - IDLE_MS;
    for (const [key, bucket] of this.#buckets) {
      if (bucket.updatedAt >= cutoff) {
        // iteration order is recency order, so everything after this is newer
        break;
      }
      this.#buckets.delete(key);
    }
  }

  get size() {
    return this.#buckets.size;
  }
}
