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

  it('Stripe customerがなくても本当の期限終了を案内する', () => {
    access = { ...access, state: 'expired', canUseProduct: false };
    queries.billingInfo.stripeCustomerId = null;
    const { result } = renderHook(() => useTrialEndedDialog(), { wrapper: Wrapper });

    expect(result.current.open).toBe(true);
  });

  it.each(['not_started', 'trial', 'subscribed'] as const)('%sでは終了案内を出さない', (state) => {
    access = { ...access, state };
    const { result } = renderHook(() => useTrialEndedDialog(), { wrapper: Wrapper });

    expect(result.current.open).toBe(false);
  });

  it('課金制御OFFでは期限終了の状態でも案内を出さない', () => {
    access = { ...access, state: 'expired', canUseProduct: true, enforced: false };
    const { result } = renderHook(() => useTrialEndedDialog(), { wrapper: Wrapper });

    expect(result.current.open).toBe(false);
  });

  it('設定の取得が完了してから未dismissの期限終了を案内する', () => {
    access = { ...access, state: 'expired', canUseProduct: false };
    queries.settings = undefined;
    const { result, rerender } = renderHook(() => useTrialEndedDialog(), { wrapper: Wrapper });
    expect(result.current.open).toBe(false);

    queries.settings = { personalization: { dismissedTrialEndedDialog: false } };
    rerender();

    expect(result.current.open).toBe(true);
  });

  it('設定行がない場合も未dismissとして本当の期限終了を案内する', () => {
    access = { ...access, state: 'expired', canUseProduct: false };
    queries.settings = null;
    const { result } = renderHook(() => useTrialEndedDialog(), { wrapper: Wrapper });

    expect(result.current.open).toBe(true);
  });

  it('保存済みのdismissで案内を出さない', () => {
    access = { ...access, state: 'expired', canUseProduct: false };
    queries.settings = { personalization: { dismissedTrialEndedDialog: true } };
    const { result } = renderHook(() => useTrialEndedDialog(), { wrapper: Wrapper });

    expect(result.current.open).toBe(false);
  });

  it('closeで直ちに閉じてflagを保存し、保存完了前の再描画でも閉じたままにする', () => {
    access = { ...access, state: 'expired', canUseProduct: false };
    const { result, rerender } = renderHook(() => useTrialEndedDialog(), { wrapper: Wrapper });
    expect(result.current.open).toBe(true);

    act(() => result.current.close());
    rerender();

    expect(result.current.open).toBe(false);
    expect(queries.updateSettings).toHaveBeenCalledExactlyOnceWith({
      dismissedTrialEndedDialog: true,
    });
    expect(queries.settings?.personalization.dismissedTrialEndedDialog).toBe(false);
  });

  it('利用権のtrialからexpiredへの変化で開き、購入完了のsubscribedで閉じる', () => {
    const { result, rerender } = renderHook(() => useTrialEndedDialog(), { wrapper: Wrapper });
    expect(result.current.open).toBe(false);

    access = { ...access, state: 'expired', canUseProduct: false };
    rerender();
    expect(result.current.open).toBe(true);

    access = { ...access, state: 'subscribed', canUseProduct: true };
    rerender();
    expect(result.current.open).toBe(false);
  });

  it('有効な体験中に読み取り失敗で一時拒否されても終了と誤判定しない', () => {
    access = { ...access, canUseProduct: false };
    const { result } = renderHook(() => useTrialEndedDialog(), { wrapper: Wrapper });

    expect(result.current.open).toBe(false);
  });
});
