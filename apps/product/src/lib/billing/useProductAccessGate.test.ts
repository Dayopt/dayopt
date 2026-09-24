import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProductAccessGate } from './useProductAccessGate';

const access = vi.hoisted(() => ({ canUseProduct: true }));
const openSettings = vi.hoisted(() => vi.fn());

vi.mock('@/lib/billing/billing-access-context', () => ({
  useBillingAccess: () => ({
    state: access.canUseProduct ? 'trial' : 'expired',
    canUseProduct: access.canUseProduct,
    trialEndsAt: null,
    enforced: true,
  }),
}));
vi.mock('@/lib/stores/useShellStore', () => ({
  useShellStore: { use: { openSettings: () => openSettings } },
}));

describe('useProductAccessGate', () => {
  beforeEach(() => {
    access.canUseProduct = true;
    openSettings.mockClear();
  });

  it('利用権があれば操作をそのまま実行する', () => {
    const run = vi.fn();
    const { result } = renderHook(() => useProductAccessGate());

    result.current(run);

    expect(run).toHaveBeenCalledOnce();
    expect(openSettings).not.toHaveBeenCalled();
  });

  it('利用権が無ければ操作を送らず課金設定を開く', () => {
    access.canUseProduct = false;
    const run = vi.fn();
    const { result } = renderHook(() => useProductAccessGate());

    result.current(run);

    expect(run).not.toHaveBeenCalled();
    expect(openSettings).toHaveBeenCalledWith('billing');
  });
});
