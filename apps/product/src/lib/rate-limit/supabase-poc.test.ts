import { describe, expect, it, vi } from 'vitest';

import {
  PRODUCT_INTEGRATION_APP_ORIGIN,
  PRODUCT_INTEGRATION_SUPABASE_REF,
  PRODUCT_VERCEL_PROJECT_ID,
} from '@/lib/dayopt-environment';

import {
  checkSupabaseRateLimitPoc,
  claimSupabaseWebhookEventPoc,
  completeSupabaseWebhookEventPoc,
  isSupabaseRateLimitPocEnabled,
  isSupabaseWebhookClaimPocEnabled,
  releaseSupabaseWebhookEventPoc,
  SupabaseRateLimitPocUnavailableError,
  SupabaseWebhookClaimPocUnavailableError,
  type SupabaseRateLimitPocClient,
} from './supabase-poc';

function clientWith(
  data: unknown,
  error: unknown | null = null,
): SupabaseRateLimitPocClient & {
  rpc: ReturnType<typeof vi.fn>;
} {
  return { rpc: vi.fn().mockResolvedValue({ data, error }) };
}

const DIGEST = 'a'.repeat(64);
const TOKEN = '00000001-0000-4000-8000-000000000001';
const FIXED_INTEGRATION_ENV = {
  DAYOPT_ENVIRONMENT: 'integration',
  NEXT_PUBLIC_DAYOPT_ENVIRONMENT: 'integration',
  VERCEL_ENV: 'preview',
  VERCEL_TARGET_ENV: 'preview',
  VERCEL_PROJECT_ID: PRODUCT_VERCEL_PROJECT_ID,
  VERCEL_GIT_COMMIT_REF: 'integration',
  VERCEL_BRANCH_URL: PRODUCT_INTEGRATION_APP_ORIGIN.slice('https://'.length),
  NEXT_PUBLIC_APP_URL: PRODUCT_INTEGRATION_APP_ORIGIN,
  NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCT_INTEGRATION_SUPABASE_REF}.supabase.co`,
};

describe('Supabase POC deployment switches', () => {
  it('enables Calendar rate limiting only with its own switch on fixed Integration', () => {
    expect(
      isSupabaseRateLimitPocEnabled({
        ...FIXED_INTEGRATION_ENV,
        SUPABASE_RATE_LIMIT_POC_ENABLED: 'true',
      }),
    ).toBe(true);
    expect(
      isSupabaseRateLimitPocEnabled({
        ...FIXED_INTEGRATION_ENV,
        SUPABASE_WEBHOOK_CLAIM_POC_ENABLED: 'true',
      }),
    ).toBe(false);
    expect(
      isSupabaseRateLimitPocEnabled({
        ...FIXED_INTEGRATION_ENV,
        SUPABASE_RATE_LIMIT_POC_ENABLED: 'true',
        VERCEL_GIT_COMMIT_REF: 'feature-branch',
      }),
    ).toBe(false);
  });

  it('enables webhook claims independently and never in Production', () => {
    expect(
      isSupabaseWebhookClaimPocEnabled({
        ...FIXED_INTEGRATION_ENV,
        SUPABASE_WEBHOOK_CLAIM_POC_ENABLED: 'true',
      }),
    ).toBe(true);
    expect(
      isSupabaseWebhookClaimPocEnabled({
        ...FIXED_INTEGRATION_ENV,
        SUPABASE_RATE_LIMIT_POC_ENABLED: 'true',
      }),
    ).toBe(false);
    expect(
      isSupabaseWebhookClaimPocEnabled({
        ...FIXED_INTEGRATION_ENV,
        SUPABASE_WEBHOOK_CLAIM_POC_ENABLED: 'true',
        DAYOPT_ENVIRONMENT: 'production',
        NEXT_PUBLIC_DAYOPT_ENVIRONMENT: 'production',
        VERCEL_ENV: 'production',
        VERCEL_TARGET_ENV: 'production',
        VERCEL_GIT_COMMIT_REF: 'main',
        VERCEL_BRANCH_URL: undefined,
        NEXT_PUBLIC_APP_URL: 'https://app.dayopt.app',
        NEXT_PUBLIC_SUPABASE_URL: 'https://yvglwblxrnrenfifsnje.supabase.co',
      }),
    ).toBe(false);
  });
});

describe('Supabase rate-limit POC adapter', () => {
  it('passes only the digest and fixed budget parameters to the atomic RPC', async () => {
    const resetAt = '2026-10-03T00:01:00.000Z';
    const client = clientWith({
      allowed: false,
      remaining: 0,
      estimated_count: 7,
      reset_at: resetAt,
      retry_after_seconds: 30,
    });

    await expect(
      checkSupabaseRateLimitPoc(client, {
        scope: 'calendar-sync-now',
        identifierHash: DIGEST,
        limitCount: 6,
        windowSeconds: 3600,
      }),
    ).resolves.toEqual({
      allowed: false,
      remaining: 0,
      estimatedCount: 7,
      resetAt: new Date(resetAt),
      retryAfterSeconds: 30,
    });
    expect(client.rpc).toHaveBeenCalledWith('check_supabase_rate_limit_poc', {
      p_scope: 'calendar-sync-now',
      p_identifier_hash: DIGEST,
      p_limit_count: 6,
      p_window_seconds: 3600,
    });
  });

  it('fails closed on database errors, transport errors, and malformed replies', async () => {
    const rpcError = clientWith(null, { message: 'private database detail' });
    await expect(
      checkSupabaseRateLimitPoc(rpcError, {
        scope: 'calendar-sync-now',
        identifierHash: DIGEST,
        limitCount: 6,
        windowSeconds: 3600,
      }),
    ).rejects.toBeInstanceOf(SupabaseRateLimitPocUnavailableError);

    const transportError = { rpc: vi.fn().mockRejectedValue(new Error('network detail')) };
    await expect(
      checkSupabaseRateLimitPoc(transportError, {
        scope: 'calendar-sync-now',
        identifierHash: DIGEST,
        limitCount: 6,
        windowSeconds: 3600,
      }),
    ).rejects.toThrow('Supabase rate-limit service is unavailable');

    await expect(
      checkSupabaseRateLimitPoc(clientWith({ allowed: true }), {
        scope: 'calendar-sync-now',
        identifierHash: DIGEST,
        limitCount: 6,
        windowSeconds: 3600,
      }),
    ).rejects.toBeInstanceOf(SupabaseRateLimitPocUnavailableError);
  });

  it('does not send raw identifiers to the database', async () => {
    const client = clientWith({
      allowed: true,
      remaining: 5,
      estimated_count: 1,
      reset_at: '2026-10-03T00:01:00.000Z',
      retry_after_seconds: 0,
    });
    await expect(
      checkSupabaseRateLimitPoc(client, {
        scope: 'calendar-sync-now',
        identifierHash: 'raw-user-id',
        limitCount: 6,
        windowSeconds: 3600,
      }),
    ).rejects.toThrow(TypeError);
    expect(client.rpc).not.toHaveBeenCalled();
  });
});

describe('Supabase webhook claim POC adapter', () => {
  it('maps claim states and propagates the ownership token to completion/release', async () => {
    const client = clientWith('claimed');
    await expect(claimSupabaseWebhookEventPoc(client, DIGEST, TOKEN)).resolves.toBe('claimed');
    expect(client.rpc).toHaveBeenCalledWith('claim_supabase_webhook_event_poc', {
      p_event_hash: DIGEST,
      p_processing_token: TOKEN,
    });

    client.rpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(completeSupabaseWebhookEventPoc(client, DIGEST, TOKEN)).resolves.toBe(true);
    client.rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(releaseSupabaseWebhookEventPoc(client, DIGEST, TOKEN)).resolves.toBe(false);
  });

  it('fails closed when claim RPC is unavailable or returns an unknown state', async () => {
    await expect(
      claimSupabaseWebhookEventPoc(clientWith(null, new Error('private detail')), DIGEST, TOKEN),
    ).rejects.toBeInstanceOf(SupabaseWebhookClaimPocUnavailableError);
    await expect(
      claimSupabaseWebhookEventPoc(clientWith('unknown'), DIGEST, TOKEN),
    ).rejects.toBeInstanceOf(SupabaseWebhookClaimPocUnavailableError);
  });
});
