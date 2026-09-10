import { beforeEach, describe, expect, it, vi } from 'vitest';

const captureUnexpectedError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/sentry', () => ({ captureUnexpectedError }));

import {
  captureWebhookSignatureFailure,
  resetWebhookSignatureFailureCaptureForTestsOnly,
} from './signature-failure-monitor';

beforeEach(() => {
  vi.clearAllMocks();
  resetWebhookSignatureFailureCaptureForTestsOnly();
});

describe('captureWebhookSignatureFailure', () => {
  it('同じ source の連続失敗を60秒に1回だけ通知する', () => {
    for (let index = 0; index < 5; index += 1) {
      captureWebhookSignatureFailure({
        feature: 'billing',
        route: '/api/webhooks/stripe',
        source: 'stripe_webhook',
        now: 1_000 + index,
      });
    }

    expect(captureUnexpectedError).toHaveBeenCalledOnce();
    expect(captureUnexpectedError).toHaveBeenCalledWith(expect.any(Error), {
      feature: 'billing',
      operation: 'signature_verification',
      route: '/api/webhooks/stripe',
      source: 'stripe_webhook',
    });
  });

  it('60秒後と別 source の失敗は独立して通知する', () => {
    captureWebhookSignatureFailure({
      feature: 'billing',
      route: '/api/webhooks/stripe',
      source: 'stripe_webhook',
      now: 1_000,
    });
    captureWebhookSignatureFailure({
      feature: 'email',
      route: '/api/webhooks/resend',
      source: 'resend_webhook',
      now: 1_001,
    });
    captureWebhookSignatureFailure({
      feature: 'billing',
      route: '/api/webhooks/stripe',
      source: 'stripe_webhook',
      now: 61_000,
    });

    expect(captureUnexpectedError).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(captureUnexpectedError.mock.calls)).not.toContain('signature-value');
  });
});
