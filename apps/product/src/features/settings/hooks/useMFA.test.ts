import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AuthMFAChallengeTOTPResponse,
  AuthMFAEnrollTOTPResponse,
  AuthMFAListFactorsResponse,
  AuthMFAUnenrollResponse,
  AuthMFAVerifyResponse,
  Session,
  User,
} from '@supabase/auth-js';

import { useMFA } from './useMFA';

// next-intl はグローバル setup（src/lib/test/setup-node.ts）で key passthrough 済み。

const {
  mockEnroll,
  mockChallenge,
  mockVerify,
  mockListFactors,
  mockUnenroll,
  mockGetAAL,
  mockGetUser,
  mockGetSession,
  mockRpc,
  mockGenerateAndSaveRecoveryCodesAction,
  mockQRCodeToDataURL,
  mockCaptureUnexpectedAuthError,
  mockCaptureUnexpectedDatabaseError,
  mockCaptureUnexpectedError,
} = vi.hoisted(() => ({
  mockEnroll: vi.fn(),
  mockChallenge: vi.fn(),
  mockVerify: vi.fn(),
  mockListFactors: vi.fn(),
  mockUnenroll: vi.fn(),
  mockGetAAL: vi.fn(),
  mockGetUser: vi.fn(),
  mockGetSession: vi.fn(),
  mockRpc: vi.fn(),
  mockGenerateAndSaveRecoveryCodesAction: vi.fn(),
  mockQRCodeToDataURL: vi.fn(),
  mockCaptureUnexpectedAuthError: vi.fn(),
  mockCaptureUnexpectedDatabaseError: vi.fn(),
  mockCaptureUnexpectedError: vi.fn(),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      mfa: {
        enroll: mockEnroll,
        challenge: mockChallenge,
        verify: mockVerify,
        listFactors: mockListFactors,
        unenroll: mockUnenroll,
        getAuthenticatorAssuranceLevel: mockGetAAL,
      },
      getUser: mockGetUser,
      getSession: mockGetSession,
    },
    rpc: mockRpc,
  }),
}));

vi.mock('@/lib/sentry', () => ({
  // 素通し実装: 実際の分類判定はここでは検証しない
  observeAuthOperation: (_name: string, fn: () => unknown) => fn(),
  captureUnexpectedAuthError: mockCaptureUnexpectedAuthError,
  captureUnexpectedDatabaseError: mockCaptureUnexpectedDatabaseError,
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

vi.mock('qrcode', () => ({
  default: { toDataURL: mockQRCodeToDataURL },
}));

vi.mock('@/features/settings/server/recovery-code-actions', () => ({
  generateAndSaveRecoveryCodesAction: mockGenerateAndSaveRecoveryCodesAction,
}));

const mockUser = {
  id: 'user-1',
  app_metadata: {},
  user_metadata: {},
  aud: 'authenticated',
  created_at: '2026-01-01T00:00:00.000Z',
} satisfies User;

const mockSession = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_in: 3600,
  token_type: 'bearer',
  user: mockUser,
} satisfies Session;

const enrollSuccess = {
  data: {
    id: 'factor-1',
    type: 'totp',
    totp: {
      qr_code: '<svg>qr</svg>',
      secret: 'SECRET123',
      uri: 'otpauth://totp/Dayopt:user@example.com?secret=SECRET123',
    },
  },
  error: null,
} satisfies AuthMFAEnrollTOTPResponse;

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

const emptyFactorsList = {
  data: { all: [], totp: [], phone: [], webauthn: [], recovery_code: [] },
  error: null,
} satisfies AuthMFAListFactorsResponse;

const unenrollSuccess = {
  data: { id: 'factor-1' },
  error: null,
} satisfies AuthMFAUnenrollResponse;

const VERIFIED_FACTOR = {
  id: 'factor-1',
  friendly_name: 'Authenticator App',
  factor_type: 'totp' as const,
  status: 'verified' as const,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

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

const UNVERIFIED_FACTOR = {
  id: 'factor-stale',
  friendly_name: 'Authenticator App',
  factor_type: 'totp' as const,
  status: 'unverified' as const,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

// 未検証 factor は `all` にしか入らない（auth-js の _listFactors は verified だけを
// factor_type 別の配列へ詰める）。fixture もその形に合わせる。
const unverifiedFactorsList = {
  data: {
    all: [UNVERIFIED_FACTOR],
    totp: [],
    phone: [],
    webauthn: [],
    recovery_code: [],
  },
  error: null,
} satisfies AuthMFAListFactorsResponse;

describe('useMFA', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // mount 時の checkMFAStatus が走っても安全なデフォルト
    mockListFactors.mockResolvedValue(emptyFactorsList);
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    mockRpc.mockResolvedValue({ data: 0, error: null });
    mockGetSession.mockResolvedValue({ data: { session: mockSession }, error: null });
    mockGetAAL.mockResolvedValue({
      data: { currentLevel: 'aal2', nextLevel: 'aal2', currentAuthenticationMethods: [] },
      error: null,
    });
    mockQRCodeToDataURL.mockResolvedValue('data:image/png;base64,MOCK');
    mockGenerateAndSaveRecoveryCodesAction.mockResolvedValue({
      codes: ['ABCD-1234', 'EFGH-5678'],
      error: null,
    });
  });

  describe('enrollMFA', () => {
    it('成功時、QRコード・secret・factorIdをセットしshowMFASetupをtrueにする', async () => {
      mockEnroll.mockResolvedValue(enrollSuccess);
      const { result } = renderHook(() => useMFA());

      await act(async () => {
        await result.current.enrollMFA();
      });

      expect(result.current.qrCode).toBe('data:image/png;base64,MOCK');
      expect(result.current.secret).toBe('SECRET123');
      expect(result.current.factorId).toBe('factor-1');
      expect(result.current.showMFASetup).toBe(true);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    // 設定は inline なので、QR を出したまま再読み込み / 離脱すると未検証 factor が残る。
    // 同じ friendly name で enroll し直すと GoTrue が衝突で弾き、MFA を二度と有効化できない。
    it('残っている未検証factorを片付けてから登録する', async () => {
      mockListFactors.mockResolvedValue(unverifiedFactorsList);
      mockUnenroll.mockResolvedValue(unenrollSuccess);
      mockEnroll.mockResolvedValue(enrollSuccess);
      const { result } = renderHook(() => useMFA());

      await act(async () => {
        await result.current.enrollMFA();
      });

      expect(mockUnenroll).toHaveBeenCalledWith({ factorId: 'factor-stale' });
      expect(result.current.showMFASetup).toBe(true);
      expect(result.current.error).toBeNull();
    });

    it('検証済みfactorは消さない', async () => {
      mockListFactors.mockResolvedValue(verifiedFactorsList);
      mockEnroll.mockResolvedValue(enrollSuccess);
      const { result } = renderHook(() => useMFA());

      await act(async () => {
        await result.current.enrollMFA();
      });

      expect(mockUnenroll).not.toHaveBeenCalled();
    });

    it('片付けに失敗しても登録は試みる', async () => {
      mockListFactors.mockResolvedValue(unverifiedFactorsList);
      mockUnenroll.mockResolvedValue({
        data: null,
        error: { message: 'nope', name: 'AuthApiError', status: 500 },
      });
      mockEnroll.mockResolvedValue(enrollSuccess);
      const { result } = renderHook(() => useMFA());

      await act(async () => {
        await result.current.enrollMFA();
      });

      expect(mockEnroll).toHaveBeenCalled();
      expect(result.current.showMFASetup).toBe(true);
    });

    it('失敗時、エラーメッセージをセットしshowMFASetupはfalseのまま', async () => {
      mockEnroll.mockResolvedValue({
        data: null,
        error: { message: 'enroll failed', name: 'AuthApiError', status: 500 },
      });
      const { result } = renderHook(() => useMFA());

      await act(async () => {
        await result.current.enrollMFA();
      });

      expect(result.current.error).toBe('common.errors.mfa.enrollFailed');
      expect(result.current.showMFASetup).toBe(false);
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('verifyMFA', () => {
    it('factorId/verificationCode未設定の場合、enterCodeエラーを表示し何も呼ばない', async () => {
      const { result } = renderHook(() => useMFA());

      await act(async () => {
        await result.current.verifyMFA();
      });

      expect(result.current.error).toBe('common.errors.mfa.enterCode');
      expect(mockChallenge).not.toHaveBeenCalled();
      expect(mockVerify).not.toHaveBeenCalled();
    });

    it('コードが6桁未満の場合、codeLengthエラーを表示する', async () => {
      mockEnroll.mockResolvedValue(enrollSuccess);
      const { result } = renderHook(() => useMFA());
      await act(async () => {
        await result.current.enrollMFA();
      });

      act(() => {
        result.current.setVerificationCode('123');
      });

      await act(async () => {
        await result.current.verifyMFA();
      });

      expect(result.current.error).toBe('common.errors.mfa.codeLength');
      expect(mockChallenge).not.toHaveBeenCalled();
    });

    it('成功時、hasMFAをtrueにしリカバリーコードを生成する', async () => {
      mockEnroll.mockResolvedValue(enrollSuccess);
      mockChallenge.mockResolvedValue(challengeSuccess);
      mockVerify.mockResolvedValue(verifySuccess);
      const { result } = renderHook(() => useMFA());

      await act(async () => {
        await result.current.enrollMFA();
      });
      act(() => {
        result.current.setVerificationCode('123456');
      });

      await act(async () => {
        await result.current.verifyMFA();
      });

      expect(result.current.hasMFA).toBe(true);
      expect(result.current.showMFASetup).toBe(false);
      expect(result.current.verificationCode).toBe('');
      expect(result.current.qrCode).toBeNull();
      expect(result.current.factorId).toBeNull();
      expect(result.current.recoveryCodes).toEqual(['ABCD-1234', 'EFGH-5678']);
      expect(result.current.recoveryCodeCount).toBe(2);
      expect(result.current.error).toBeNull();
    });

    it('verify失敗時、エラーを表示しverificationCodeをクリアする', async () => {
      mockEnroll.mockResolvedValue(enrollSuccess);
      mockChallenge.mockResolvedValue(challengeSuccess);
      mockVerify.mockResolvedValue({
        data: null,
        error: { message: 'invalid code', name: 'AuthApiError', status: 400 },
      });
      const { result } = renderHook(() => useMFA());

      await act(async () => {
        await result.current.enrollMFA();
      });
      act(() => {
        result.current.setVerificationCode('123456');
      });

      await act(async () => {
        await result.current.verifyMFA();
      });

      expect(result.current.error).toBe('common.errors.mfa.verifyFailed');
      expect(result.current.verificationCode).toBe('');
      expect(result.current.hasMFA).toBe(false);
    });
  });

  describe('confirmDisableMFA', () => {
    it('コードが6桁でない場合、enterCodeエラーを表示し無効化APIを呼ばない', async () => {
      const { result } = renderHook(() => useMFA());

      await act(async () => {
        await result.current.confirmDisableMFA('123');
      });

      expect(result.current.error).toBe('common.errors.mfa.enterCode');
      // guard で早期returnするため、無効化フロー固有のAPI（challenge/verify/unenroll）は呼ばれない
      expect(mockChallenge).not.toHaveBeenCalled();
      expect(mockVerify).not.toHaveBeenCalled();
      expect(mockUnenroll).not.toHaveBeenCalled();
    });

    it('成功時、hasMFAをfalseにしダイアログを閉じる', async () => {
      // unenroll成功後の checkMFAStatus 再実行が現実的な状態（factor消失）を反映するよう、
      // unenroll成功をトリガーに listFactors の返り値を切り替える
      let factorRemoved = false;
      mockListFactors.mockImplementation(async () =>
        factorRemoved ? emptyFactorsList : verifiedFactorsList,
      );
      mockChallenge.mockResolvedValue(challengeSuccess);
      mockVerify.mockResolvedValue(verifySuccess);
      mockUnenroll.mockImplementation(async () => {
        factorRemoved = true;
        return unenrollSuccess;
      });
      const { result } = renderHook(() => useMFA());
      await waitFor(() => expect(mockListFactors).toHaveBeenCalled());

      await act(async () => {
        await result.current.confirmDisableMFA('123456');
      });

      expect(mockUnenroll).toHaveBeenCalledWith({ factorId: 'factor-1' });
      expect(result.current.hasMFA).toBe(false);
      expect(result.current.showDisableDialog).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('verify失敗時、codeInvalidエラーを表示しhasMFAは変えない', async () => {
      mockListFactors.mockResolvedValue(verifiedFactorsList);
      mockChallenge.mockResolvedValue(challengeSuccess);
      mockVerify.mockResolvedValue({
        data: null,
        error: { message: 'invalid code', name: 'AuthApiError', status: 400 },
      });
      const { result } = renderHook(() => useMFA());
      await waitFor(() => expect(mockListFactors).toHaveBeenCalled());

      await act(async () => {
        await result.current.confirmDisableMFA('999999');
      });

      expect(result.current.error).toBe('common.errors.mfa.codeInvalid');
      expect(mockUnenroll).not.toHaveBeenCalled();
    });
  });

  describe('confirmRegenerateRecoveryCodes', () => {
    it('成功時、recoveryCodesを更新し成功メッセージを表示する', async () => {
      mockGenerateAndSaveRecoveryCodesAction.mockResolvedValue({
        codes: ['WXYZ-9999'],
        error: null,
      });
      const { result } = renderHook(() => useMFA());

      await act(async () => {
        await result.current.confirmRegenerateRecoveryCodes();
      });

      expect(result.current.recoveryCodes).toEqual(['WXYZ-9999']);
      expect(result.current.recoveryCodeCount).toBe(1);
      expect(result.current.showRegenerateDialog).toBe(false);
      expect(result.current.success).toBe('settings.account.mfa.recoveryCodes.regenerateSuccess');
    });
  });

  describe('cancelSetup', () => {
    it('未検証factorのunenrollを呼び、setup状態をリセットする', async () => {
      mockEnroll.mockResolvedValue(enrollSuccess);
      mockUnenroll.mockResolvedValue(unenrollSuccess);
      const { result } = renderHook(() => useMFA());

      await act(async () => {
        await result.current.enrollMFA();
      });

      await act(async () => {
        await result.current.cancelSetup();
      });

      expect(mockUnenroll).toHaveBeenCalledWith({ factorId: 'factor-1' });
      expect(result.current.showMFASetup).toBe(false);
      expect(result.current.qrCode).toBeNull();
      expect(result.current.secret).toBeNull();
      expect(result.current.factorId).toBeNull();
      expect(result.current.verificationCode).toBe('');
    });
  });

  describe('dismissRecoveryCodes', () => {
    it('recoveryCodesをnullに戻す', async () => {
      mockGenerateAndSaveRecoveryCodesAction.mockResolvedValue({
        codes: ['ABCD-1234'],
        error: null,
      });
      const { result } = renderHook(() => useMFA());

      await act(async () => {
        await result.current.confirmRegenerateRecoveryCodes();
      });
      expect(result.current.recoveryCodes).toEqual(['ABCD-1234']);

      act(() => {
        result.current.dismissRecoveryCodes();
      });

      expect(result.current.recoveryCodes).toBeNull();
    });
  });
});
