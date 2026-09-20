import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #2043: セキュリティ通知メール（MFA無効化・パスワード変更）が suppression
 * （bounce/complaint 済みアドレス）経由で無痕跡に落ちないことを固定する。
 *
 * Resend への実送信は行わない（mock 経由）。suppression 判定ロジック自体は
 * `isEmailSuppressed`（非 export）のため、`createServiceRoleClient` の
 * from().select().eq().limit() チェーンを mock して判定結果を制御する。
 */

const mocks = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  captureUnexpectedError: vi.fn(),
  captureUnexpectedDatabaseError: vi.fn((error: unknown) => error),
  resendSend: vi.fn(),
  suppressionLimit: vi.fn(),
}));

vi.mock('@/env', () => ({
  env: {
    RESEND_API_KEY: 'test-resend-key',
    RESEND_FROM_EMAIL: 'notifications@dayopt.test',
  },
}));

vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://app.dayopt.test' }));

vi.mock('@/lib/logger', () => ({
  logger: { warn: mocks.loggerWarn, info: mocks.loggerInfo, error: mocks.loggerError },
}));

vi.mock('@/lib/sentry', () => ({
  captureUnexpectedError: mocks.captureUnexpectedError,
  captureUnexpectedDatabaseError: mocks.captureUnexpectedDatabaseError,
  observeAuthOperation: (_operation: string, call: () => PromiseLike<unknown>) => call(),
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

import { sendAccountDeletionEmail, sendMfaDisabledEmail } from './notifications';

describe('server-side email notifications: suppression と security notification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resendSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });
  });

  it('suppressed でなければ Resend で送信し、captureUnexpectedError は呼ばれない', async () => {
    mocks.suppressionLimit.mockResolvedValue({ data: [], error: null });

    const result = await sendMfaDisabledEmail({
      email: 'user@example.com',
      userName: 'User',
      locale: 'en',
    });

    expect(result).toMatchObject({ success: true, emailId: 'email-1' });
    expect(mocks.resendSend).toHaveBeenCalledTimes(1);
    expect(mocks.captureUnexpectedError).not.toHaveBeenCalled();
  });

  it('セキュリティ通知（MFA無効化）が suppressed の場合、送信をスキップし Sentry へ痕跡を残す', async () => {
    mocks.suppressionLimit.mockResolvedValue({ data: [{ reason: 'bounce' }], error: null });

    const result = await sendMfaDisabledEmail({
      email: 'suppressed@example.com',
      userName: 'User',
      locale: 'en',
    });

    expect(result).toEqual({ success: true, emailId: undefined, suppressed: true });
    expect(mocks.resendSend).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('skipped: email suppressed'),
    );
    expect(mocks.captureUnexpectedError).toHaveBeenCalledTimes(1);
    const [capturedError, context] = mocks.captureUnexpectedError.mock.calls[0] as [
      Error,
      Record<string, unknown>,
    ];
    expect(capturedError.message).toContain('MFA disabled email');
    expect(capturedError.message).toContain('suppressed');
    expect(context).toMatchObject({ feature: 'email' });
  });

  it('非セキュリティ通知（アカウント削除）が suppressed でも Sentry へは送らない', async () => {
    mocks.suppressionLimit.mockResolvedValue({ data: [{ reason: 'complaint' }], error: null });

    const result = await sendAccountDeletionEmail({
      email: 'suppressed@example.com',
      userName: 'User',
      locale: 'en',
    });

    expect(result).toEqual({ success: true, emailId: undefined, suppressed: true });
    expect(mocks.resendSend).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('skipped: email suppressed'),
    );
    expect(mocks.captureUnexpectedError).not.toHaveBeenCalled();
  });
});
