import { describe, expect, it, vi } from 'vitest';

import { createChainableMock } from '@/lib/test/trpc-test-helpers';
import { AnalyticsConsentService } from './analytics-consent-service';

const USER_ID = '09f71067-0838-4e9f-a05d-d729bc876281';

describe('AnalyticsConsentService', () => {
  it('reads only the authenticated account decision', async () => {
    const query = createChainableMock({
      analytics_consent: true,
      analytics_consent_updated_at: '2026-09-24T00:00:00Z',
    });
    const from = vi.fn(() => query);
    const service = new AnalyticsConsentService({ from } as never);

    await expect(service.get(USER_ID)).resolves.toEqual({
      allowed: true,
      updatedAt: '2026-09-24T00:00:00Z',
    });
    expect(from).toHaveBeenCalledWith('profiles');
    expect(query.eq).toHaveBeenCalledWith('id', USER_ID);
  });

  it('requires a confirmed write when revoking server consent', async () => {
    const query = createChainableMock({
      analytics_consent: false,
      analytics_consent_updated_at: '2026-09-24T00:00:00Z',
    });
    const service = new AnalyticsConsentService({ from: vi.fn(() => query) } as never);

    await expect(service.set(USER_ID, false)).resolves.toMatchObject({ allowed: false });
    expect(query.update).toHaveBeenCalledWith({
      analytics_consent: false,
      analytics_consent_updated_at: expect.any(String),
    });
    expect(query.eq).toHaveBeenCalledWith('id', USER_ID);
  });

  it('fails closed when the account row is unavailable', async () => {
    const query = createChainableMock(null);
    const service = new AnalyticsConsentService({ from: vi.fn(() => query) } as never);

    await expect(service.get(USER_ID)).rejects.toMatchObject({ code: 'FETCH_FAILED' });
    await expect(service.set(USER_ID, true)).rejects.toMatchObject({ code: 'UPDATE_FAILED' });
  });
});
