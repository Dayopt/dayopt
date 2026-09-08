import { env } from '@/env';
import 'server-only';

export function isBillingEnforced(): boolean {
  return env.BILLING_ENFORCED === 'true';
}
