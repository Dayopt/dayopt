import { beforeEach, describe, expect, it, vi } from 'vitest';

const captureUnexpectedError = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/sentry', () => ({ captureUnexpectedError }));
vi.mock('@/lib/toast', () => ({ toast: { error: toastError } }));

import { reportBillingReturnPollTimeout } from './billing-poll-observability';

describe('reportBillingReturnPollTimeout', () => {
  beforeEach(() => vi.clearAllMocks());

  it('利用者へ再確認を案内し、個人情報を含まないcontextでSentryへ通知する', () => {
    reportBillingReturnPollTimeout('Billing is taking longer than expected.');

    expect(toastError).toHaveBeenCalledWith('Billing is taking longer than expected.');
    expect(captureUnexpectedError).toHaveBeenCalledWith(expect.any(Error), {
      feature: 'billing',
      operation: 'billing_return_poll_timeout',
      source: 'stripe_checkout',
    });
  });
});
