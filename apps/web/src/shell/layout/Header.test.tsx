// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Header } from './Header';

const trackSignupCta = vi.hoisted(() => vi.fn());
vi.mock('@web/platform/analytics/signup-cta', () => ({ trackSignupCta }));
vi.mock('@web/platform/config/product-signup-url', () => ({
  productSignupUrl: () => 'https://product-preview.example/auth/signup',
}));
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));
vi.mock('@dayopt/i18n/navigation', () => ({
  usePathname: () => '/',
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@dayopt/components', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
  Button: ({ children }: { children: React.ReactNode }) => children,
  Logo: () => <span>Dayopt</span>,
  Sheet: () => null,
  SheetContent: () => null,
}));

afterEach(cleanup);

it('keeps the desktop and mobile signup destinations and their tracking placements', () => {
  const { container } = render(<Header />);
  const links = Array.from(
    container.querySelectorAll<HTMLAnchorElement>(
      'a[href="https://product-preview.example/auth/signup"]',
    ),
  );
  expect(links).toHaveLength(2);
  for (const link of links) fireEvent.click(link);
  expect(trackSignupCta.mock.calls).toEqual([['header_desktop'], ['header_mobile']]);
});
