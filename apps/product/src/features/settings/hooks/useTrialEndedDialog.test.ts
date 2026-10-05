import type { BillingAccess } from '@dayopt/billing';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BillingAccessContext } from '@/lib/billing/billing-access-context';

import { useTrialEndedDialog } from './useTrialEndedDialog';

const queries = vi.hoisted(() => ({
  billingInfo: {
    subscriptionStatus: 'free',
    stripeCustomerId: 'test-checkout-customer' as string | null,
  },
  settings: { personalization: { dismissedTrialEndedDialog: false } } as
    { personalization: { dismissedTrialEndedDialog: boolean } } | null | undefined,
  updateSettings: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  api: {
    billing: { getOverview: { useQuery: () => ({ data: { billingInfo: queries.billingInfo } }) } },
    userSettings: { get: { useQuery: () => ({ data: queries.settings }) } },
  },
}));
vi.mock('@/lib/hooks/useUpdateUserSettings', () => ({
  useUpdateUserSettings: () => ({ mutate: queries.updateSettings }),
}));

let access: BillingAccess;

function Wrapper({ children }: { children: ReactNode }) {
  return createElement(BillingAccessContext.Provider, { value: access }, children);
}

describe('useTrialEndedDialog', () => {
  beforeEach(() => {
    queries.billingInfo.subscriptionStatus = 'free';
    queries.billingInfo.stripeCustomerId = 'test-checkout-customer';
    queries.settings = { personalization: { dismissedTrialEndedDialog: false } };
    queries.updateSettings.mockClear();
    access = {
      state: 'trial',
      canUseProduct: true,
      trialEndsAt: '2026-11-13T02:15:44.579Z',
      enforced: true,
    };
  });

  it('Checkoutを中断してcustomerが残っても有効な体験中は終了案内を出さない', () => {
    const { result } = renderHook(() => useTrialEndedDialog(), { wrapper: Wrapper });

    expect(result.current.open).toBe(false);
    expect(queries.updateSettings).not.toHaveBeenCalled();
  });

  it.each(['not_started', 'trial', 'expired', 'subscribed'] as const)(
    '単一有料プランの%sでは旧ダイアログを表示しない',
    (state) => {
      access = { ...access, state };
      const { result } = renderHook(() => useTrialEndedDialog(), { wrapper: Wrapper });
      expect(result.current.open).toBe(false);
      expect(queries.updateSettings).not.toHaveBeenCalled();
    },
  );

  it('旧方式はcustomerがなければ表示しない', () => {
    access = { ...access, enforced: false };
    queries.billingInfo.stripeCustomerId = null;
    const { result } = renderHook(() => useTrialEndedDialog(), { wrapper: Wrapper });
    expect(result.current.open).toBe(false);
  });

  it('旧方式は設定取得後だけ表示する', () => {
    access = { ...access, enforced: false };
    queries.settings = undefined;
    const { result, rerender } = renderHook(() => useTrialEndedDialog(), { wrapper: Wrapper });
    expect(result.current.open).toBe(false);
    queries.settings = { personalization: { dismissedTrialEndedDialog: false } };
    rerender();
    expect(result.current.open).toBe(true);
  });

  it('旧方式も保存済みdismissを尊重する', () => {
    access = { ...access, enforced: false };
    queries.settings = { personalization: { dismissedTrialEndedDialog: true } };
    const { result } = renderHook(() => useTrialEndedDialog(), { wrapper: Wrapper });
    expect(result.current.open).toBe(false);
  });

  it('旧方式のcloseは保存完了前から閉じる', () => {
    access = { ...access, enforced: false };
    const { result, rerender } = renderHook(() => useTrialEndedDialog(), { wrapper: Wrapper });
    expect(result.current.open).toBe(true);
    act(() => result.current.close());
    rerender();
    expect(result.current.open).toBe(false);
    expect(queries.updateSettings).toHaveBeenCalledExactlyOnceWith({
      dismissedTrialEndedDialog: true,
    });
  });
});
