'use client';

import type { BillingAccess } from '@dayopt/billing';
import { createContext, useContext } from 'react';

export const BillingAccessContext = createContext<BillingAccess>({
  state: 'not_started',
  canUseProduct: true,
  trialEndsAt: null,
  enforced: false,
});

export function useBillingAccess(): BillingAccess {
  return useContext(BillingAccessContext);
}
