import { beforeEach, describe, expect, it, vi } from 'vitest';

const abortSignal = vi.hoisted(() => vi.fn());
const insert = vi.hoisted(() => vi.fn(() => ({ abortSignal })));
const from = vi.hoisted(() => vi.fn(() => ({ insert })));
const createServiceRoleClient = vi.hoisted(() => vi.fn(() => ({ from })));
const warn = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/oauth', () => ({ createServiceRoleClient }));
vi.mock('@/lib/logger', () => ({ logger: { warn } }));

import {
  isProductEventName,
  PRODUCT_EVENT_NAMES,
  trackProductEvent,
  trackProductEvents,
} from './product-events';

describe('product events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    abortSignal.mockResolvedValue({ data: null, error: null });
  });

  it('accepts only the allowlisted event names', () => {
    expect(PRODUCT_EVENT_NAMES).toEqual([
      'user_signed_up',
      'plan_created',
      'record_created',
      'review_opened',
      'checkout_started',
      'subscription_started',
      'app_trial_started',
      'subscription_payment_succeeded',
      'subscription_renewal_succeeded',
      'subscription_ended',
    ]);
    expect(PRODUCT_EVENT_NAMES.every(isProductEventName)).toBe(true);
    expect(isProductEventName('entry_created')).toBe(false);
  });

  it('always inserts an empty properties object and uses a one-second timeout', async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);

    await trackProductEvent({ eventName: 'plan_created', userId: 'user-1' });

    expect(from).toHaveBeenCalledWith('product_events');
    expect(insert).toHaveBeenCalledWith([
      { event_name: 'plan_created', properties: {}, user_id: 'user-1' },
    ]);
    expect(timeout).toHaveBeenCalledWith(1_000);
    expect(abortSignal).toHaveBeenCalledWith(signal);

    timeout.mockRestore();
  });

  it('inserts a batch in one query', async () => {
    await trackProductEvents([
      { eventName: 'record_created', userId: 'user-1' },
      { eventName: 'record_created', userId: 'user-1' },
    ]);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith([
      { event_name: 'record_created', properties: {}, user_id: 'user-1' },
      { event_name: 'record_created', properties: {}, user_id: 'user-1' },
    ]);
  });

  it('swallows client creation, timeout, and query errors without logging user data', async () => {
    createServiceRoleClient.mockImplementationOnce(() => {
      throw new Error('secret and user-1 must not escape');
    });
    await expect(
      trackProductEvent({ eventName: 'review_opened', userId: 'user-1' }),
    ).resolves.toBeUndefined();

    abortSignal.mockResolvedValueOnce({ data: null, error: new Error('db payload') });
    await expect(
      trackProductEvent({ eventName: 'checkout_started', userId: 'user-2' }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('user-1');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('user-2');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('db payload');
  });

  it('rejects an invalid runtime name without attempting a query', async () => {
    await trackProductEvent({
      eventName: 'entry_created' as 'plan_created',
      userId: 'user-1',
    });

    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('Product analytics event rejected', { eventCount: 1 });
  });
});
