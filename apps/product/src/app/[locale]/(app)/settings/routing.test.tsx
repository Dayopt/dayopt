import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockHasMounted = false;
let mockIsMobile = false;
let mockCategory = 'account';
let mockSearchParams = new URLSearchParams();

const mockReplace = vi.fn();
const mockPush = vi.fn();
const mockOpenSettings = vi.fn();
const mockLogout = vi.fn();
const {
  mockInvalidateConnections,
  mockInvalidateBillingOverview,
  mockToastSuccess,
  mockToastError,
} = vi.hoisted(() => ({
  mockInvalidateConnections: vi.fn(),
  mockInvalidateBillingOverview: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ category: mockCategory }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'ja',
}));

vi.mock('@dayopt/i18n/navigation', async () => {
  const React = await import('react');
  return {
    Link: ({ children, href, ...props }: { children: React.ReactNode; href: string }) =>
      React.createElement('a', { href, ...props }, children),
    useRouter: () => ({
      replace: mockReplace,
      push: mockPush,
    }),
  };
});

// MobileAccountOverview は barrel を経由せず '../constants' を直接 import するため、
// SETTINGS_CATEGORIES はここで mock し、barrel 側は re-export を通じて同じ値を受け取る。
vi.mock('@/features/settings/constants', () => ({
  SETTINGS_CATEGORIES: [
    {
      id: 'account',
      labelKey: 'settings.dialog.categories.account',
      icon: () => <span aria-hidden="true" />,
    },
    {
      id: 'display',
      labelKey: 'settings.dialog.categories.display',
      icon: () => <span aria-hidden="true" />,
    },
    {
      id: 'data',
      labelKey: 'settings.dialog.categories.data',
      icon: () => <span aria-hidden="true" />,
    },
    {
      id: 'integrations',
      labelKey: 'settings.dialog.categories.integrations',
      icon: () => <span aria-hidden="true" />,
    },
    {
      id: 'billing',
      labelKey: 'settings.dialog.categories.billing',
      icon: () => <span aria-hidden="true" />,
    },
  ],
}));

vi.mock('@/features/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/settings')>()),
  isValidCategory: (category: string) =>
    ['account', 'display', 'data', 'integrations', 'billing'].includes(category),
  SettingsContent: ({ category }: { category: string }) => <div>{category}</div>,
}));

vi.mock('@/lib/hooks/useHasMounted', () => ({
  useHasMounted: () => mockHasMounted,
}));

vi.mock('@/lib/hooks/useMediaQuery', () => ({
  useMediaQuery: () => mockIsMobile,
}));

vi.mock('@/lib/stores/useShellStore', () => ({
  useShellStore: (
    selector: (state: { openSettings: typeof mockOpenSettings; openSheet: () => void }) => unknown,
  ) => selector({ openSettings: mockOpenSettings, openSheet: vi.fn() }),
}));

vi.mock('@/features/auth', () => ({
  useAuthStore: (
    selector: (state: {
      user: { email: string; user_metadata: Record<string, unknown> };
    }) => unknown,
  ) =>
    selector({
      user: {
        email: 'tester@example.com',
        user_metadata: { full_name: 'Tester' },
      },
    }),
}));

vi.mock('@/lib/hooks/useLogout', () => ({
  useLogout: () => ({ logout: mockLogout, isLoggingOut: false }),
}));

// 基底 Avatar は @dayopt/components に昇格済み。表示系のみ stub し、その他の
// 共有 component（Card / Badge / ScrollArea / Skeleton 等）は実体を使う。
vi.mock('@dayopt/components', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dayopt/components')>()),
  Avatar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AvatarImage: () => null,
  AvatarFallback: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/lib/trpc', () => ({
  api: {
    useUtils: () => ({
      billing: {
        getOverview: { invalidate: mockInvalidateBillingOverview },
      },
      externalCalendar: {
        listConnections: { invalidate: mockInvalidateConnections },
      },
    }),
    billing: {
      getOverview: {
        useQuery: () => ({ data: null, isLoading: false }),
      },
    },
  },
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: mockToastSuccess, error: mockToastError },
}));

vi.mock('@/components/shell/AppHeader', () => ({
  AppHeader: ({
    children,
    leftSlot,
    rightSlot,
  }: {
    children: React.ReactNode;
    leftSlot?: React.ReactNode;
    rightSlot?: React.ReactNode;
  }) => (
    <header>
      {leftSlot}
      {children}
      {rightSlot}
    </header>
  ),
}));

import SettingsCategoryPage from './[category]/page';
import SettingsPage from './page';

describe('settings route hydration guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasMounted = false;
    mockIsMobile = false;
    mockCategory = 'account';
    mockSearchParams = new URLSearchParams();
  });

  it('does not redirect desktop settings before mount state is ready', () => {
    render(<SettingsPage />);

    expect(mockOpenSettings).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('redirects desktop settings after mount state is ready', () => {
    mockHasMounted = true;

    render(<SettingsPage />);

    expect(mockOpenSettings).toHaveBeenCalledWith('account');
    expect(mockReplace).toHaveBeenCalledWith('/calendar');
  });

  it('renders mobile settings content without redirect', () => {
    mockHasMounted = true;
    mockIsMobile = true;
    mockSearchParams = new URLSearchParams('returnTo=%2Fweek%3Fdate%3D2026-06-22%26panel%3Dreview');

    render(<SettingsPage />);

    expect(mockOpenSettings).not.toHaveBeenCalled();
    expect(screen.getByText('Tester')).toBeInTheDocument();
    expect(screen.getByText('Tester').closest('a')).toBeNull();
    expect(screen.getByRole('link', { name: 'common.back' })).toHaveAttribute(
      'href',
      '/week?date=2026-06-22&panel=review',
    );
    expect(
      screen.getByRole('heading', { level: 2, name: 'settings.accountPage.sections.settings' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'settings.accountPage.sections.data' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'settings.accountPage.sections.plan' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'settings.accountPage.sections.support' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'settings.accountPage.sections.other' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'settings.dialog.categories.account' }),
    ).toHaveAttribute(
      'href',
      '/settings/account?returnTo=%2Fweek%3Fdate%3D2026-06-22%26panel%3Dreview',
    );
    expect(
      screen.getByRole('link', { name: 'settings.accountPage.documentation' }),
    ).toHaveAttribute('href', 'https://dayopt.app/docs');
  });

  it('does not redirect desktop category page before mount state is ready', () => {
    render(<SettingsCategoryPage />);

    expect(mockOpenSettings).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('redirects desktop category page after mount state is ready', () => {
    mockHasMounted = true;
    mockCategory = 'billing';

    render(<SettingsCategoryPage />);

    expect(mockOpenSettings).toHaveBeenCalledWith('billing');
    expect(mockReplace).toHaveBeenCalledWith('/calendar');
  });

  it('handles a desktop calendar callback before opening Integrations', () => {
    mockHasMounted = true;
    mockCategory = 'integrations';
    mockSearchParams = new URLSearchParams('calendar=connected');

    render(<SettingsCategoryPage />);

    expect(mockToastSuccess).toHaveBeenCalledWith(
      'settings.integrations.googleCalendar.callback.connected',
    );
    expect(mockInvalidateConnections).toHaveBeenCalled();
    expect(mockOpenSettings).toHaveBeenCalledWith('integrations');
    expect(mockReplace).toHaveBeenCalledWith('/calendar');
  });

  it('handles a desktop checkout return before reopening Billing', () => {
    mockHasMounted = true;
    mockIsMobile = false;
    mockCategory = 'billing';
    mockSearchParams = new URLSearchParams('success=true');

    render(<SettingsCategoryPage />);

    expect(mockToastSuccess).toHaveBeenCalledWith('settings.subscription.checkoutSuccess');
    expect(mockInvalidateBillingOverview).toHaveBeenCalled();
    expect(mockOpenSettings).toHaveBeenCalledWith('billing');
    expect(mockReplace).toHaveBeenCalledWith('/calendar');
  });

  it('cleans only checkout callback params on mobile', () => {
    mockHasMounted = true;
    mockIsMobile = true;
    mockCategory = 'billing';
    mockSearchParams = new URLSearchParams('canceled=true&panel=review');

    render(<SettingsCategoryPage />);

    expect(mockToastSuccess).toHaveBeenCalledWith('settings.subscription.checkoutCanceled');
    expect(mockReplace).toHaveBeenCalledWith('/settings/billing?panel=review');
  });

  it('invalidates the billing overview when returning from the customer portal', () => {
    mockHasMounted = true;
    mockIsMobile = false;
    mockCategory = 'billing';
    mockSearchParams = new URLSearchParams('portal_return=true');

    render(<SettingsCategoryPage />);

    // Portal からの復帰は通知するイベントではないので toast は出さない
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockInvalidateBillingOverview).toHaveBeenCalled();
    expect(mockOpenSettings).toHaveBeenCalledWith('billing');
  });

  it('ignores checkout params outside the billing category', () => {
    mockHasMounted = true;
    mockIsMobile = false;
    mockCategory = 'account';
    mockSearchParams = new URLSearchParams('success=true');

    render(<SettingsCategoryPage />);

    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockOpenSettings).toHaveBeenCalledWith('account');
  });

  it('cleans only calendar callback params on mobile', () => {
    mockHasMounted = true;
    mockIsMobile = true;
    mockCategory = 'integrations';
    mockSearchParams = new URLSearchParams(
      'returnTo=%2Fweek%3Fdate%3D2026-08-01&calendar=error&reason=account_mismatch&panel=review',
    );

    render(<SettingsCategoryPage />);

    expect(mockToastError).toHaveBeenCalledWith(
      'settings.integrations.googleCalendar.callback.accountMismatch',
    );
    expect(mockReplace).toHaveBeenCalledWith(
      '/settings/integrations?returnTo=%2Fweek%3Fdate%3D2026-08-01&panel=review',
    );
  });

  it('preserves the mobile settings return path from category pages', () => {
    mockHasMounted = true;
    mockIsMobile = true;
    mockCategory = 'billing';
    mockSearchParams = new URLSearchParams('returnTo=%2Fja%2Fday%3Fdate%3D2026-06-22');

    render(<SettingsCategoryPage />);

    expect(screen.getByRole('link', { name: 'common.back' })).toHaveAttribute(
      'href',
      '/settings?returnTo=%2Fday%3Fdate%3D2026-06-22',
    );
  });
});
