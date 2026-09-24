'use client';

import { useEffect, useRef } from 'react';

import { capturePostHogBrowserEvent } from '@dayopt/observability';

import { api } from '@/lib/trpc';

/** Records the initial open and each later closed-to-open transition once. */
export function useReviewOpenedTracking(isActive: boolean): void {
  const hasTrackedCurrentOpen = useRef(false);
  const { mutate: trackOpened } = api.review.trackOpened.useMutation({ retry: false });

  useEffect(() => {
    if (!isActive) {
      hasTrackedCurrentOpen.current = false;
      return;
    }

    if (hasTrackedCurrentOpen.current) return;
    hasTrackedCurrentOpen.current = true;
    trackOpened();
    capturePostHogBrowserEvent('review_opened', { screen: 'review' });
  }, [isActive, trackOpened]);
}
