// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({
  captureException: vi.fn(),
  setTags: vi.fn(),
  runtimeReady: true,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: sentry.captureException,
  captureRouterTransitionStart: vi.fn(),
  withScope: (callback: (scope: typeof sentry) => void) => callback(sentry),
}));

vi.mock('./browser-sentry-runtime', async () => {
  const { browserSentryRuntime } = await import('./browser-sentry-sdk');
  return {
    getReadyBrowserSentryRuntime: () => (sentry.runtimeReady ? browserSentryRuntime : undefined),
  };
});

import { captureBoundaryError } from './capture-boundary-error';

describe('captureBoundaryError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sentry.runtimeReady = true;
    window.history.replaceState({}, '', '/docs?private=query');
  });

  it('captures the original error once with scoped technical tags', () => {
    const error = new Error('render failed');

    captureBoundaryError(error, 'root_error');
    captureBoundaryError(error, 'global_error');

    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(error);
    expect(sentry.setTags).toHaveBeenCalledWith({
      feature: 'web',
      operation: 'react_render',
      route: '/docs',
      source: 'root_error',
    });
  });

  it('does not duplicate a digest-bearing Server Component failure', () => {
    const error = Object.assign(new Error('server render failed'), { digest: 'digest-123' });

    captureBoundaryError(error, 'root_error');

    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('does not start error telemetry before the consented runtime is ready', () => {
    sentry.runtimeReady = false;

    captureBoundaryError(new Error('render before consent'), 'root_error');

    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});
