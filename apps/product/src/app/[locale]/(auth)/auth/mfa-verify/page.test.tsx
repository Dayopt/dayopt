import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AuthMFAChallengeTOTPResponse,
  AuthMFAListFactorsResponse,
  AuthMFAVerifyResponse,
  User,
} from '@supabase/auth-js';

import MFAVerifyPage from './page';

// このファイルは container（page.tsx）の state 遷移・API 呼び出し・redirect を検証する。
// disabled 条件・大文字変換など MFAVerifyForm 固有の presentational な詳細は
// MFAVerifyForm.test.tsx の領域であり、ここでは再 assert しない。

let mockSearchParams = new URLSearchParams();

const {
  mockPush,
  mockRefresh,
  mockListFactors,
  mockChallenge,
  mockVerify,
  mockVerifyRecoveryCode,
  mockToastSuccess,
  mockToastError,
  mockCaptureUnexpectedTrpcClientFailure,
  mockCaptureUnexpectedError,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
  mockListFactors: vi.fn(),
  mockChallenge: vi.fn(),
  mockVerify: vi.fn(),
  mockVerifyRecoveryCode: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockCaptureUnexpectedTrpcClientFailure: vi.fn(() => false),
  mockCaptureUnexpectedError: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ locale: 'ja' }),
  useRouter: () => ({
    push: mockPush,
    refresh: mockRefresh,
  }),
  useSearchParams: () => mockSearchParams,
  usePathname: () => '/',
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
  notFound: vi.fn(),
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

vi.mock('@/lib/toast', () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

vi.mock('@/lib/sentry', () => ({
  // 素通し実装: 実際の captureUnexpectedAuthError 判定はここでは検証しない
  observeAuthOperation: (_name: string, fn: () => unknown) => fn(),
  captureUnexpectedError: mockCaptureUnexpectedError,
}));

vi.mock('@/lib/trpc/client-errors', () => ({
  captureUnexpectedTrpcClientFailure: mockCaptureUnexpectedTrpcClientFailure,
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

const mockUser = {
  id: 'user-1',
  app_metadata: {},
  user_metadata: {},
  aud: 'authenticated',
  created_at: '2026-01-01T00:00:00.000Z',
} satisfies User;

// mock 戻り値は satisfies で auth-js の実型に固定し、仮定 mock の形骸化を防ぐ
const verifiedFactorsList = {
  data: {
    all: [VERIFIED_FACTOR],
    totp: [VERIFIED_FACTOR],
    phone: [],
    webauthn: [],
    recovery_code: [],
  },
  error: null,
} satisfies AuthMFAListFactorsResponse;

const emptyFactorsList = {
  data: { all: [], totp: [], phone: [], webauthn: [], recovery_code: [] },
  error: null,
} satisfies AuthMFAListFactorsResponse;

const challengeSuccess = {
  data: { id: 'challenge-1', type: 'totp', expires_at: Math.floor(Date.now() / 1000) + 60 },
  error: null,
} satisfies AuthMFAChallengeTOTPResponse;

const verifySuccess = {
  data: {
    access_token: 'access-token',
    token_type: 'bearer',
    expires_in: 3600,
    refresh_token: 'refresh-token',
    user: mockUser,
  },
  error: null,
} satisfies AuthMFAVerifyResponse;

async function renderAndWaitForInit() {
  render(<MFAVerifyPage />);
  await waitFor(() => expect(mockListFactors).toHaveBeenCalled());
  await waitFor(() => expect(mockChallenge).toHaveBeenCalled());
}

function getOtpInput() {
  return screen.getByLabelText('auth.mfaVerify.verificationCode');
}

// input-otp v1.4.2 は mount 時の setTimeout(0/10/50ms) を unmount で clear しない。
// 環境 teardown 後に発火すると React が window を参照して unhandled error になる
// （CI でのみ顕在化）ため、teardown 前に leak した timer を発火させ切る。
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 60));
});

describe('MFAVerifyPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    mockListFactors.mockResolvedValue(verifiedFactorsList);
    mockChallenge.mockResolvedValue(challengeSuccess);
  });

  describe('初期化', () => {
    it('mount時に検証済みfactorのfactorIdでchallengeを発行する', async () => {
      await renderAndWaitForInit();

      // supabase クライアントが毎レンダー再生成される実装の副作用で checkMFARequired の
      // 参照が変わり続け、listFactors は複数回呼ばれうる（既知の挙動。呼び出し回数の
      // 厳密検証はしない）。ここでは初期化が実行されたことと、正しい factorId で
      // challenge が呼ばれたことだけを確認する。
      expect(mockListFactors).toHaveBeenCalled();
      expect(mockChallenge).toHaveBeenCalledWith({ factorId: 'factor-1' });
    });

    it('検証済みfactorが無い場合、localeのcalendarへ遷移する', async () => {
      mockListFactors.mockResolvedValue(emptyFactorsList);

      render(<MFAVerifyPage />);

      await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/ja/calendar'));
      expect(mockChallenge).not.toHaveBeenCalled();
    });
  });

  describe('TOTP検証', () => {
    it('6桁入力でfactorId・challengeId・codeを渡してverifyする', async () => {
      mockVerify.mockResolvedValue(verifySuccess);
      await renderAndWaitForInit();

      fireEvent.change(getOtpInput(), { target: { value: '123456' } });

      await waitFor(() => {
        expect(mockVerify).toHaveBeenCalledWith({
          factorId: 'factor-1',
          challengeId: 'challenge-1',
          code: '123456',
        });
      });
    });

    it('next未指定時、localeのweekへrefresh後にpushする', async () => {
      mockVerify.mockResolvedValue(verifySuccess);
      await renderAndWaitForInit();

      fireEvent.change(getOtpInput(), { target: { value: '123456' } });

      await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/ja/calendar'));
      expect(mockRefresh).toHaveBeenCalled();
    });

    it('next=安全な相対パス指定時、そのパスへpushする', async () => {
      mockSearchParams = new URLSearchParams('next=/ja/settings');
      mockVerify.mockResolvedValue(verifySuccess);
      await renderAndWaitForInit();

      fireEvent.change(getOtpInput(), { target: { value: '123456' } });

      await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/ja/settings'));
    });

    it('next=外部URL指定時、フォールバック先へpushする（オープンリダイレクト防止）', async () => {
      mockSearchParams = new URLSearchParams('next=https://evil.example');
      mockVerify.mockResolvedValue(verifySuccess);
      await renderAndWaitForInit();

      fireEvent.change(getOtpInput(), { target: { value: '123456' } });

      await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/ja/calendar'));
    });

    it('verify失敗時、エラーメッセージを表示し入力をクリアする', async () => {
      mockVerify.mockResolvedValue({ data: null, error: { message: 'Invalid code' } });
      await renderAndWaitForInit();

      fireEvent.change(getOtpInput(), { target: { value: '123456' } });

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Invalid code');
      });
      expect(getOtpInput()).toHaveValue('');
      expect(mockPush).not.toHaveBeenCalledWith('/ja/calendar');
    });
  });

  describe('リカバリーコード検証', () => {
    it('成功時、mutateを呼びtoast.success後にredirectする', async () => {
      mockVerifyRecoveryCode.mockResolvedValue(undefined);
      await renderAndWaitForInit();

      fireEvent.click(screen.getByRole('button', { name: 'auth.mfaVerify.useRecoveryCode' }));
      fireEvent.change(screen.getByLabelText('auth.mfaVerify.recoveryCodeInput'), {
        target: { value: 'abcd-1234' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'auth.mfaVerify.useRecoveryCodeButton' }));

      await waitFor(() => {
        expect(mockVerifyRecoveryCode).toHaveBeenCalledWith({ code: 'ABCD-1234' });
      });
      expect(mockToastSuccess).toHaveBeenCalledWith('auth.mfaVerify.recoverySuccess');
      await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/ja/calendar'));
      expect(mockRefresh).toHaveBeenCalled();
    });

    it('RECOVERY_INVALIDエラー時、専用のエラーメッセージを表示する', async () => {
      mockVerifyRecoveryCode.mockRejectedValue(new Error('RECOVERY_INVALID'));
      await renderAndWaitForInit();

      fireEvent.click(screen.getByRole('button', { name: 'auth.mfaVerify.useRecoveryCode' }));
      fireEvent.change(screen.getByLabelText('auth.mfaVerify.recoveryCodeInput'), {
        target: { value: 'BAD-CODE' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'auth.mfaVerify.useRecoveryCodeButton' }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('auth.mfaVerify.recoveryInvalid');
      });
      expect(mockToastSuccess).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalledWith('/ja/calendar');
    });

    it('想定外エラー時、genericエラーを表示しSentryへ報告する', async () => {
      mockVerifyRecoveryCode.mockRejectedValue(new Error('network down'));
      await renderAndWaitForInit();

      fireEvent.click(screen.getByRole('button', { name: 'auth.mfaVerify.useRecoveryCode' }));
      fireEvent.change(screen.getByLabelText('auth.mfaVerify.recoveryCodeInput'), {
        target: { value: 'ABCD-1234' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'auth.mfaVerify.useRecoveryCodeButton' }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('common.errors.generic');
      });
      expect(mockCaptureUnexpectedTrpcClientFailure).toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalledWith('/ja/calendar');
    });
  });
});
