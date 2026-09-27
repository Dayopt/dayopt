import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deletePostHogAccountData } from './posthog-deletion';

describe('PostHog account data deletion', () => {
  beforeEach(() => {
    vi.stubEnv('POSTHOG_SERVER_ENABLED', 'false');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_BROWSER_ENABLED', 'false');
    vi.stubEnv('POSTHOG_PERSONAL_API_KEY', '');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('does not call PostHog when analytics is disabled', async () => {
    await expect(
      deletePostHogAccountData({ userId: '00000000-0000-4000-8000-000000000001' }),
    ).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when analytics is enabled without the deletion key', async () => {
    vi.stubEnv('POSTHOG_SERVER_ENABLED', 'true');
    await expect(
      deletePostHogAccountData({ userId: '00000000-0000-4000-8000-000000000001' }),
    ).rejects.toThrow('PostHog account deletion is enabled without a deletion key');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still deletes historical analytics after new capture has been disabled', async () => {
    vi.stubEnv('POSTHOG_PERSONAL_API_KEY', 'phx_secret');
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ deletion_errors: [] }), { status: 202 }),
    );

    await deletePostHogAccountData({ userId: '00000000-0000-4000-8000-000000000001' });

    expect(fetch).toHaveBeenCalledOnce();
  });

  it('requests person and event deletion for only the account distinct ID', async () => {
    vi.stubEnv('POSTHOG_SERVER_ENABLED', 'true');
    vi.stubEnv('POSTHOG_PERSONAL_API_KEY', 'phx_secret');
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ deletion_errors: [], events_queued_for_deletion: true }), {
        status: 202,
      }),
    );

    await deletePostHogAccountData({ userId: '00000000-0000-4000-8000-000000000001' });

    expect(fetch).toHaveBeenCalledWith(
      'https://us.posthog.com/api/projects/625917/persons/bulk_delete/',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer phx_secret' }),
        body: JSON.stringify({
          distinct_ids: ['00000000-0000-4000-8000-000000000001'],
          delete_events: true,
        }),
      }),
    );
  });

  it('fails the account deletion step if PostHog rejects the request', async () => {
    vi.stubEnv('POSTHOG_SERVER_ENABLED', 'true');
    vi.stubEnv('POSTHOG_PERSONAL_API_KEY', 'phx_secret');
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(
      deletePostHogAccountData({ userId: '00000000-0000-4000-8000-000000000001' }),
    ).rejects.toThrow('PostHog account deletion request failed');
  });
});
