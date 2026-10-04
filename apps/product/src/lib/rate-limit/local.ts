/** Preview-only fixed windows. State is per instance and resets on restart. */
export const LOCAL_RATE_LIMIT_MAX_KEYS = 10_000;

export function createLocalRateLimiter(requests: number, windowMs: number) {
  const buckets = new Map<string, { count: number; reset: number }>();
  return {
    async limit(identifier: string) {
      const now = Date.now();
      let bucket = buckets.get(identifier);
      if (!bucket || bucket.reset <= now) {
        if (buckets.size >= LOCAL_RATE_LIMIT_MAX_KEYS) {
          for (const [key, value] of buckets) {
            if (value.reset <= now) buckets.delete(key);
          }
        }
        // Do not evict active counters: rotating identifiers must not bypass limits.
        if (!bucket && buckets.size >= LOCAL_RATE_LIMIT_MAX_KEYS) {
          return {
            success: false,
            limit: requests,
            remaining: 0,
            reset: now + windowMs,
            pending: Promise.resolve(),
          };
        }
        bucket = { count: 0, reset: now + windowMs };
        buckets.set(identifier, bucket);
      }
      const success = bucket.count < requests;
      if (success) bucket.count++;
      return {
        success,
        limit: requests,
        remaining: Math.max(0, requests - bucket.count),
        reset: bucket.reset,
        pending: Promise.resolve(),
      };
    },
  };
}
