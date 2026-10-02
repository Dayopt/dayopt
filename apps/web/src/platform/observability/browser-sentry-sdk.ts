import * as Sentry from '@sentry/nextjs';

import {
  sanitizeBreadcrumbEvent,
  sanitizeErrorEvent,
  sanitizeSpanEvent,
  sanitizeTransactionEvent,
} from './sentry-sanitizers';

/** The existing browser configuration, loaded only after analytics consent. */
export const browserSentryRuntime = {
  initialize(dsn: string): void {
    Sentry.init({
      dsn,
      enabled: true,
      environment: 'production',
      sendDefaultPii: false,
      tracesSampler: ({ inheritOrSampleWith }) => inheritOrSampleWith(0.1),
      integrations: [Sentry.browserTracingIntegration({ enableInp: true })],
      beforeSend: (event, hint) => sanitizeErrorEvent(event, hint),
      beforeSendTransaction: (event) => sanitizeTransactionEvent(event),
      beforeSendSpan: (span) => sanitizeSpanEvent(span),
      beforeBreadcrumb: (breadcrumb) => sanitizeBreadcrumbEvent(breadcrumb),
    });
  },
  setEnabled(enabled: boolean): void {
    const client = Sentry.getClient();
    if (client) client.getOptions().enabled = enabled;
  },
  captureRouterTransitionStart: Sentry.captureRouterTransitionStart,
  captureBoundaryError(error: Error, tags: Record<string, string>): void {
    Sentry.withScope((scope) => {
      scope.setTags(tags);
      Sentry.captureException(error);
    });
  },
};
