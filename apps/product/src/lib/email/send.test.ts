import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #2789: トランザクションメール送信の共通経路。
 *
 * 固定する契約は 3 つ:
 * - suppression に載っているアドレスへは Resend を呼ばない
 * - provider 失敗も suppression 判定の失敗も **throw せず** `failed` を返す
 *   （Stripe webhook がこの経路で 200 を返し続けられる根拠）
 * - 判定できない時は送らない（fail-closed）
 */

const mocks = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  captureUnexpectedError: vi.fn(),
  captureUnexpectedDatabaseError: vi.fn((error: unknown, _context?: Record<string, unknown>) =>
    error instanceof Error ? error : new Error('database failure'),
  ),
  resendSend: vi.fn(),
  suppressionLimit: vi.fn(),
}));

vi.mock('@/env', () => ({
  env: {
    RESEND_API_KEY: 'test-resend-key',
    RESEND_FROM_EMAIL: 'notifications@dayopt.test',
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: mocks.loggerWarn, info: mocks.loggerInfo, error: mocks.loggerError },
}));

vi.mock('@/lib/sentry', () => ({
  captureUnexpectedError: mocks.captureUnexpectedError,
  captureUnexpectedDatabaseError: mocks.captureUnexpectedDatabaseError,
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mocks.resendSend };
  },
}));

vi.mock('@/lib/supabase/oauth', () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          limit: mocks.suppressionLimit,
        }),
      }),
    }),
  }),
}));

import { sendTransactionalEmail } from './send';

const payload = {
  to: 'user@example.com',
  subject: 'Subject',
  react: null as unknown as React.ReactElement,
  context: 'send_trial_start_email',
};

describe('sendTransactionalEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resendSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });
  });

  it('suppressed でなければ Resend を 1 回呼び sent を返す', async () => {
    mocks.suppressionLimit.mockResolvedValue({ data: [], error: null });

    const result = await sendTransactionalEmail(payload);

    expect(result).toEqual({ status: 'sent', emailId: 'email-1' });
    expect(mocks.resendSend).toHaveBeenCalledTimes(1);
    expect(mocks.resendSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'user@example.com', subject: 'Subject' }),
    );
  });

  it('suppression に載っているアドレスへは Resend を呼ばず suppressed を返す', async () => {
    mocks.suppressionLimit.mockResolvedValue({ data: [{ reason: 'bounce' }], error: null });

    const result = await sendTransactionalEmail(payload);

    expect(result).toEqual({ status: 'suppressed' });
    expect(mocks.resendSend).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('skipped: email suppressed'),
    );
    // securityNotification 未指定なので Sentry へは出さない
    expect(mocks.captureUnexpectedError).not.toHaveBeenCalled();
  });

  it('securityNotification の suppressed は Sentry へ痕跡を残す', async () => {
    mocks.suppressionLimit.mockResolvedValue({ data: [{ reason: 'complaint' }], error: null });

    const result = await sendTransactionalEmail({
      ...payload,
      context: 'MFA disabled email',
      securityNotification: true,
    });

    expect(result).toEqual({ status: 'suppressed' });
    expect(mocks.captureUnexpectedError).toHaveBeenCalledTimes(1);
    const [capturedError, context] = mocks.captureUnexpectedError.mock.calls[0] as [
      Error,
      Record<string, unknown>,
    ];
    expect(capturedError.message).toContain('MFA disabled email');
    expect(context).toMatchObject({ feature: 'email' });
  });

  it('Resend が error を返しても throw せず failed(provider) を返す', async () => {
    mocks.suppressionLimit.mockResolvedValue({ data: [], error: null });
    mocks.resendSend.mockResolvedValue({ data: null, error: { message: 'rate limited' } });

    const result = await sendTransactionalEmail(payload);

    expect(result).toMatchObject({ status: 'failed', reason: 'provider' });
    expect(mocks.loggerError).toHaveBeenCalled();
  });

  it('Resend が throw しても throw せず failed(provider) を返す', async () => {
    mocks.suppressionLimit.mockResolvedValue({ data: [], error: null });
    const providerError = new Error('network down');
    mocks.resendSend.mockRejectedValue(providerError);

    const result = await sendTransactionalEmail(payload);

    expect(result).toEqual({ status: 'failed', reason: 'provider', error: providerError });
  });

  it('suppression 検索が失敗したら送らず failed(suppression_lookup) を返す', async () => {
    mocks.suppressionLimit.mockResolvedValue({
      data: null,
      error: { message: 'connection refused' },
    });

    const result = await sendTransactionalEmail(payload);

    expect(result).toMatchObject({ status: 'failed', reason: 'suppression_lookup' });
    // fail-closed: 判定できない時に送らないことがこのテストの主眼
    expect(mocks.resendSend).not.toHaveBeenCalled();
    expect(mocks.captureUnexpectedDatabaseError).toHaveBeenCalledTimes(1);
    expect(mocks.captureUnexpectedDatabaseError.mock.calls[0]?.[1]).toMatchObject({
      feature: 'email',
      operation: 'check_email_suppression',
    });
  });
});
