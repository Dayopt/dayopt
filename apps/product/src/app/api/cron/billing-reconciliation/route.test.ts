import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reconcileBillingWebhookEvents = vi.hoisted(() => vi.fn());
const captureUnexpectedError = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());
const envMock = vi.hoisted(
  () =>
    ({
      CRON_SECRET: 'super-secret-cron',
      STRIPE_ACCOUNT_ID: 'acct_dayopt_test',
      STRIPE_LIVEMODE: 'false',
      STRIPE_SECRET_KEY: 'test-key',
    }) as {
      CRON_SECRET: string | undefined;
      STRIPE_ACCOUNT_ID: string | undefined;
      STRIPE_LIVEMODE: 'true' | 'false' | undefined;
      STRIPE_SECRET_KEY: string | undefined;
    },
);

vi.mock('@/env', () => ({ env: envMock }));
vi.mock('@/features/settings/server', () => ({
  hasBillingWebhookReconciliationDiscrepancy: (summary: {
    failed: number;
    invalidState: number;
    missing: number;
    staleProcessing: number;
    truncated: boolean;
  }) =>
    summary.failed > 0 ||
    summary.invalidState > 0 ||
    summary.missing > 0 ||
    summary.staleProcessing > 0 ||
    summary.truncated,
  reconcileBillingWebhookEvents,
}));
vi.mock('@/lib/sentry', () => ({ captureUnexpectedError }));
vi.mock('@/lib/logger', () => ({
  logger: { error: loggerError, warn: vi.fn() },
}));

import { GET } from './route';

const URL = 'https://app.dayopt.app/api/cron/billing-reconciliation';
const CLEAN_SUMMARY = {
  checked: 3,
  failed: 0,
  invalidState: 0,
  missing: 0,
  staleProcessing: 0,
  truncated: false,
};

function request(authorization?: string): NextRequest {
  const headers = new Headers();
  if (authorization) headers.set('authorization', authorization);
  return new NextRequest(URL, { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(envMock, {
    CRON_SECRET: 'super-secret-cron',
    STRIPE_ACCOUNT_ID: 'acct_dayopt_test',
    STRIPE_LIVEMODE: 'false',
    STRIPE_SECRET_KEY: 'test-key',
  });
  reconcileBillingWebhookEvents.mockResolvedValue(CLEAN_SUMMARY);
});

describe('billing reconciliation cron', () => {
  it('Bearer認証不一致を401で拒否する', async () => {
    expect((await GET(request('Bearer wrong-secret'))).status).toBe(401);
    expect(reconcileBillingWebhookEvents).not.toHaveBeenCalled();
  });

  it('Stripeが全て未設定なら正常にskipする', async () => {
    envMock.STRIPE_SECRET_KEY = undefined;
    envMock.STRIPE_ACCOUNT_ID = undefined;
    envMock.STRIPE_LIVEMODE = undefined;

    const response = await GET(request('Bearer super-secret-cron'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, configured: false });
    expect(reconcileBillingWebhookEvents).not.toHaveBeenCalled();
  });

  it('Stripe設定が一部だけなら503とSentry通知を返す', async () => {
    envMock.STRIPE_ACCOUNT_ID = undefined;

    const response = await GET(request('Bearer super-secret-cron'));

    expect(response.status).toBe(503);
    expect(captureUnexpectedError).toHaveBeenCalledWith(expect.any(Error), {
      feature: 'billing',
      operation: 'billing_webhook_reconciliation_configuration',
      route: '/api/cron/billing-reconciliation',
      source: 'stripe_webhook',
    });
  });

  it('差分なしは件数だけを200で返す', async () => {
    const response = await GET(request('Bearer super-secret-cron'));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      ok: true,
      configured: true,
      ...CLEAN_SUMMARY,
    });
  });

  it('missing eventを503で可視化し、IDをresponseやSentryへ出さない', async () => {
    reconcileBillingWebhookEvents.mockResolvedValue({ ...CLEAN_SUMMARY, missing: 1 });

    const response = await GET(request('Bearer super-secret-cron'));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      ok: false,
      configured: true,
      ...CLEAN_SUMMARY,
      missing: 1,
    });
    expect(captureUnexpectedError).toHaveBeenCalledWith(expect.any(Error), {
      feature: 'billing',
      operation: 'billing_webhook_reconciliation',
      route: '/api/cron/billing-reconciliation',
      source: 'stripe_webhook',
    });
    expect(JSON.stringify(body)).not.toContain('evt_');
  });

  it('provider失敗をsafeな500へ変換する', async () => {
    reconcileBillingWebhookEvents.mockRejectedValue(new Error('provider secret response'));

    const response = await GET(request('Bearer super-secret-cron'));

    expect(response.status).toBe(500);
    expect(JSON.stringify(captureUnexpectedError.mock.calls)).not.toContain(
      'provider secret response',
    );
    expect(loggerError).toHaveBeenCalledWith('[billing-reconciliation] reconciliation failed');
  });
});
