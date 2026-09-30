// @vitest-environment happy-dom

import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const trackSignupCta = vi.hoisted(() => vi.fn());

vi.mock('@dayopt/billing', () => ({
  dayoptPlans: { free: { id: 'free' }, pro: { id: 'pro' } },
  dayoptPricing: { free: { displayPrice: '$0' }, pro: { displayPrice: '$8' } },
}));
vi.mock('@dayopt/components', () => ({
  Button: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@dayopt/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => Object.assign((key: string) => key, { raw: () => [] }),
}));
vi.mock('@web/platform/analytics/signup-cta', () => ({ trackSignupCta }));
vi.mock('@web/platform/config/product-signup-url', () => ({
  productSignupUrl: () => 'https://product-preview.example/auth/signup',
}));
vi.mock('./DayCanvas', () => ({ DayCanvas: () => null }));
vi.mock('./LandingInteractions', () => ({
  CalendarDemo: () => null,
  ClosingMark: () => null,
  TemplateDemo: () => null,
}));

import { LandingPage } from './LandingPage';

describe('LandingPage signup calls to action', () => {
  it('keeps each CTA on its matching Product preview and tracks its placement', async () => {
    const page = await LandingPage({ locale: 'en' });
    const { container } = render(page);
    const links = Array.from(
      container.querySelectorAll<HTMLAnchorElement>(
        'a[href="https://product-preview.example/auth/signup"]',
      ),
    );

    expect(links).toHaveLength(4);
    for (const link of links) fireEvent.click(link);
    expect(trackSignupCta.mock.calls).toEqual([
      ['hero'],
      ['pricing_free'],
      ['pricing_pro'],
      ['closing'],
    ]);
  });
});
