import { beforeEach, describe, expect, it, vi } from 'vitest';

import { publicRecordSelect, publicUserSettingsSelect } from '@/lib/database';
import { createChainableMock } from '@/lib/test/trpc-test-helpers';

const deleteUser = vi.hoisted(() => vi.fn());
// 再認証は service-role 経由の専用モジュールへ移した（#1925）。ここでは契約だけを固定し、
// 迂回そのものの挙動は password-reauthentication.test.ts が担う
const verifyPasswordWithCaptchaBypass = vi.hoisted(() => vi.fn());
// rate limit の enforcement 自体も password-reauthentication.test.ts が担う。
// ここでは deleteAccount / requestEmailChange が「呼ぶこと」「順序」「context」だけを固定する
const enforceReauthRateLimit = vi.hoisted(() => vi.fn());
const beforeIdentityDeletion = vi.hoisted(() => vi.fn());
const loggerInfo = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());
const adminFrom = vi.hoisted(() => vi.fn());
const captureUnexpectedError = vi.hoisted(() => vi.fn());
const captureUnexpectedDatabaseError = vi.hoisted(() => vi.fn());
const sendAccountDeletionEmail = vi.hoisted(() => vi.fn());
const getUserLocale = vi.hoisted(() => vi.fn());
// spy 化して context 引数（例: requestEmailChange の { feature: 'email_change' }）を
// 検証できるようにしつつ、pass-through 動作は維持する（他 caller の挙動は変えない）
const observeAuthOperation = vi.hoisted(() =>
  vi.fn(async (_operation: string, call: () => PromiseLike<unknown>) => call()),
);

vi.mock('@/lib/email/notifications', () => ({ sendAccountDeletionEmail, getUserLocale }));

vi.mock('@/lib/supabase/oauth', () => ({
  createServiceRoleClient: () => ({ auth: { admin: { deleteUser } }, from: adminFrom }),
}));
vi.mock('./password-reauthentication', () => ({
  verifyPasswordWithCaptchaBypass,
  enforceReauthRateLimit,
}));
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://app.example.test' }));
vi.mock('@/lib/logger', () => ({
  logger: { info: loggerInfo, warn: loggerWarn },
}));
// isExpectedAuthError は実装をそのまま使う（requestEmailChange の allowlist 判定が
// 実際の EXPECTED_AUTH_ERROR_CODES と正しく組み合わさることを検証するため。#2064）
vi.mock('@/lib/sentry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sentry')>();
  return {
    ...actual,
    captureUnexpectedDatabaseError,
    captureUnexpectedError,
    observeAuthOperation,
  };
});

import { createUserService } from './user-service';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const USER_EMAIL = 'user@example.com';

type QueryResult = {
  data?: unknown;
  error?: { message: string; code?: string } | null;
};

function createSupabase(options?: {
  tables?: Record<string, QueryResult>;
  signInError?: { message: string } | null;
  files?: Array<{ name: string }> | null;
  storageError?: Error;
  /** MFA factor 一覧。省略時は factor 無し */
  totpFactors?: Array<{ id: string; status: string }>;
  listFactorsError?: { message: string } | null;
  verifyTotpError?: { message: string } | null;
  updateUserError?: { message: string; code?: string; status?: number } | null;
}) {
  const queries = new Map(
    Object.entries(options?.tables ?? {}).map(([table, result]) => [
      table,
      createChainableMock(result.data ?? null, result.error ?? null),
    ]),
  );
  const from = vi.fn((table: string) => {
    const query = queries.get(table) ?? createChainableMock([], null);
    queries.set(table, query);
    return query;
  });
  const signInWithPassword = vi.fn().mockResolvedValue({
    data: { user: null, session: null },
    error: options?.signInError ?? null,
  });
  const list = options?.storageError
    ? vi.fn().mockRejectedValue(options.storageError)
    : vi.fn().mockResolvedValue({ data: options?.files ?? [], error: null });
  const remove = vi.fn().mockResolvedValue({ data: [], error: null });

  const listFactors = vi.fn().mockResolvedValue({
    data: { totp: options?.totpFactors ?? [] },
    error: options?.listFactorsError ?? null,
  });
  const challengeAndVerify = vi.fn().mockResolvedValue({
    data: null,
    error: options?.verifyTotpError ?? null,
  });
  const updateUser = vi.fn().mockResolvedValue({
    data: {},
    error: options?.updateUserError ?? null,
  });

  return {
    service: createUserService(
      {
        from,
        auth: { signInWithPassword, mfa: { listFactors, challengeAndVerify }, updateUser },
        storage: { from: vi.fn(() => ({ list, remove })) },
      } as never,
      { beforeIdentityDeletion },
    ),
    from,
    list,
    remove,
    signInWithPassword,
    listFactors,
    challengeAndVerify,
    updateUser,
    query: (table: string) => queries.get(table)!,
  };
}

function mockAdminTables(tables: Record<string, QueryResult>) {
  const queries = new Map(
    Object.entries(tables).map(([table, result]) => [
      table,
      createChainableMock(result.data ?? null, result.error ?? null),
    ]),
  );
  adminFrom.mockImplementation((table: string) => {
    const query = queries.get(table) ?? createChainableMock([], null);
    queries.set(table, query);
    return query;
  });
  return queries;
}

function deleteOptions(
  overrides?: Partial<{
    password: string;
    totpCode: string;
    requiresPassword: boolean;
    confirmText: string;
  }>,
) {
  return {
    userId: USER_ID,
    userEmail: USER_EMAIL,
    userName: 'Tomoya',
    password: 'correct-password',
    requiresPassword: true,
    confirmText: 'DELETE',
    ...overrides,
  };
}

/** Google のみで登録したユーザー（パスワードを持たない） */
function googleUserDeleteOptions(overrides?: Partial<{ totpCode: string; confirmText: string }>) {
  return {
    userId: USER_ID,
    userEmail: USER_EMAIL,
    userName: 'Tomoya',
    requiresPassword: false,
    confirmText: 'DELETE',
    ...overrides,
  };
}

const NEW_EMAIL = 'new@example.com';

function requestEmailChangeOptions(
  overrides?: Partial<{
    userId: string;
    currentEmail: string;
    newEmail: string;
    password: string;
  }>,
) {
  return {
    userId: USER_ID,
    currentEmail: USER_EMAIL,
    newEmail: NEW_EMAIL,
    password: 'correct-password',
    ...overrides,
  };
}

describe('createUserService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyPasswordWithCaptchaBypass.mockResolvedValue({ outcome: 'verified' });
    beforeIdentityDeletion.mockResolvedValue({ status: 'completed' });
    sendAccountDeletionEmail.mockResolvedValue({ success: true });
    getUserLocale.mockResolvedValue('ja');
    deleteUser.mockResolvedValue({ data: {}, error: null });
    adminFrom.mockImplementation(() => createChainableMock([], null));
    captureUnexpectedDatabaseError.mockImplementation((error: unknown) =>
      error instanceof Error ? error : new Error('Unexpected database failure', { cause: error }),
    );
  });

  describe('deleteAccount', () => {
    it('パスワードを持つユーザーでpasswordが空ならINVALID_INPUTを投げる', async () => {
      const { service } = createSupabase();

      await expect(service.deleteAccount(deleteOptions({ password: '' }))).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      expect(verifyPasswordWithCaptchaBypass).not.toHaveBeenCalled();
    });

    it('確認文字列がDELETEでなければINVALID_INPUTを投げる', async () => {
      const { service } = createSupabase();

      await expect(
        service.deleteAccount(deleteOptions({ confirmText: 'delete' })),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    // email 変更（'email_change'）とは別 bucket を使う（password-reauthentication.test.ts の
    // context 分離テストと対）。ここでは deleteAccount 側が正しい context を渡すことだけ固定する
    it('verifyPasswordWithCaptchaBypassの直前にaccount_deletion contextでrate limitを強制する', async () => {
      const { service } = createSupabase();

      await service.deleteAccount(deleteOptions());

      expect(enforceReauthRateLimit).toHaveBeenCalledWith(USER_ID, 'account_deletion');
      expect(verifyPasswordWithCaptchaBypass).toHaveBeenCalledWith({
        email: USER_EMAIL,
        password: 'correct-password',
        context: 'account_deletion',
      });
      const [rateLimitOrder] = enforceReauthRateLimit.mock.invocationCallOrder;
      const [verifyOrder] = verifyPasswordWithCaptchaBypass.mock.invocationCallOrder;
      expect(rateLimitOrder).toBeLessThan(verifyOrder!);
    });

    it('パスワードが違えばINVALID_PASSWORDを投げる', async () => {
      verifyPasswordWithCaptchaBypass.mockResolvedValue({ outcome: 'invalid_password' });
      const { service } = createSupabase();

      await expect(service.deleteAccount(deleteOptions())).rejects.toMatchObject({
        code: 'INVALID_PASSWORD',
      });
      expect(deleteUser).not.toHaveBeenCalled();
    });

    // 迂回が壊れた時に「パスワードが違います」と誤って伝えない。削除も通さない（fail closed）
    it('再認証手段が使えなければREAUTH_UNAVAILABLEを投げて削除しない', async () => {
      verifyPasswordWithCaptchaBypass.mockResolvedValue({ outcome: 'unavailable' });
      const { service } = createSupabase();

      await expect(service.deleteAccount(deleteOptions())).rejects.toMatchObject({
        code: 'REAUTH_UNAVAILABLE',
      });
      expect(deleteUser).not.toHaveBeenCalled();
    });

    it('外部データの準備を完了してからauth userを削除する', async () => {
      const { service } = createSupabase();

      await expect(service.deleteAccount(deleteOptions())).resolves.toEqual({ success: true });
      expect(beforeIdentityDeletion).toHaveBeenCalledWith({ userId: USER_ID });
      expect(deleteUser).toHaveBeenCalledWith(USER_ID);
    });

    it('外部データの準備失敗時はfail closedでaccount削除を止める', async () => {
      beforeIdentityDeletion.mockRejectedValueOnce(new Error('external cleanup unavailable'));
      const { service } = createSupabase();

      await expect(service.deleteAccount(deleteOptions())).rejects.toMatchObject({
        code: 'DELETE_FAILED',
        message: 'Failed to prepare account deletion',
      });
      expect(captureUnexpectedError).toHaveBeenCalledOnce();
      expect(deleteUser).not.toHaveBeenCalled();
    });

    it('外部データの準備が競合中なら再試行可能なCONFLICTにする', async () => {
      beforeIdentityDeletion.mockResolvedValueOnce({ status: 'contention' });
      const { service } = createSupabase();

      await expect(service.deleteAccount(deleteOptions())).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(deleteUser).not.toHaveBeenCalled();
    });

    it('削除が確定してから通知メールを送る', async () => {
      const { service } = createSupabase();

      await service.deleteAccount(deleteOptions());

      expect(sendAccountDeletionEmail).toHaveBeenCalledWith({
        email: USER_EMAIL,
        userName: 'Tomoya',
        locale: 'ja',
      });
      // 本文が「削除されました」と完了を伝えるため、削除の後に送る必要がある
      const [deleteOrder] = deleteUser.mock.invocationCallOrder;
      const [emailOrder] = sendAccountDeletionEmail.mock.invocationCallOrder;
      expect(deleteOrder).toBeDefined();
      expect(emailOrder).toBeGreaterThan(deleteOrder!);
    });

    it('削除が中断されたら通知メールを送らない（誤報を出さない）', async () => {
      beforeIdentityDeletion.mockRejectedValueOnce(new Error('cleanup unavailable'));
      const { service } = createSupabase();

      await expect(service.deleteAccount(deleteOptions())).rejects.toMatchObject({
        code: 'DELETE_FAILED',
      });
      expect(sendAccountDeletionEmail).not.toHaveBeenCalled();
    });

    it('locale が引けなくても既定言語で送って削除を続ける', async () => {
      getUserLocale.mockRejectedValueOnce(new Error('user_settings unavailable'));
      const { service } = createSupabase();

      await expect(service.deleteAccount(deleteOptions())).resolves.toEqual({ success: true });
      expect(sendAccountDeletionEmail).toHaveBeenCalledWith(
        expect.objectContaining({ locale: 'en' }),
      );
    });

    it('通知メールの送信失敗では削除を止めない（削除要求を優先する）', async () => {
      sendAccountDeletionEmail.mockRejectedValueOnce(new Error('resend down'));
      const { service } = createSupabase();

      await expect(service.deleteAccount(deleteOptions())).resolves.toEqual({ success: true });
      expect(captureUnexpectedError).toHaveBeenCalledOnce();
      expect(deleteUser).toHaveBeenCalledWith(USER_ID);
    });

    describe('パスワードを持たないユーザー（Google のみ）', () => {
      it('MFA が無ければ確認テキストだけで削除できる', async () => {
        const { service } = createSupabase();

        await expect(service.deleteAccount(googleUserDeleteOptions())).resolves.toEqual({
          success: true,
        });
        expect(verifyPasswordWithCaptchaBypass).not.toHaveBeenCalled();
        expect(deleteUser).toHaveBeenCalledWith(USER_ID);
      });

      it('MFA が有効でコード未入力ならINVALID_INPUTを投げる', async () => {
        const { service } = createSupabase({
          totpFactors: [{ id: 'factor-1', status: 'verified' }],
        });

        await expect(service.deleteAccount(googleUserDeleteOptions())).rejects.toMatchObject({
          code: 'INVALID_INPUT',
        });
        expect(deleteUser).not.toHaveBeenCalled();
      });

      it('MFA のコードが誤っていればINVALID_PASSWORDを投げる', async () => {
        const { service } = createSupabase({
          totpFactors: [{ id: 'factor-1', status: 'verified' }],
          verifyTotpError: { message: 'invalid code' },
        });

        await expect(
          service.deleteAccount(googleUserDeleteOptions({ totpCode: '000000' })),
        ).rejects.toMatchObject({ code: 'INVALID_PASSWORD' });
        expect(deleteUser).not.toHaveBeenCalled();
      });

      it('MFA のコードが正しければ削除できる', async () => {
        const { service, challengeAndVerify } = createSupabase({
          totpFactors: [{ id: 'factor-1', status: 'verified' }],
        });

        await expect(
          service.deleteAccount(googleUserDeleteOptions({ totpCode: '123456' })),
        ).resolves.toEqual({ success: true });
        expect(challengeAndVerify).toHaveBeenCalledWith({ factorId: 'factor-1', code: '123456' });
      });

      it('未検証の factor は再認証を要求しない', async () => {
        const { service, challengeAndVerify } = createSupabase({
          totpFactors: [{ id: 'factor-1', status: 'unverified' }],
        });

        await expect(service.deleteAccount(googleUserDeleteOptions())).resolves.toEqual({
          success: true,
        });
        expect(challengeAndVerify).not.toHaveBeenCalled();
      });

      it('factor 一覧の取得に失敗したらfail closedで削除を止める', async () => {
        const { service } = createSupabase({ listFactorsError: { message: 'mfa unavailable' } });

        await expect(service.deleteAccount(googleUserDeleteOptions())).rejects.toMatchObject({
          code: 'DELETE_FAILED',
        });
        expect(deleteUser).not.toHaveBeenCalled();
      });
    });

    it('admin user削除失敗をDELETE_FAILEDに変換する', async () => {
      const deleteError = new Error('delete failed');
      deleteUser.mockResolvedValue({ data: null, error: deleteError });
      const { service } = createSupabase();

      await expect(service.deleteAccount(deleteOptions())).rejects.toMatchObject({
        code: 'DELETE_FAILED',
        message: 'Failed to delete account',
        cause: deleteError,
      });
    });
  });

  describe('requestEmailChange', () => {
    it('新旧アドレスが同じならINVALID_INPUTを投げ、再認証も試みない', async () => {
      const { service } = createSupabase();

      await expect(
        service.requestEmailChange(requestEmailChangeOptions({ newEmail: USER_EMAIL })),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(enforceReauthRateLimit).not.toHaveBeenCalled();
      expect(verifyPasswordWithCaptchaBypass).not.toHaveBeenCalled();
    });

    // 大文字小文字・前後空白だけが違う「同じアドレス」も弾く。見逃すと reauth rate limit と
    // GoTrue の共有 IP バケットを無駄に消費したうえで実質 no-op の変更が通ってしまう
    it('大文字小文字・前後空白だけが違う同一アドレスもINVALID_INPUTを投げる', async () => {
      const { service } = createSupabase();

      await expect(
        service.requestEmailChange(
          requestEmailChangeOptions({ newEmail: `  ${USER_EMAIL.toUpperCase()}  ` }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(enforceReauthRateLimit).not.toHaveBeenCalled();
    });

    it('verifyPasswordWithCaptchaBypassの直前にaccount_deletionとは別bucketでrate limitを強制する', async () => {
      const { service } = createSupabase();

      await service.requestEmailChange(requestEmailChangeOptions());

      expect(enforceReauthRateLimit).toHaveBeenCalledWith(USER_ID, 'email_change');
      expect(verifyPasswordWithCaptchaBypass).toHaveBeenCalledWith({
        email: USER_EMAIL,
        password: 'correct-password',
        context: 'email_change',
      });
      const [rateLimitOrder] = enforceReauthRateLimit.mock.invocationCallOrder;
      const [verifyOrder] = verifyPasswordWithCaptchaBypass.mock.invocationCallOrder;
      expect(rateLimitOrder).toBeLessThan(verifyOrder!);
    });

    it('パスワードが違えばINVALID_PASSWORDを投げ、updateUserを呼ばない', async () => {
      verifyPasswordWithCaptchaBypass.mockResolvedValue({ outcome: 'invalid_password' });
      const { service, updateUser } = createSupabase();

      await expect(service.requestEmailChange(requestEmailChangeOptions())).rejects.toMatchObject({
        code: 'INVALID_PASSWORD',
      });
      expect(updateUser).not.toHaveBeenCalled();
    });

    // 迂回が壊れた時にfail closedで変更しない（deleteAccountと同型の契約）
    it('再認証手段が使えなければREAUTH_UNAVAILABLEを投げ、updateUserを呼ばない', async () => {
      verifyPasswordWithCaptchaBypass.mockResolvedValue({ outcome: 'unavailable' });
      const { service, updateUser } = createSupabase();

      await expect(service.requestEmailChange(requestEmailChangeOptions())).rejects.toMatchObject({
        code: 'REAUTH_UNAVAILABLE',
      });
      expect(updateUser).not.toHaveBeenCalled();
    });

    it('検証成功後、ユーザー自身のsession-scoped clientでupdateUserを呼ぶ（service-roleではない）', async () => {
      const { service, updateUser } = createSupabase();

      await expect(service.requestEmailChange(requestEmailChangeOptions())).resolves.toEqual({
        success: true,
      });
      expect(updateUser).toHaveBeenCalledWith(
        { email: NEW_EMAIL },
        { emailRedirectTo: 'https://app.example.test/settings/account' },
      );
      // observeAuthOperation の tag が feature: 'auth' 既定へ落ちない（#2064）ことを固定する
      expect(observeAuthOperation).toHaveBeenCalledWith('update_email', expect.any(Function), {
        feature: 'email_change',
      });
    });

    it.each([
      ['email_exists', 'email already registered'],
      ['email_address_invalid', 'invalid email address'],
      ['email_conflict_identity_not_deletable', 'identity conflict'],
      ['validation_failed', 'malformed request'],
    ])('想定内code(%s)はEMAIL_UPDATE_FAILEDに変換し、Sentryへ送らない', async (code, message) => {
      // 実際の GoTrue AuthError（Error 継承）の形に寄せる。dedup が依存する
      // instanceof Error 分岐を plain object では通せない
      const updateError = Object.assign(new Error(message), { code });
      const { service } = createSupabase({ updateUserError: updateError });

      await expect(service.requestEmailChange(requestEmailChangeOptions())).rejects.toMatchObject({
        code: 'EMAIL_UPDATE_FAILED',
        cause: updateError,
      });
      expect(captureUnexpectedError).not.toHaveBeenCalled();
      expect(loggerWarn).not.toHaveBeenCalled();
    });

    // #2064 P2-1: updateUser はユーザー自身の session-scoped client で呼ぶため、session /
    // 権限系の expected code（EXPECTED_AUTH_ERROR_CODES 所属）がユーザーフローの正常な
    // 帰結として起こりうる。silence 列挙（旧実装）だとこれらが軒並み誤 alert になっていた
    // ことを固定する — allowlist 反転後は EMAIL_UPDATE_ALERTING_CODES に無い限り静音
    it.each([
      ['session_expired', 'session expired'],
      ['bad_jwt', 'invalid jwt'],
      ['no_authorization', 'no authorization header'],
      ['user_banned', 'user is banned'],
      ['user_not_found', 'user not found'],
      ['insufficient_aal', 'insufficient assurance level'],
      ['conflict', 'conflict'],
    ])(
      'session/権限系の想定内code(%s)は誤alertせずEMAIL_UPDATE_FAILEDに変換する（P2-1）',
      async (code, message) => {
        const updateError = Object.assign(new Error(message), { code });
        const { service } = createSupabase({ updateUserError: updateError });

        await expect(service.requestEmailChange(requestEmailChangeOptions())).rejects.toMatchObject(
          { code: 'EMAIL_UPDATE_FAILED', cause: updateError },
        );
        expect(captureUnexpectedError).not.toHaveBeenCalled();
      },
    );

    it('rate limit（status 429）はcodeによらずEMAIL_UPDATE_FAILEDに変換し、userId付きでwarnログだけ残す', async () => {
      const updateError = Object.assign(new Error('too many requests'), { status: 429 });
      const { service } = createSupabase({ updateUserError: updateError });

      await expect(service.requestEmailChange(requestEmailChangeOptions())).rejects.toMatchObject({
        code: 'EMAIL_UPDATE_FAILED',
      });
      expect(captureUnexpectedError).not.toHaveBeenCalled();
      expect(loggerWarn).toHaveBeenCalledWith('Email update rate limited by GoTrue', {
        userId: USER_ID,
        message: updateError.message,
      });
    });

    // #2064: email_address_not_authorized は EMAIL_UPDATE_ALERTING_CODES の allowlist に
    // 載っているため、isExpectedAuthError が true でも alert 対象になる。
    // handleServiceError の自動報告はこの allowlist を知らないので、user-service.ts 側が
    // captureUnexpectedError を直接呼ぶことを固定する（REAUTH_UNAVAILABLE の canary と
    // 同型）。updateError をラップせずそのまま渡すことも固定する（observeAuthOperation が
    // 既に捕捉済みの instance と同一でないと WeakSet dedup が効かず、想定外 code で issue
    // が二重に立つ）
    it('email_address_not_authorizedはEMAIL_UPDATE_UNAVAILABLEに変換し、captureUnexpectedErrorをupdateError本体で直接呼ぶ', async () => {
      const updateError = Object.assign(new Error('email address not authorized'), {
        code: 'email_address_not_authorized',
      });
      const { service } = createSupabase({ updateUserError: updateError });

      await expect(service.requestEmailChange(requestEmailChangeOptions())).rejects.toMatchObject({
        code: 'EMAIL_UPDATE_UNAVAILABLE',
        cause: updateError,
      });
      expect(captureUnexpectedError).toHaveBeenCalledWith(updateError, {
        feature: 'email_change',
        operation: 'update_email',
        source: 'supabase_auth',
      });
    });

    it('未知のcodeもEMAIL_UPDATE_UNAVAILABLEに変換し、captureUnexpectedErrorを直接呼ぶ（fail-loudが既定）', async () => {
      const updateError = Object.assign(new Error('gotrue internal error'), {
        code: 'unexpected_failure',
      });
      const { service } = createSupabase({ updateUserError: updateError });

      await expect(service.requestEmailChange(requestEmailChangeOptions())).rejects.toMatchObject({
        code: 'EMAIL_UPDATE_UNAVAILABLE',
      });
      expect(captureUnexpectedError).toHaveBeenCalledWith(updateError, {
        feature: 'email_change',
        operation: 'update_email',
        source: 'supabase_auth',
      });
    });
  });

  describe('deleteBlocks', () => {
    it('records、plansを依存順に削除して合計件数を返す', async () => {
      const adminQueries = mockAdminTables({
        records: { data: [{ id: 'record-1' }] },
        plans: { data: [{ id: 'plan-1' }, { id: 'plan-2' }] },
      });
      const { service } = createSupabase();

      await expect(service.deleteBlocks(USER_ID)).resolves.toEqual({ deletedCount: 3 });
      expect(adminFrom.mock.calls.map(([table]) => table)).toEqual(['records', 'plans']);
      for (const query of adminQueries.values()) {
        expect(query.eq).toHaveBeenCalledWith('user_id', USER_ID);
        expect(query.select).toHaveBeenCalledWith('id');
      }
    });

    it('削除エラーをDELETE_DATA_FAILEDに変換する', async () => {
      mockAdminTables({
        records: { error: { message: 'records failed' } },
      });
      const { service } = createSupabase();

      await expect(service.deleteBlocks(USER_ID)).rejects.toMatchObject({
        code: 'DELETE_DATA_FAILED',
        message: 'records deletion failed',
      });
    });
  });

  describe('deleteAllData', () => {
    // activities は categories を参照するため、この順序が FK 依存順であること自体が契約。
    it('records、plans、activities、categories、user_settingsの順に削除する', async () => {
      mockAdminTables({
        records: { data: [] },
        plans: { data: [] },
        activities: { data: [] },
        categories: { data: [] },
        user_settings: { data: [] },
      });
      const { service } = createSupabase();

      await expect(service.deleteAllData(USER_ID)).resolves.toEqual({ success: true });
      expect(adminFrom.mock.calls.map(([table]) => table)).toEqual([
        'records',
        'plans',
        'activities',
        'categories',
        'user_settings',
      ]);
    });

    it('途中の削除失敗で後続tableを削除しない', async () => {
      mockAdminTables({
        records: { data: [] },
        plans: { error: { message: 'plans failed' } },
      });
      const { service } = createSupabase();

      await expect(service.deleteAllData(USER_ID)).rejects.toMatchObject({
        code: 'DELETE_DATA_FAILED',
        message: 'plans deletion failed',
      });
      expect(adminFrom).not.toHaveBeenCalledWith('activities');
    });
  });

  describe('exportData', () => {
    it('plans / records / categories / activities / settings をexportする', async () => {
      const profile = { id: USER_ID, email: USER_EMAIL };
      const plans = [{ id: 'plan-1', user_id: USER_ID }];
      const records = [{ id: 'record-1', user_id: USER_ID }];
      const categories = [{ id: 'category-1', user_id: USER_ID }];
      const activities = [{ id: 'activity-1', user_id: USER_ID }];
      const settings = { id: 'settings-1', user_id: USER_ID };
      const adminQueries = mockAdminTables({ plans: { data: plans }, records: { data: records } });
      const { service, query } = createSupabase({
        tables: {
          profiles: { data: profile },
          categories: { data: categories },
          activities: { data: activities },
          user_settings: { data: settings },
        },
      });

      const result = await service.exportData({ userId: USER_ID });

      expect(result.userId).toBe(USER_ID);
      expect(result.exportedAt).toEqual(expect.any(String));
      expect(result.data).toEqual({
        profile,
        plans,
        records,
        categories,
        activities,
        userSettings: settings,
      });
      expect(result.data.records).toHaveLength(1);
      expect(result.data.records[0]).not.toHaveProperty('fulfillment_score');
      expect(result.data.userSettings).not.toHaveProperty('chronotype_settings');
      expect(adminQueries.get('records')?.select).toHaveBeenCalledWith(publicRecordSelect);
      expect(query('user_settings').select).toHaveBeenCalledWith(publicUserSettingsSelect);
    });

    it('profileが未作成ならnullとしてexportする', async () => {
      mockAdminTables({ plans: { data: [] }, records: { data: [] } });
      const { service } = createSupabase({
        tables: {
          profiles: { error: { code: 'PGRST116', message: 'not found' } },
          user_settings: { data: null },
        },
      });

      await expect(service.exportData({ userId: USER_ID })).resolves.toMatchObject({
        data: { profile: null },
      });
    });

    it('plans取得失敗をEXPORT_FAILEDに変換する', async () => {
      mockAdminTables({
        plans: { error: { message: 'plans fetch failed' } },
        records: { data: [] },
      });
      const { service } = createSupabase({
        tables: {
          profiles: { data: null },
          user_settings: { data: null },
        },
      });

      await expect(service.exportData({ userId: USER_ID })).rejects.toMatchObject({
        code: 'EXPORT_FAILED',
        message: 'Plans fetch failed',
      });
    });

    it('activities取得失敗をEXPORT_FAILEDに変換する', async () => {
      mockAdminTables({ plans: { data: [] }, records: { data: [] } });
      const { service } = createSupabase({
        tables: {
          profiles: { data: null },
          activities: { error: { message: 'activities fetch failed' } },
          user_settings: { data: null },
        },
      });

      await expect(service.exportData({ userId: USER_ID })).rejects.toMatchObject({
        code: 'EXPORT_FAILED',
        message: 'Activities fetch failed',
      });
    });
  });
});
