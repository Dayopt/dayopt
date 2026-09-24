import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captureImmediate = vi.hoisted(() => vi.fn());
const createServiceRoleClient = vi.hoisted(() => vi.fn());

vi.mock('posthog-node', () => ({
  PostHog: vi.fn().mockImplementation(function MockPostHog() {
    return { captureImmediate };
  }),
}));
vi.mock('@/lib/supabase/oauth', () => ({ createServiceRoleClient }));

import { postHogEventId, trackPostHogServerEvent } from './posthog-server';

function consentQuery(allowed: boolean | null, error: object | null = null) {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    abortSignal: vi.fn().mockReturnThis(),
    single: vi
      .fn()
      .mockResolvedValue({ data: allowed === null ? null : { analytics_consent: allowed }, error }),
  };
  createServiceRoleClient.mockReturnValue({ from: vi.fn(() => query) });
  return query;
}

describe('PostHog server analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('POSTHOG_SERVER_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_KEY', 'phc_test');
    captureImmediate.mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('stays disabled without an explicit runtime switch', async () => {
    vi.stubEnv('POSTHOG_SERVER_ENABLED', 'false');
    await trackPostHogServerEvent({
      eventName: 'plan_created',
      userId: 'user-1',
      sourceId: 'plan-1',
    });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(captureImmediate).not.toHaveBeenCalled();
  });

  it('does not send after refusal, revocation, or a failed consent lookup', async () => {
    consentQuery(false);
    await trackPostHogServerEvent({
      eventName: 'plan_created',
      userId: 'user-1',
      sourceId: 'plan-1',
    });
    consentQuery(null, { code: 'PGRST000' });
    await trackPostHogServerEvent({
      eventName: 'plan_created',
      userId: 'user-1',
      sourceId: 'plan-1',
    });
    expect(captureImmediate).not.toHaveBeenCalled();
  });

  it('sends only fixed properties and a stable retry ID when account consent is current', async () => {
    const query = consentQuery(true);
    await trackPostHogServerEvent({
      eventName: 'record_created',
      userId: 'user-1',
      sourceId: 'record-1',
      source: 'manual',
      count: 1,
    });
    expect(query.eq).toHaveBeenCalledWith('id', 'user-1');
    expect(captureImmediate).toHaveBeenCalledWith({
      distinctId: 'user-1',
      event: 'record_created',
      uuid: postHogEventId('record_created', 'record-1'),
      properties: {
        environment: 'development',
        surface: 'product',
        schema_version: 1,
        source: 'manual',
        count: 1,
      },
    });
    expect(postHogEventId('record_created', 'record-1')).toBe(
      postHogEventId('record_created', 'record-1'),
    );
  });

  it('never fails the Product write if delivery fails', async () => {
    consentQuery(true);
    captureImmediate.mockRejectedValue(new Error('network'));
    await expect(
      trackPostHogServerEvent({
        eventName: 'plan_updated',
        userId: 'user-1',
        sourceId: 'plan-1:v2',
      }),
    ).resolves.toBeUndefined();
  });
});
