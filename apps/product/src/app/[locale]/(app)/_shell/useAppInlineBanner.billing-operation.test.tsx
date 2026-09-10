vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (select: (state: { timezone: string }) => unknown) =>
    select({ timezone: 'Asia/Tokyo' }),
}));
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OPERATION_ID = '00000000-0000-4000-8000-000000000001';
const beginPortalAttempt = vi.hoisted(() => vi.fn(() => OPERATION_ID));
const portalMutate = vi.hoisted(() => vi.fn());
const settlePortalAttempt = vi.hoisted(() => vi.fn(() => true));
const toastError = vi.hoisted(() => vi.fn());
const reportBillingReturnPollTimeout = vi.hoisted(() => vi.fn());
const stopBillingPoll = vi.hoisted(() => vi.fn());
const pollStartedAt = vi.hoisted(() => ({ current: null }) as { current: number | null });
const billingOverview = vi.hoisted(
  () =>
    ({
      current: { billingInfo: { subscriptionStatus: 'past_due' } },
    }) as {
      current: { billingInfo: { subscriptionStatus: string | null } };
    },
);
const mutationOptions = vi.hoisted(
  () =>
    ({ current: null }) as {
      current: null | {
        onError: (error: unknown, variables: { operationId: string }) => void;
        onSuccess: (data: { url: string }, variables: { operationId: string }) => void;
      };
    },
);

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: toastError },
}));

vi.mock('@/features/settings', async () => ({
  // 課金 checkout 復帰の有限ポーリング（issue #1887）。この test では復帰を
  // 起こさないため startedAt は常に null（= ポーリング非アクティブ）。
  // 分岐そのものは再実装せず実物を使う。ここで写すと分岐の変化を test が追えない（#1937）。
  ...(await vi.importActual<typeof import('@/features/settings')>('@/features/settings')),
  reportBillingReturnPollTimeout,
  useBillingPollStore: {
    use: {
      startedAt: () => pollStartedAt.current,
      stop: () => stopBillingPoll,
    },
  },
  useStableBillingOperation: () => ({
    begin: beginPortalAttempt,
    isLocked: false,
    settle: settlePortalAttempt,
  }),
}));

vi.mock('@/lib/trpc', () => ({
  api: {
    useUtils: () => ({ billing: { getAccess: { invalidate: vi.fn() } } }),
    billing: {
      createPortalSession: {
        useMutation: (options: NonNullable<typeof mutationOptions.current>) => {
          mutationOptions.current = options;
          return { isPending: false, mutate: portalMutate };
        },
      },
      getOverview: {
        useQuery: () => ({
          data: billingOverview.current,
        }),
      },
    },
  },
}));

import { useAppInlineBanner } from './useAppInlineBanner';

describe('useAppInlineBanner billing operation', () => {
  beforeEach(() => {
    beginPortalAttempt.mockReturnValue(OPERATION_ID);
    settlePortalAttempt.mockReturnValue(true);
    billingOverview.current = { billingInfo: { subscriptionStatus: 'past_due' } };
    pollStartedAt.current = null;
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
    vi.clearAllMocks();
  });

  it('passes the stable operation ID to the Portal mutation', () => {
    const { result } = renderHook(() => useAppInlineBanner());

    act(() => {
      result.current.action?.onClick();
    });

    expect(portalMutate).toHaveBeenCalledWith({ operationId: OPERATION_ID });
  });

  it('disables the Portal action after account deletion closes billing', () => {
    const { result } = renderHook(() => useAppInlineBanner());

    act(() => {
      result.current.action?.onClick();
      mutationOptions.current?.onError(
        { data: { serviceCode: 'BILLING_ACCOUNT_CLOSING' } },
        { operationId: OPERATION_ID },
      );
    });

    expect(result.current.action?.disabled).toBe(true);
    expect(result.current.message).toBe('common.billingOperation.accountClosing');
    expect(toastError).toHaveBeenCalledWith('common.billingOperation.accountClosing');
  });

  it('ignores a stale success callback instead of redirecting', () => {
    settlePortalAttempt.mockReturnValue(false);
    renderHook(() => useAppInlineBanner());

    act(() => {
      mutationOptions.current?.onSuccess({ url: '#portal' }, { operationId: OPERATION_ID });
    });

    expect(window.location.hash).toBe('');
  });

  it.each([
    ['active subscription', 'active'],
    ['free account', null],
  ])('hides the billing banner for %s', (_label, subscriptionStatus) => {
    billingOverview.current = { billingInfo: { subscriptionStatus } };

    const { result } = renderHook(() => useAppInlineBanner());

    expect(result.current).toEqual({ visible: false, message: '' });
  });

  it('Checkout復帰後もfreeのまま期限を迎えたら利用者案内とSentry通知を起動する', () => {
    billingOverview.current = { billingInfo: { subscriptionStatus: 'free' } };
    pollStartedAt.current = Date.now() - 30_000;

    renderHook(() => useAppInlineBanner());

    expect(reportBillingReturnPollTimeout).toHaveBeenCalledOnce();
    expect(reportBillingReturnPollTimeout).toHaveBeenCalledWith(
      'settings.subscription.checkoutDelayed',
    );
    expect(stopBillingPoll).toHaveBeenCalledOnce();
  });
});
