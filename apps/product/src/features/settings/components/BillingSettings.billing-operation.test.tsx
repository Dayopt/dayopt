vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (select: (state: { timezone: string }) => unknown) =>
    select({ timezone: 'Asia/Tokyo' }),
}));
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STRIPE_PRO_PRICE_ID = 'price_test';
});

const FIRST_OPERATION_ID = '00000000-0000-4000-8000-000000000001';
const SECOND_OPERATION_ID = '00000000-0000-4000-8000-000000000002';
const checkoutMutate = vi.hoisted(() => vi.fn());
const portalMutate = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const checkoutOptions = vi.hoisted(
  () =>
    ({ current: null }) as {
      current: null | {
        onError: (error: unknown, variables: { operationId: string }) => void;
        onSuccess: (data: { url: string }, variables: { operationId: string }) => void;
      };
    },
);
const portalOptions = vi.hoisted(
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

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: toastError, success: vi.fn() },
}));

vi.mock('@/components/ui/display/LabeledRow', () => ({
  LabeledRow: ({ children, label }: { children: React.ReactNode; label: React.ReactNode }) => (
    <div>
      {label}
      {children}
    </div>
  ),
}));

vi.mock('@/components/ui/display/SectionCard', () => ({
  SectionCard: ({ children, title }: { children: React.ReactNode; title?: React.ReactNode }) => (
    <section>
      {title}
      {children}
    </section>
  ),
}));

vi.mock('@/components/ui/feedback/ErrorState', () => ({
  ErrorState: () => <div />,
}));

vi.mock('@dayopt/components', () => {
  const Container = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const Button = ({
    children,
    disabled,
    onClick,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );

  return {
    AlertDialog: Container,
    AlertDialogAction: Button,
    AlertDialogCancel: Button,
    AlertDialogContent: Container,
    AlertDialogDescription: Container,
    AlertDialogFooter: Container,
    AlertDialogHeader: Container,
    AlertDialogTitle: Container,
    AlertDialogTrigger: Container,
    Badge: Container,
    Button,
    Skeleton: () => <div />,
    cn: (...classes: Array<false | null | string | undefined>) => classes.filter(Boolean).join(' '),
  };
});

vi.mock('@/lib/trpc', () => ({
  api: {
    billing: {
      createCheckoutSession: {
        useMutation: (options: NonNullable<typeof checkoutOptions.current>) => {
          checkoutOptions.current = options;
          return { isPending: false, mutate: checkoutMutate };
        },
      },
      createPortalSession: {
        useMutation: (options: NonNullable<typeof portalOptions.current>) => {
          portalOptions.current = options;
          return { isPending: false, mutate: portalMutate };
        },
      },
      getOverview: {
        useQuery: () => ({
          data: {
            billingInfo: {
              stripeCustomerId: null,
              subscriptionId: null,
              subscriptionStatus: 'free',
            },
            invoices: [],
            paymentMethod: null,
          },
          isError: false,
          isLoading: false,
          refetch: vi.fn(),
        }),
      },
    },
  },
}));

import { BillingSettings } from './BillingSettings';

describe('BillingSettings billing operation', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce(FIRST_OPERATION_ID)
      .mockReturnValueOnce(SECOND_OPERATION_ID);
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('reuses retryable Checkout IDs and replaces terminal IDs', async () => {
    const user = userEvent.setup();
    render(<BillingSettings />);
    const upgrade = screen.getByRole('button', {
      name: 'settings.subscription.singlePlan.purchase',
    });

    await user.click(upgrade);
    expect(checkoutMutate).toHaveBeenLastCalledWith({ operationId: FIRST_OPERATION_ID });

    act(() => {
      checkoutOptions.current?.onError(
        { data: { serviceCode: 'BILLING_OPERATION_CONFLICT' } },
        { operationId: FIRST_OPERATION_ID },
      );
    });
    await user.click(upgrade);
    expect(checkoutMutate).toHaveBeenLastCalledWith({ operationId: FIRST_OPERATION_ID });

    act(() => {
      checkoutOptions.current?.onError(
        { data: { serviceCode: 'BILLING_RESPONSE_EXPIRED' } },
        { operationId: FIRST_OPERATION_ID },
      );
    });
    await user.click(upgrade);
    expect(checkoutMutate).toHaveBeenLastCalledWith({ operationId: SECOND_OPERATION_ID });
  });

  it('ignores stale success and disables actions after account closing', async () => {
    const user = userEvent.setup();
    render(<BillingSettings />);
    const upgrade = screen.getByRole('button', {
      name: 'settings.subscription.singlePlan.purchase',
    });

    await user.click(upgrade);
    act(() => {
      checkoutOptions.current?.onError(
        { data: { serviceCode: 'BILLING_RESPONSE_EXPIRED' } },
        { operationId: FIRST_OPERATION_ID },
      );
    });
    await user.click(upgrade);

    act(() => {
      checkoutOptions.current?.onSuccess(
        { url: '#stale-checkout' },
        { operationId: FIRST_OPERATION_ID },
      );
    });
    expect(window.location.hash).toBe('');

    act(() => {
      checkoutOptions.current?.onError(
        { data: { serviceCode: 'BILLING_ACCOUNT_CLOSING' } },
        { operationId: SECOND_OPERATION_ID },
      );
    });
    expect(upgrade).toBeDisabled();
    expect(toastError).toHaveBeenCalledWith('common.billingOperation.accountClosing');
  });

  // Stripe が unpaid / paused でも profiles 上は free 扱いになるため、Pro 向けの
  // portal ボタンは canAccessPro で隠れている。checkout をやり直しても必ず同じ
  // 失敗を返すので、toast の action が唯一の出口になる（#1945）
  it('offers the billing portal when a subscription already exists', async () => {
    const user = userEvent.setup();
    render(<BillingSettings />);
    const upgrade = screen.getByRole('button', {
      name: 'settings.subscription.singlePlan.purchase',
    });

    await user.click(upgrade);
    act(() => {
      checkoutOptions.current?.onError(
        { data: { serviceCode: 'BILLING_CHECKOUT_NOT_AVAILABLE' } },
        { operationId: FIRST_OPERATION_ID },
      );
    });

    expect(toastError).toHaveBeenCalledWith('common.billingOperation.checkoutNotAvailable', {
      action: { label: 'settings.subscription.managePlan', onClick: expect.any(Function) },
    });

    // action を押すと portal が開く。checkout の再試行ではない
    expect(portalMutate).not.toHaveBeenCalled();
    const [, options] = toastError.mock.calls.at(-1) ?? [];
    act(() => {
      (options as { action: { onClick: () => void } }).action.onClick();
    });
    expect(portalMutate).toHaveBeenCalledWith({ operationId: SECOND_OPERATION_ID });
  });
});
