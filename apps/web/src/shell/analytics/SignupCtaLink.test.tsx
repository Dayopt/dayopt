// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Button } from '@dayopt/components';
import { dayoptProductUrls } from '@dayopt/config';

const trackSignupCta = vi.hoisted(() => vi.fn());
vi.mock('@web/platform/analytics/signup-cta', () => ({ trackSignupCta }));

import { SignupCtaLink } from './SignupCtaLink';

describe('SignupCtaLink', () => {
  it('keeps Button styling and destination while tracking the chosen CTA', () => {
    render(
      <Button variant="primary" asChild>
        <SignupCtaLink ctaId="hero">Join Dayopt</SignupCtaLink>
      </Button>,
    );

    const link = screen.getByRole('link', { name: 'Join Dayopt' });
    expect(link.getAttribute('href')).toBe(dayoptProductUrls.signup);
    expect(link.getAttribute('class')).toContain('inline-flex');
    fireEvent.click(link);
    expect(trackSignupCta).toHaveBeenCalledWith('hero');
  });
});
