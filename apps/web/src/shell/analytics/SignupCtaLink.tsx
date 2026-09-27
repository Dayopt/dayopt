'use client';

import type { ComponentPropsWithRef } from 'react';

import { trackSignupCta } from '@web/platform/analytics/signup-cta';
import { productSignupUrl } from '@web/platform/config/product-signup-url';

type CtaId = Parameters<typeof trackSignupCta>[0];
type SignupCtaLinkProps = ComponentPropsWithRef<'a'> & { ctaId: CtaId };

export function SignupCtaLink({ children, ctaId, onClick, ...anchorProps }: SignupCtaLinkProps) {
  return (
    <a
      {...anchorProps}
      href={productSignupUrl()}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) trackSignupCta(ctaId);
      }}
    >
      {children}
    </a>
  );
}
