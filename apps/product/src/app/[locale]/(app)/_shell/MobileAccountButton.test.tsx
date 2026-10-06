import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({
  pathname: '/',
  query: '',
  locale: 'en',
}));

vi.mock('next-intl', () => ({
  useLocale: () => route.locale,
  useTranslations: () => (key: string) => key,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => route.pathname,
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(route.query),
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock('@dayopt/i18n/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dayopt/i18n/navigation')>()),
  usePathname: () => route.pathname,
}));

vi.mock('@/features/auth', () => ({
  useAuthStore: (selector: (state: { user: null }) => unknown) => selector({ user: null }),
}));

import { ConnectedMobileAccountButton, MobileAccountButton } from './MobileAccountButton';

describe('MobileAccountButton', () => {
  beforeEach(() => {
    route.pathname = '/';
    route.query = '';
    route.locale = 'en';
  });

  it('links to settings with an accessible account label', () => {
    render(
      <MobileAccountButton
        href="/ja/settings"
        displayName="Tester"
        ariaLabel="アカウント"
        avatarUrl={null}
      />,
    );

    const link = screen.getByRole('link', { name: 'アカウント' });
    expect(link).toHaveAttribute('href', '/ja/settings');
    expect(screen.getByText('T')).toBeInTheDocument();
  });

  it('keeps the default locale prefixless and preserves the return query once', () => {
    route.query = 'date=2026-03-25';

    render(<ConnectedMobileAccountButton />);

    const link = screen.getByRole('link', { name: 'navigation.navUser.account' });
    expect(link).toHaveAttribute('href', '/settings?returnTo=%2F%3Fdate%3D2026-03-25');
    expect(link.getAttribute('href')).not.toContain('%252F');
  });

  it('adds the Japanese locale prefix while keeping returnTo locale-free', () => {
    route.locale = 'ja';
    route.pathname = '/settings/billing';
    route.query = 'tab=invoices';

    render(<ConnectedMobileAccountButton />);

    expect(screen.getByRole('link', { name: 'navigation.navUser.account' })).toHaveAttribute(
      'href',
      '/ja/settings?returnTo=%2Fsettings%2Fbilling%3Ftab%3Dinvoices',
    );
  });
});
