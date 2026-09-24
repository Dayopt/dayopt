export {
  capturePostHogBrowserEvent,
  capturePostHogPageview,
  identifyPostHogBrowser,
  resetPostHogBrowserIdentity,
  startPostHogBrowser,
  stopPostHogBrowser,
} from './posthog-browser';

export {
  filterPostHogBrowserProperties,
  postHogExternalReferrer,
  postHogPagePath,
  postHogUtm,
} from './posthog-capture';

export {
  BROWSER_TELEMETRY_CONSENT_EVENT,
  BROWSER_TELEMETRY_CONSENT_STORAGE_KEY,
  getBrowserTelemetryConsentStorage,
  hasAnalyticsConsent,
  isAnalyticsConsentDetail,
  isBrowserTelemetryConsentStorageChange,
  parseBrowserTelemetryConsent,
  readBrowserTelemetryConsent,
  resolveAnalyticsConsentDetail,
  type BrowserTelemetryConsent,
  type BrowserTelemetryConsentStorage,
  type BrowserTelemetryConsentWritableStorage,
} from './consent';

export {
  USER_CANCELLATION_ERROR_CODE,
  UserCancellationError,
  isExplicitUserCancellation,
} from './cancellation';

export {
  sanitizeObservabilityUrl,
  sanitizeSentryBreadcrumb,
  sanitizeSentryEvent,
  sanitizeSentrySpan,
  sanitizeSentryTransaction,
  sanitizeTechnicalContext,
  type ObservabilityRecord,
  type TechnicalErrorContext,
} from './sanitize';
