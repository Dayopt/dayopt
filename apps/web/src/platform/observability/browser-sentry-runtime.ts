export type BrowserSentryRuntime = typeof import('./browser-sentry-sdk').browserSentryRuntime;

let readyRuntime: BrowserSentryRuntime | undefined;

/** Error boundaries reuse the consented SDK; they never load telemetry themselves. */
export function getReadyBrowserSentryRuntime(): BrowserSentryRuntime | undefined {
  return readyRuntime;
}

/** Native module caching shares the SDK while allowing a failed chunk to be retried. */
export function loadBrowserSentryRuntime(): Promise<BrowserSentryRuntime> {
  return import('./browser-sentry-sdk').then((module) => {
    readyRuntime = module.browserSentryRuntime;
    return readyRuntime;
  });
}
