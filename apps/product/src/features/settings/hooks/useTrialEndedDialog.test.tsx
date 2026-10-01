import type { BillingAccess } from '@dayopt/billing';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BillingAccessContext } from '@/lib/billing/billing-access-context';
import { useTrialEndedDialog } from './useTrialEndedDialog';

const state = vi.hoisted(() => ({
  billing: { subscriptionStatus: 'free', stripeCustomerId: 'synthetic-customer' } as {
    subscriptionStatus: string;
    stripeCustomerId: string | null;
  },
  dismissed: false,
  mutate: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  api: {
    billing: { getOverview: { useQuery: () => ({ data: { billingInfo: state.billing } }) } },
    userSettings: {
      get: {
        useQuery: () => ({
          data: { personalization: { dismissedTrialEndedDialog: state.dismissed } },
        }),
      },
    },
  },
}));
vi.mock('@/lib/hooks/useUpdateUserSettings', () => ({
  useUpdateUserSettings: () => ({ mutate: state.mutate }),
}));

function renderDialog(access: BillingAccess) {
  return renderHook(() => useTrialEndedDialog(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <BillingAccessContext.Provider value={access}>{children}</BillingAccessContext.Provider>
    ),
  });
}
const legacyAccess: BillingAccess = {
  state: 'not_started',
  canUseProduct: true,
  trialEndsAt: null,
  enforced: false,
};
describe('trial-ended notice ownership', () => {
  beforeEach(() => {
    state.billing = { subscriptionStatus: 'free', stripeCustomerId: 'synthetic-customer' };
    state.dismissed = false;
    state.mutate.mockClear();
  });
  it.each(['not_started', 'trial', 'expired', 'subscribed'] as const)(
    'does not show the legacy Free notice in enforced %s access',
    (accessState) => {
      const { result } = renderDialog({
        state: accessState,
        canUseProduct: accessState === 'trial' || accessState === 'subscribed',
        trialEndsAt: accessState === 'trial' ? '2030-01-01T00:00:00Z' : null,
        enforced: true,
      });
      expect(result.current.open).toBe(false);
      expect(state.mutate).not.toHaveBeenCalled();
    },
  );
  it('keeps the legacy notice and its local/persisted dismissal while enforcement is off', () => {
    const { result } = renderDialog(legacyAccess);
    expect(result.current.open).toBe(true);
    act(() => result.current.close());
    expect(result.current.open).toBe(false);
    expect(state.mutate).toHaveBeenCalledWith({ dismissedTrialEndedDialog: true });
  });
  it.each(['active', 'trialing', 'past_due', 'canceled'])(
    'does not show the legacy notice for %s',
    (subscriptionStatus) => {
      state.billing.subscriptionStatus = subscriptionStatus;
      expect(renderDialog(legacyAccess).result.current.open).toBe(false);
    },
  );
  it('keeps new customers and previously dismissed notices hidden in the legacy flow', () => {
    state.billing.stripeCustomerId = null;
    expect(renderDialog(legacyAccess).result.current.open).toBe(false);
    state.billing.stripeCustomerId = 'synthetic-customer';
    state.dismissed = true;
    expect(renderDialog(legacyAccess).result.current.open).toBe(false);
  });
});
