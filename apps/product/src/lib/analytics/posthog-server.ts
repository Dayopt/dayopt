import 'server-only';

import { createHash } from 'node:crypto';
import { PostHog } from 'posthog-node';

import { logger } from '@/lib/logger';
import { createServiceRoleClient } from '@/lib/supabase/oauth';

type PostHogServerEventName =
  | 'plan_created'
  | 'record_created'
  | 'plan_updated'
  | 'record_updated'
  | 'review_opened'
  | 'app_trial_started'
  | 'first_payment_succeeded';

type AnalyticsSource = 'manual' | 'external_calendar' | 'confirm_day' | 'plan_recording';

interface PostHogServerEvent {
  eventName: PostHogServerEventName;
  userId: string;
  sourceId: string;
  occurredAt?: string;
  source?: AnalyticsSource;
  count?: number;
}

/** The same successful operation always gets the same PostHog event UUID. */
export function postHogEventId(eventName: PostHogServerEventName, sourceId: string): string {
  const hex = createHash('sha256')
    .update(`dayopt:posthog:v1:${eventName}:${sourceId}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function eventEnvironment(): 'production' | 'preview' | 'development' {
  if (process.env.VERCEL_ENV === 'production') return 'production';
  if (process.env.VERCEL_ENV === 'preview') return 'preview';
  return 'development';
}

/** Optional and best-effort: analytics failures must never fail a Product write or Stripe webhook. */
export async function trackPostHogServerEvent(input: PostHogServerEvent): Promise<void> {
  const projectKey = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_KEY;
  if (process.env.POSTHOG_SERVER_ENABLED !== 'true' || !projectKey) return;

  try {
    const { data, error } = await createServiceRoleClient()
      .from('profiles')
      .select('analytics_consent')
      .eq('id', input.userId)
      .abortSignal(AbortSignal.timeout(1_000))
      .single();

    if (error || data?.analytics_consent !== true) {
      if (error) logger.warn('PostHog consent lookup failed', { eventName: input.eventName });
      return;
    }

    const client = new PostHog(projectKey, {
      host: 'https://us.i.posthog.com',
      disableGeoip: true,
      enableExceptionAutocapture: false,
      requestTimeout: 1_000,
      fetchRetryCount: 0,
    });
    await client.captureImmediate({
      distinctId: input.userId,
      event: input.eventName,
      uuid: postHogEventId(input.eventName, input.sourceId),
      ...(input.occurredAt ? { timestamp: new Date(input.occurredAt) } : {}),
      properties: {
        environment: eventEnvironment(),
        surface: 'product',
        schema_version: 1,
        ...(input.source ? { source: input.source } : {}),
        ...(input.count !== undefined ? { count: input.count } : {}),
      },
    });
  } catch {
    logger.warn('PostHog event delivery failed', { eventName: input.eventName });
  }
}
