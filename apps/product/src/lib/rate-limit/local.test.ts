import { afterEach, expect, it, vi } from 'vitest';

import { createLocalRateLimiter, LOCAL_RATE_LIMIT_MAX_KEYS } from './local';

afterEach(() => vi.useRealTimers());

it('bounds active keys, preserves exhausted counters, and reclaims expired capacity', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const limiter = createLocalRateLimiter(1, 60_000);
  for (let i = 0; i < LOCAL_RATE_LIMIT_MAX_KEYS; i++) {
    expect((await limiter.limit(`key-${i}`)).success).toBe(true);
  }
  expect((await limiter.limit('new-key')).success).toBe(false);
  expect((await limiter.limit('key-0')).success).toBe(false);
  vi.advanceTimersByTime(60_000);
  expect((await limiter.limit('new-key')).success).toBe(true);
  expect((await limiter.limit('key-0')).success).toBe(true);
});

it('keeps separate limiter budgets independent', async () => {
  const first = createLocalRateLimiter(1, 60_000);
  const second = createLocalRateLimiter(1, 60_000);
  expect((await first.limit('same')).success).toBe(true);
  expect((await first.limit('same')).success).toBe(false);
  expect((await second.limit('same')).success).toBe(true);
});
