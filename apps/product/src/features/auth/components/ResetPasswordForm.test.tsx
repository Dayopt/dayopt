import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ResetPasswordForm } from './ResetPasswordForm';

const mockUpdatePassword = vi.fn();
const mockPush = vi.fn();

const {
  mockListFactors,
  mockChallenge,
  mockVerify,
  mockVerifyRecoveryCode,
  mockCaptureUnexpectedTrpcClientFailure,
  mockCaptureUnexpectedError,
} = vi.hoisted(() => ({
  mockListFactors: vi.fn(),
  mockChallenge: vi.fn(),
  mockVerify: vi.fn(),
  mockVerifyRecoveryCode: vi.fn(),
  mockCaptureUnexpectedTrpcClientFailure: vi.fn(() => false),
  mockCaptureUnexpectedError: vi.fn(),
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ locale: 'ja' }),
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@dayopt/i18n/navigation', async () => {
  const React = await import('react');
  return {
    Link: ({ children, href, ...props }: { children: React.ReactNode; href: string }) =>
      React.createElement('a', { href, ...props }, children),
  };
});

vi.mock('../stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { updatePassword: typeof mockUpdatePassword }) => unknown) =>
    selector({ updatePassword: mockUpdatePassword }),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      mfa: {
        listFactors: mockListFactors,
        challenge: mockChallenge,
        verify: mockVerify,
      },
    },
  }),
}));

vi.mock('@/lib/trpc/client', () => ({
  vanillaTrpc: {
    user: {
      verifyRecoveryCode: {
        mutate: mockVerifyRecoveryCode,
      },
    },
  },
}));

vi.mock('@/lib/trpc/client-errors', () => ({
  captureUnexpectedTrpcClientFailure: mockCaptureUnexpectedTrpcClientFailure,
}));

vi.mock('@/lib/sentry', () => ({
  // 素通し実装: 実際の captureUnexpectedAuthError 判定はここでは検証しない
  observeAuthOperation: (_name: string, fn: () => unknown) => fn(),
  captureUnexpectedError: mockCaptureUnexpectedError,
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const VERIFIED_FACTOR = {
  id: 'factor-1',
  friendly_name: 'Authenticator App',
  factor_type: 'totp' as const,
  status: 'verified' as const,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const verifiedFactorsList = {
  data: { all: [VERIFIED_FACTOR], totp: [VERIFIED_FACTOR], phone: [], webauthn: [] },
  error: null,
};

const challengeSuccess = {
  data: { id: 'challenge-1', type: 'totp', expires_at: Math.floor(Date.now() / 1000) + 60 },
  error: null,
};

function renderForm() {
  return render(<ResetPasswordForm />);
}

async function submitValidPassword() {
  const user = userEvent.setup();
  renderForm();

  await user.type(screen.getByLabelText('auth.resetPasswordForm.newPassword'), 'NewPassw0rd!23');
  await user.type(
    screen.getByLabelText('auth.resetPasswordForm.confirmPassword'),
    'NewPassw0rd!23',
  );
  await user.click(screen.getByRole('button', { name: 'auth.resetPasswordForm.updateButton' }));
  return user;
}

// input-otp v1.4.2 は mount 時の setTimeout(0/10/50ms) を unmount で clear しない。
// 環境 teardown 後に発火すると React が window を参照して unhandled error になる
// （CI でのみ顕在化）ため、teardown 前に leak した timer を発火させ切る。
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 60));
});

describe('ResetPasswordForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListFactors.mockResolvedValue(verifiedFactorsList);
    mockChallenge.mockResolvedValue(challengeSuccess);
  });

  // #1928: 通過側。recovery session からの正常な更新は従来どおり成功画面へ遷移する。
  it('通常の recovery session からの更新は成功画面へ遷移する', async () => {
    mockUpdatePassword.mockResolvedValue({ data: { user: null }, error: null });

    await submitValidPassword();

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
        'auth.resetPasswordForm.successTitle',
      );
    });
    // MFA を無効化していないので警告は出ない
    expect(screen.queryByText('auth.resetPasswordForm.mfaDisabledWarning')).not.toBeInTheDocument();
  });

  // ブロック側: recovery session でないセッション（直接アクセス等）で current_password_required
  // が返った場合は、セッション再取得を促すメッセージを出す。
  it.each([
    'current_password_required',
    'current_password_invalid',
    'invalid_credentials',
    'reauthentication_needed',
  ])('%s はセッション再取得を促すメッセージを表示する', async (code) => {
    mockUpdatePassword.mockResolvedValue({
      data: { user: null },
      error: Object.assign(new Error('rejected'), { code }),
    });

    await submitValidPassword();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('auth.errors.recoverySessionInvalid');
    });
  });

  // 既存挙動の固定: 構造化 code を持たない・未知の code のエラーは従来どおり
  // getAuthErrorKey の汎用判定（message の weak/short 判定）にフォールバックする。
  it('未知の code は従来どおり汎用エラー判定にフォールバックする', async () => {
    mockUpdatePassword.mockResolvedValue({
      data: { user: null },
      error: new Error('some unexpected failure'),
    });

    await submitValidPassword();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('auth.errors.unexpectedError');
    });
  });

  // #2013: MFA(TOTP) 有効アカウントの recovery session は insufficient_aal で拒否される。
  // 汎用の「時間をおいて再試行」ではなく、自己復旧できる MFA step-up 画面へ遷移する。
  describe('insufficient_aal（#2013 MFA step-up）', () => {
    function mockInsufficientAal() {
      mockUpdatePassword.mockResolvedValueOnce({
        data: { user: null },
        error: Object.assign(new Error('AAL2 session is required'), { code: 'insufficient_aal' }),
      });
    }

    it('insufficient_aal では汎用エラーではなくMFA step-up画面へ遷移する', async () => {
      mockInsufficientAal();

      await submitValidPassword();

      await waitFor(() => {
        expect(mockListFactors).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(mockChallenge).toHaveBeenCalledWith({ factorId: 'factor-1' });
      });
      // password 入力フォームには戻らず、MFAVerifyForm（passwordReset flow）が出る。
      // MFAVerifyForm は next/dynamic の遅延ロード（#2121）のため、このファイル内で
      // 最初に mount される時だけ import() の非同期解決を待つ必要がある
      expect(
        await screen.findByRole('link', { name: 'auth.mfaVerify.backToPasswordReset' }),
      ).toBeInTheDocument();
      expect(screen.queryByText('auth.errors.recoveryMfaBlocked')).not.toBeInTheDocument();
    });

    it('MFA step-upの初期化に失敗したら（listFactorsエラー）、MFA画面に詰めずpassword入力画面へ戻す', async () => {
      mockInsufficientAal();
      mockListFactors.mockResolvedValueOnce({
        data: null,
        error: new Error('network error'),
      });

      await submitValidPassword();

      await waitFor(() => {
        expect(mockListFactors).toHaveBeenCalled();
      });
      // challengeまでは進まず、MFA画面（backToPasswordReset）に留まらない
      expect(mockChallenge).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'auth.resetPasswordForm.updateButton' }),
        ).toBeInTheDocument();
      });
      expect(
        screen.queryByRole('link', { name: 'auth.mfaVerify.backToPasswordReset' }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent('auth.errors.unexpectedError');
    });

    it('TOTPコード検証成功後、保持していたpasswordでupdatePasswordを再実行し成功画面へ遷移する', async () => {
      mockInsufficientAal();
      mockVerify.mockResolvedValue({
        data: {
          access_token: 'elevated-token',
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'refresh',
          user: { id: 'user-1' },
        },
        error: null,
      });
      // 昇格後の再試行は成功する
      mockUpdatePassword.mockResolvedValueOnce({ data: { user: null }, error: null });

      const user = await submitValidPassword();
      await waitFor(() => expect(mockChallenge).toHaveBeenCalled());

      // MFAVerifyForm は next/dynamic の遅延ロード（#2121）のため findBy で解決を待つ
      const otpInput = await screen.findByLabelText('auth.mfaVerify.verificationCode');
      await user.type(otpInput, '123456');

      await waitFor(() => {
        expect(mockVerify).toHaveBeenCalledWith({
          factorId: 'factor-1',
          challengeId: 'challenge-1',
          code: '123456',
        });
      });
      await waitFor(() => {
        expect(mockUpdatePassword).toHaveBeenCalledTimes(2);
      });
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
          'auth.resetPasswordForm.successTitle',
        );
      });
      // TOTP step-up は MFA を無効化しないので警告は出ない
      expect(
        screen.queryByText('auth.resetPasswordForm.mfaDisabledWarning'),
      ).not.toBeInTheDocument();
    });

    it('リカバリーコード検証成功後、MFA無効化の警告つき成功画面へ遷移する', async () => {
      mockInsufficientAal();
      mockVerifyRecoveryCode.mockResolvedValue({ success: true, remainingCodes: 0 });
      mockUpdatePassword.mockResolvedValueOnce({ data: { user: null }, error: null });

      const user = await submitValidPassword();
      await waitFor(() => expect(mockChallenge).toHaveBeenCalled());

      // MFAVerifyForm は next/dynamic の遅延ロード（#2121）のため findBy で解決を待つ
      await user.click(
        await screen.findByRole('button', { name: 'auth.mfaVerify.useRecoveryCode' }),
      );
      const recoveryInput = screen.getByLabelText('auth.mfaVerify.recoveryCodeInput');
      await user.type(recoveryInput, 'abcd-1234');
      await user.click(
        screen.getByRole('button', { name: 'auth.mfaVerify.useRecoveryCodeButton' }),
      );

      await waitFor(() => {
        expect(mockVerifyRecoveryCode).toHaveBeenCalledWith({ code: 'ABCD-1234' });
      });
      await waitFor(() => {
        expect(mockUpdatePassword).toHaveBeenCalledTimes(2);
      });
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
          'auth.resetPasswordForm.successTitle',
        );
      });
      expect(screen.getByText('auth.resetPasswordForm.mfaDisabledWarning')).toBeInTheDocument();
    });

    // MFA検証（TOTP challenge / リカバリーコード）はどちらも使い切りで、失敗後の
    // リトライができない。step-up自体は成功したのにupdatePasswordだけ失敗した場合、
    // MFA画面に留めると詰む（特にリカバリーコード経路はコード消費+MFA削除済みで
    // パスワードだけ変わらない状態になる）。password入力画面へ戻し、再送信で
    // 完了できることを固定する
    it('TOTP検証成功後にupdatePasswordが失敗したら、password入力画面へ戻り再送信で完了できる', async () => {
      mockInsufficientAal();
      mockVerify.mockResolvedValue({
        data: {
          access_token: 'elevated-token',
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'refresh',
          user: { id: 'user-1' },
        },
        error: null,
      });
      // 1回目のupdatePassword（MFA検証直後）は失敗、2回目（password画面からの再送信）は成功
      mockUpdatePassword
        .mockResolvedValueOnce({
          data: { user: null },
          error: new Error('network error'),
        })
        .mockResolvedValueOnce({ data: { user: null }, error: null });

      const user = await submitValidPassword();
      await waitFor(() => expect(mockChallenge).toHaveBeenCalled());

      // MFAVerifyForm は next/dynamic の遅延ロード（#2121）のため findBy で解決を待つ
      const otpInput = await screen.findByLabelText('auth.mfaVerify.verificationCode');
      await user.type(otpInput, '123456');

      await waitFor(() => expect(mockUpdatePassword).toHaveBeenCalledTimes(2));

      // MFA画面に留まらず、password入力画面へ戻ってエラーを表示する
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'auth.resetPasswordForm.updateButton' }),
        ).toBeInTheDocument();
      });
      expect(screen.getByRole('alert')).toHaveTextContent('auth.errors.unexpectedError');
      expect(
        screen.queryByRole('link', { name: 'auth.mfaVerify.backToPasswordReset' }),
      ).not.toBeInTheDocument();

      // 再送信するとMFAを経由せずそのまま成功する（セッションは既に aal2 昇格済みのため）
      await user.click(screen.getByRole('button', { name: 'auth.resetPasswordForm.updateButton' }));

      await waitFor(() => expect(mockUpdatePassword).toHaveBeenCalledTimes(3));
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
          'auth.resetPasswordForm.successTitle',
        );
      });
      // TOTP経路はMFAを無効化していないので警告は出ない
      expect(
        screen.queryByText('auth.resetPasswordForm.mfaDisabledWarning'),
      ).not.toBeInTheDocument();
    });

    it('リカバリーコード検証成功後にupdatePasswordが失敗しても、再送信の成功画面でMFA無効化警告が出る', async () => {
      mockInsufficientAal();
      mockVerifyRecoveryCode.mockResolvedValue({ success: true, remainingCodes: 0 });
      mockUpdatePassword
        .mockResolvedValueOnce({
          data: { user: null },
          error: new Error('network error'),
        })
        .mockResolvedValueOnce({ data: { user: null }, error: null });

      const user = await submitValidPassword();
      await waitFor(() => expect(mockChallenge).toHaveBeenCalled());

      // MFAVerifyForm は next/dynamic の遅延ロード（#2121）のため findBy で解決を待つ
      await user.click(
        await screen.findByRole('button', { name: 'auth.mfaVerify.useRecoveryCode' }),
      );
      const recoveryInput = screen.getByLabelText('auth.mfaVerify.recoveryCodeInput');
      await user.type(recoveryInput, 'ABCD-1234');
      await user.click(
        screen.getByRole('button', { name: 'auth.mfaVerify.useRecoveryCodeButton' }),
      );

      await waitFor(() => expect(mockUpdatePassword).toHaveBeenCalledTimes(2));
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'auth.resetPasswordForm.updateButton' }),
        ).toBeInTheDocument();
      });

      // リカバリーコードは既に消費済み・MFAは既に無効化済み。password画面から
      // 再送信するだけで完了できる（MFA検証をやり直す必要がない）
      await user.click(screen.getByRole('button', { name: 'auth.resetPasswordForm.updateButton' }));

      await waitFor(() => expect(mockUpdatePassword).toHaveBeenCalledTimes(3));
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
          'auth.resetPasswordForm.successTitle',
        );
      });
      // フォールバック経由でもMFA無効化の事実は失われない
      expect(screen.getByText('auth.resetPasswordForm.mfaDisabledWarning')).toBeInTheDocument();
    });

    it('リカバリーコード枯渇時はrecoveryExhaustedの案内を出す', async () => {
      mockInsufficientAal();
      mockVerifyRecoveryCode.mockRejectedValue(new Error('RECOVERY_EXHAUSTED'));

      const user = await submitValidPassword();
      await waitFor(() => expect(mockChallenge).toHaveBeenCalled());

      // MFAVerifyForm は next/dynamic の遅延ロード（#2121）のため findBy で解決を待つ
      await user.click(
        await screen.findByRole('button', { name: 'auth.mfaVerify.useRecoveryCode' }),
      );
      const recoveryInput = screen.getByLabelText('auth.mfaVerify.recoveryCodeInput');
      await user.type(recoveryInput, 'ABCD-1234');
      await user.click(
        screen.getByRole('button', { name: 'auth.mfaVerify.useRecoveryCodeButton' }),
      );

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('auth.mfaVerify.recoveryExhausted');
      });
      // 枯渇時は password の再試行を行わない
      expect(mockUpdatePassword).toHaveBeenCalledTimes(1);
    });

    it('renews an expired TOTP challenge and completes with the replacement', async () => {
      mockInsufficientAal();
      mockUpdatePassword.mockResolvedValueOnce({ data: { user: null }, error: null });
      mockChallenge.mockResolvedValueOnce(challengeSuccess).mockResolvedValueOnce({
        data: {
          id: 'challenge-fresh',
          type: 'totp',
          expires_at: Math.floor(Date.now() / 1000) + 60,
        },
        error: null,
      });
      mockVerify
        .mockResolvedValueOnce({
          data: null,
          error: Object.assign(new Error('Provider expiry text'), {
            code: 'mfa_challenge_expired',
          }),
        })
        .mockResolvedValueOnce({ data: {}, error: null });
      const user = await submitValidPassword();
      await user.type(await screen.findByLabelText('auth.mfaVerify.verificationCode'), '123456');
      await waitFor(() =>
        expect(mockVerify).toHaveBeenCalledWith({
          factorId: 'factor-1',
          challengeId: 'challenge-1',
          code: '123456',
        }),
      );
      await waitFor(() => expect(mockChallenge).toHaveBeenCalledTimes(2));
      expect(screen.getByRole('alert')).toHaveTextContent('common.errors.mfa.challengeExpired');
      await user.type(screen.getByLabelText('auth.mfaVerify.verificationCode'), '654321');
      await waitFor(() =>
        expect(mockVerify).toHaveBeenLastCalledWith({
          factorId: 'factor-1',
          challengeId: 'challenge-fresh',
          code: '654321',
        }),
      );
      expect(await screen.findByText('auth.resetPasswordForm.successTitle')).toBeInTheDocument();
      expect(mockUpdatePassword).toHaveBeenCalledTimes(2);
    });

    it('does not renew a challenge for an incorrect TOTP code', async () => {
      mockInsufficientAal();
      mockVerify.mockResolvedValueOnce({
        data: null,
        error: Object.assign(new Error('Provider invalid text'), {
          code: 'mfa_verification_failed',
        }),
      });
      const user = await submitValidPassword();
      await user.type(await screen.findByLabelText('auth.mfaVerify.verificationCode'), '123456');
      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent('common.errors.mfa.codeInvalid'),
      );
      expect(mockVerify).toHaveBeenCalledTimes(1);
      expect(mockChallenge).toHaveBeenCalledTimes(1);
      expect(mockUpdatePassword).toHaveBeenCalledTimes(1);
    });

    it.each(['returned error', 'throw'] as const)(
      'recovers from challenge renewal %s without reusing the expired ID',
      async (failureMode) => {
        mockInsufficientAal();
        mockInsufficientAal();
        mockUpdatePassword.mockResolvedValueOnce({ data: { user: null }, error: null });
        mockChallenge.mockResolvedValueOnce(challengeSuccess);
        if (failureMode === 'throw')
          mockChallenge.mockRejectedValueOnce(new Error('renewal unavailable'));
        else
          mockChallenge.mockResolvedValueOnce({
            data: null,
            error: new Error('renewal unavailable'),
          });
        mockChallenge.mockResolvedValueOnce({
          data: {
            id: 'challenge-retry',
            type: 'totp',
            expires_at: Math.floor(Date.now() / 1000) + 60,
          },
          error: null,
        });
        mockVerify
          .mockResolvedValueOnce({
            data: null,
            error: Object.assign(new Error('Provider expiry text'), {
              code: 'mfa_challenge_expired',
            }),
          })
          .mockResolvedValueOnce({ data: {}, error: null });
        const user = await submitValidPassword();
        await user.type(await screen.findByLabelText('auth.mfaVerify.verificationCode'), '123456');
        const retryButton = await screen.findByRole('button', {
          name: 'auth.resetPasswordForm.updateButton',
        });
        expect(mockChallenge).toHaveBeenCalledTimes(2);
        expect(mockVerify).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('alert')).toHaveTextContent('auth.errors.unexpectedError');
        await user.click(retryButton);
        await user.type(await screen.findByLabelText('auth.mfaVerify.verificationCode'), '654321');
        await waitFor(() =>
          expect(mockVerify).toHaveBeenLastCalledWith({
            factorId: 'factor-1',
            challengeId: 'challenge-retry',
            code: '654321',
          }),
        );
        expect(await screen.findByText('auth.resetPasswordForm.successTitle')).toBeInTheDocument();
        expect(mockUpdatePassword).toHaveBeenCalledTimes(3);
      },
    );
  });
});
