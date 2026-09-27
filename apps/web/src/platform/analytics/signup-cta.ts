import { capturePostHogBrowserEvent, postHogPagePath } from '@dayopt/observability';

export function trackSignupCta(
  ctaId: 'header_desktop' | 'header_mobile' | 'hero' | 'pricing_free' | 'pricing_pro',
): void {
  capturePostHogBrowserEvent('signup_cta_clicked', {
    cta_id: ctaId,
    page_path: postHogPagePath(window.location.pathname),
  });
}
