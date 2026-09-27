import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSignupAnalyticsClaim, verifySignupAnalyticsClaim } from './signup-analytics-claim';

const USER_ID = '09f71067-0838-4e9f-a05d-d729bc876281';
const NOW = Date.parse('2026-09-24T00:00:00.000Z');

describe('signed PostHog signup claim', () => {
  beforeEach(() => {
    vi.stubEnv('SUPABASE_SECRET_KEY', 'server-only-secret');
  });

  it('verifies a short-lived claim for the account that completed signup', () => {
    const token = createSignupAnalyticsClaim(USER_ID, 'google', NOW);

    expect(token).toBeTruthy();
    expect(verifySignupAnalyticsClaim(token ?? '', USER_ID, NOW + 1_000)).toEqual({
      method: 'google',
    });
  });

  it('rejects a forged, cross-account, or expired claim', () => {
    const token = createSignupAnalyticsClaim(USER_ID, 'email', NOW) ?? '';

    expect(verifySignupAnalyticsClaim(`${token}x`, USER_ID, NOW)).toBeNull();
    expect(verifySignupAnalyticsClaim(token, 'other-user', NOW)).toBeNull();
    expect(verifySignupAnalyticsClaim(token, USER_ID, NOW + 1_000 * 60 * 11)).toBeNull();
  });
});
