import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/database';
import { captureUnexpectedDatabaseError } from '@/lib/sentry';
import { ServiceError } from '@/lib/trpc/errors';

interface AccountAnalyticsConsent {
  allowed: boolean;
  updatedAt: string | null;
}

/** Only the authenticated user's profile may be read or changed. */
export class AnalyticsConsentService {
  constructor(private readonly supabase: SupabaseClient<Database>) {}

  async get(userId: string): Promise<AccountAnalyticsConsent> {
    const { data, error } = await this.supabase
      .from('profiles')
      .select('analytics_consent, analytics_consent_updated_at')
      .eq('id', userId)
      .single();

    if (error || !data) {
      if (error)
        captureUnexpectedDatabaseError(error, {
          feature: 'settings',
          operation: 'get_analytics_consent',
        });
      throw new ServiceError('FETCH_FAILED', 'Failed to read analytics consent');
    }

    return { allowed: data.analytics_consent, updatedAt: data.analytics_consent_updated_at };
  }

  async set(userId: string, allowed: boolean): Promise<AccountAnalyticsConsent> {
    const { data, error } = await this.supabase
      .from('profiles')
      .update({
        analytics_consent: allowed,
        analytics_consent_updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select('analytics_consent, analytics_consent_updated_at')
      .single();

    if (error || !data || data.analytics_consent !== allowed) {
      if (error)
        captureUnexpectedDatabaseError(error, {
          feature: 'settings',
          operation: 'set_analytics_consent',
        });
      throw new ServiceError('UPDATE_FAILED', 'Failed to save analytics consent');
    }

    return { allowed: data.analytics_consent, updatedAt: data.analytics_consent_updated_at };
  }
}
