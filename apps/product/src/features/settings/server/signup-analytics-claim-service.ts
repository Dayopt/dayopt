import 'server-only';

import {
  verifySignupAnalyticsClaim,
  type SignupAnalyticsMethod,
} from '@/lib/analytics/signup-analytics-claim';
import { logger } from '@/lib/logger';
import { createServiceRoleClient } from '@/lib/supabase/oauth';

/** Consumes an authenticated signup marker once, after checking its server signature. */
export class SignupAnalyticsClaimService {
  async claim(userId: string, token: string): Promise<SignupAnalyticsMethod | null> {
    const claim = verifySignupAnalyticsClaim(token, userId);
    if (!claim) return null;

    try {
      const request = createServiceRoleClient().rpc('claim_posthog_signup_v1', {
        p_user_id: userId,
      });
      const { data, error } = await request.abortSignal(AbortSignal.timeout(1_000));
      if (error) {
        logger.warn('PostHog signup claim failed');
        return null;
      }
      return data === true ? claim.method : null;
    } catch {
      logger.warn('PostHog signup claim unavailable');
      return null;
    }
  }
}
