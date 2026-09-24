import 'server-only';

import { logger } from '@/lib/logger';

const POSTHOG_PROJECT_ID = '625917';
const POSTHOG_API_HOST = 'https://us.posthog.com';

/** Queue deletion of the account's identified PostHog person and historical events. */
export async function deletePostHogAccountData(input: { userId: string }): Promise<void> {
  const analyticsEnabled =
    process.env.POSTHOG_SERVER_ENABLED === 'true' ||
    process.env.NEXT_PUBLIC_POSTHOG_BROWSER_ENABLED === 'true';
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!analyticsEnabled && !apiKey) return;
  if (!apiKey) throw new Error('PostHog account deletion is enabled without a deletion key');

  try {
    const response = await fetch(
      `${POSTHOG_API_HOST}/api/projects/${POSTHOG_PROJECT_ID}/persons/bulk_delete/`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ distinct_ids: [input.userId], delete_events: true }),
        signal: AbortSignal.timeout(4_000),
      },
    );
    if (!response.ok) throw new Error(`PostHog deletion request returned ${response.status}`);

    const body: unknown = await response.json();
    if (
      body === null ||
      typeof body !== 'object' ||
      !('deletion_errors' in body) ||
      !Array.isArray(body.deletion_errors) ||
      body.deletion_errors.length > 0
    ) {
      throw new Error('PostHog deletion request was not accepted cleanly');
    }
  } catch (error) {
    logger.warn('PostHog account deletion request failed');
    throw new Error('PostHog account deletion request failed', { cause: error });
  }
}
