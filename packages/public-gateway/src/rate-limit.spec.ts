import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limit.ts';

describe('RateLimiter', () => {
  const rule = { perSecond: 2, burst: 3 };

  it('allows a burst, then asks to wait until a token refills', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    expect([1, 2, 3].map(() => limiter.take('a', rule))).toEqual([0, 0, 0]);
    expect(limiter.take('a', rule)).toBe(1);
    now = 500; // half a second refills one token at 2/s
    expect(limiter.take('a', rule)).toBe(0);
    expect(limiter.take('a', rule)).toBe(1);
  });

  it('keeps clients apart', () => {
    const limiter = new RateLimiter(() => 0);
    for (let i = 0; i < 3; i++) {
      limiter.take('a', rule);
    }
    expect(limiter.take('a', rule)).toBeGreaterThan(0);
    expect(limiter.take('b', rule)).toBe(0);
  });

  it('is off when perSecond is 0', () => {
    const limiter = new RateLimiter(() => 0);
    for (let i = 0; i < 100; i++) {
      expect(limiter.take('a', { perSecond: 0, burst: 1 })).toBe(0);
    }
    expect(limiter.size).toBe(0);
  });

  it('forgets idle clients', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    limiter.take('old', rule);
    now = 11 * 60 * 1000;
    limiter.take('recent', rule);
    limiter.sweep();
    expect(limiter.size).toBe(1);
  });
});
