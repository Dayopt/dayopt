'use client';

import { dayoptProductUrls } from '@dayopt/config';
import type { ComponentPropsWithRef } from 'react';

import { trackSignupCta } from '@web/platform/analytics/signup-cta';

type CtaId = Parameters<typeof trackSignupCta>[0];
type SignupCtaLinkProps = ComponentPropsWithRef<'a'> & { ctaId: CtaId };

export function SignupCtaLink({ children, ctaId, onClick, ...anchorProps }: SignupCtaLinkProps) {
  return (
    <a
      {...anchorProps}
      href={dayoptProductUrls.signup}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) trackSignupCta(ctaId);
      }}
    >
      {children}
    </a>
  );
}
