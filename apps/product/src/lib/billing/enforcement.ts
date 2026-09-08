import 'server-only';

import type { Database } from '@/lib/database';
import type { EntitlementKey } from '@dayopt/billing';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getBillingAccess } from './access-service';
export { isBillingEnforced } from './enforcement-flag';

/** Compatibility adapter: every former feature key now means active product access. */
export async function checkEntitlementForUser(
  supabase: SupabaseClient<Database>,
  userId: string,
  _key: EntitlementKey,
): Promise<'allowed' | 'denied' | 'lookup_failed'> {
  try {
    return (await getBillingAccess(supabase, userId)).canUseProduct ? 'allowed' : 'denied';
  } catch {
    // getBillingAccess captures the database error; isolate failure to this user.
    return 'lookup_failed';
  }
}
