'use client';

import { getReadyBrowserSentryRuntime } from './browser-sentry-runtime';

type ErrorBoundaryName = 'root_error' | 'global_error';

const capturedBoundaryErrors = new WeakSet<Error>();

/** Capture an unexpected React render failure once, preserving the original Error stack. */
export function captureBoundaryError(
  error: Error & { digest?: string },
  boundary: ErrorBoundaryName,
): void {
  // Next.js already reports Server Component failures through onRequestError.
  if (error.digest) return;
  if (capturedBoundaryErrors.has(error)) return;
  capturedBoundaryErrors.add(error);

  getReadyBrowserSentryRuntime()?.captureBoundaryError(error, {
    feature: 'web',
    operation: 'react_render',
    route: window.location.pathname,
    source: boundary,
  });
}
