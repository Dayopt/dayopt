import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createChainableMock } from '@/lib/test/trpc-test-helpers';

import { RecoveryService } from './recovery-service';

const listFactors = vi.hoisted(() => vi.fn());
const deleteFactor = vi.hoisted(() => vi.fn());
const getUserById = vi.hoisted(() => vi.fn());
const verifyRecoveryCode = vi.hoisted(() => vi.fn());
const adminRpc = vi.hoisted(() => vi.fn());
const adminFrom = vi.hoisted(() => vi.fn());
const captureUnexpectedDatabaseError = vi.hoisted(() => vi.fn());
const captureUnexpectedError = vi.hoisted(() => vi.fn());
const getUserLocale = vi.hoisted(() => vi.fn());
const sendMfaDisabledEmail = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/recovery-codes', () => ({ verifyRecoveryCode }));

vi.mock('@/lib/sentry', () => ({
  captureUnexpectedDatabaseError,
  captureUnexpectedError,
  observeAuthOperation: async (_operation: string, call: () => PromiseLike<unknown>) => call(),
}));

// #2618: `mfa_recovery_codes` はブラウザロールから到達できなくなったため、
// コードの読み取りと残数取得も service_role client 経由になった。
vi.mock('@/lib/supabase/oauth', () => ({
  createServiceRoleClient: () => ({
    auth: { admin: { mfa: { listFactors, deleteFactor }, getUserById } },
    from: adminFrom,
    rpc: adminRpc,
  }),
}));

vi.mock('@/lib/email/router', () => ({ getUserLocale, sendMfaDisabledEmail }));

const USER_ID = '00000000-0000-4000-8000-000000000001';
const CODE = 'ABCD-EFGH';

function createService(options?: {
  codes?: unknown[] | null;
  fetchError?: { message: string; code?: string } | null;
  rpcResults?: Array<{ data: unknown; error: { message: string } | null }>;
  adminRpcResult?: { data: unknown; error: { message: string } | null };
}) {
  const query = createChainableMock(options?.codes ?? [], options?.fetchError ?? null);
  const rpcResults = [...(options?.rpcResults ?? [])];
  const consumeResult = options?.adminRpcResult ?? { data: true, error: null };

  // service_role client は 2 種類の RPC を受ける。呼び分けは名前で行う
  // （`use_recovery_code` = 消費、`count_unused_recovery_codes` = 残数）。
  adminRpc.mockImplementation(async (name: string) =>
    name === 'count_unused_recovery_codes'
      ? (rpcResults.shift() ?? { data: null, error: null })
      : consumeResult,
  );
  adminFrom.mockImplementation(() => query);

  // user-scoped client は locale 取得にしか使われない（コードの読み書きは service_role 側）。
  const from = vi.fn(() => query);
  const rpc = vi.fn(async () => ({ data: null, error: null }));

  return {
    service: new RecoveryService({ from, rpc } as never),
    query,
    rpc,
    adminRpc,
    adminFrom,
  };
}

describe('RecoveryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyRecoveryCode.mockImplementation(
      (_code: string, hash: string) => hash === 'matching-hash',
    );
    listFactors.mockResolvedValue({ data: { factors: [] }, error: null });
    deleteFactor.mockResolvedValue({ data: {}, error: null });
    getUserById.mockResolvedValue({
      data: { user: { email: 'user@example.com', user_metadata: { full_name: 'Tomoya' } } },
      error: null,
    });
    getUserLocale.mockResolvedValue('en');
    sendMfaDisabledEmail.mockResolvedValue({ success: true, emailId: 'email-1' });
    captureUnexpectedDatabaseError.mockImplementation((error: unknown) =>
      error instanceof Error ? error : new Error('Unexpected database failure', { cause: error }),
    );
  });

  it('一致したコードを消費し、verified factorだけを削除して残数を返す', async () => {
    const hash = 'matching-hash';
    const { service, query } = createService({
      codes: [{ id: 'code-1', code_hash: hash }],
      rpcResults: [{ data: 7, error: null }],
    });
    listFactors.mockResolvedValue({
      data: {
        factors: [
          { id: 'verified-1', status: 'verified' },
          { id: 'unverified-1', status: 'unverified' },
        ],
      },
      error: null,
    });

    await expect(service.verify({ userId: USER_ID, code: CODE })).resolves.toEqual({
      success: true,
      remainingCodes: 7,
    });
    expect(query.eq).toHaveBeenCalledWith('user_id', USER_ID);
    expect(query.is).toHaveBeenCalledWith('used_at', null);
    expect(adminRpc).toHaveBeenCalledWith('use_recovery_code', {
      p_user_id: USER_ID,
      p_code_hash: hash,
    });
    expect(adminRpc).toHaveBeenCalledWith('count_unused_recovery_codes', { p_user_id: USER_ID });
    expect(deleteFactor).toHaveBeenCalledWith({ userId: USER_ID, id: 'verified-1' });
    expect(deleteFactor).not.toHaveBeenCalledWith({ userId: USER_ID, id: 'unverified-1' });

    // factor削除 → コード消費の順（#2039）
    expect(deleteFactor.mock.invocationCallOrder[0]).toBeLessThan(
      adminRpc.mock.invocationCallOrder[0]!,
    );

    // MFA無効化通知メール（#2033）
    expect(getUserById).toHaveBeenCalledWith(USER_ID);
    expect(sendMfaDisabledEmail).toHaveBeenCalledWith({
      email: 'user@example.com',
      userName: 'Tomoya',
      locale: 'en',
    });
  });

  it('未使用コードがなければ RECOVERY_EXHAUSTED を投げる', async () => {
    const { service } = createService({ codes: [] });

    await expect(service.verify({ userId: USER_ID, code: CODE })).rejects.toMatchObject({
      code: 'RECOVERY_EXHAUSTED',
      message: 'RECOVERY_EXHAUSTED',
    });
    expect(sendMfaDisabledEmail).not.toHaveBeenCalled();
  });

  it('コードが一致しなければ RECOVERY_INVALID を投げる', async () => {
    const { service } = createService({
      codes: [{ id: 'code-1', code_hash: 'other-hash' }],
    });

    await expect(service.verify({ userId: USER_ID, code: CODE })).rejects.toMatchObject({
      code: 'RECOVERY_INVALID',
      message: 'RECOVERY_INVALID',
    });
    expect(sendMfaDisabledEmail).not.toHaveBeenCalled();
  });

  it('コード取得エラーを RECOVERY_FAILED にする', async () => {
    const fetchError = { message: 'fetch failed', code: 'PGRST000' };
    const { service } = createService({
      fetchError,
    });

    await expect(service.verify({ userId: USER_ID, code: CODE })).rejects.toMatchObject({
      code: 'RECOVERY_FAILED',
      message: 'Failed to fetch recovery codes',
      cause: expect.objectContaining({ cause: fetchError }),
    });
    expect(captureUnexpectedDatabaseError).toHaveBeenCalledWith(fetchError, {
      feature: 'mfa_recovery',
      operation: 'fetch_recovery_codes',
    });
  });

  it('factor削除に失敗した場合はコードを消費しない（#2039、ロックアウトになる中途状態を避ける）', async () => {
    const { service } = createService({
      codes: [{ id: 'code-1', code_hash: 'matching-hash' }],
    });
    listFactors.mockResolvedValue({
      data: { factors: [{ id: 'verified-1', status: 'verified' }] },
      error: null,
    });
    deleteFactor.mockResolvedValue({ data: null, error: { message: 'unenroll failed' } });

    await expect(service.verify({ userId: USER_ID, code: CODE })).rejects.toMatchObject({
      code: 'RECOVERY_FAILED',
      message: 'Failed to unenroll MFA factor',
    });
    expect(adminRpc).not.toHaveBeenCalled();
    expect(sendMfaDisabledEmail).not.toHaveBeenCalled();
  });

  it('複数verified factorのうち一部だけ削除できた場合でも、例外を投げる前に通知を送る（部分削除の無通知を防ぐ）', async () => {
    const { service } = createService({
      codes: [{ id: 'code-1', code_hash: 'matching-hash' }],
    });
    listFactors.mockResolvedValue({
      data: {
        factors: [
          { id: 'verified-1', status: 'verified' },
          { id: 'verified-2', status: 'verified' },
        ],
      },
      error: null,
    });
    deleteFactor
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'unenroll failed' } });

    await expect(service.verify({ userId: USER_ID, code: CODE })).rejects.toMatchObject({
      code: 'RECOVERY_FAILED',
      message: 'Failed to unenroll MFA factor',
    });
    expect(deleteFactor).toHaveBeenCalledTimes(2);
    expect(adminRpc).not.toHaveBeenCalled();
    expect(sendMfaDisabledEmail).toHaveBeenCalledOnce();
    expect(captureUnexpectedError).toHaveBeenCalledWith(expect.any(Error), {
      feature: 'mfa_recovery',
      operation: 'partial_mfa_factor_unenrollment',
    });
  });

  it('factor削除後にコード消費RPCが実エラーを返しても成功として扱う（#2039、実害はコードの将来的な再利用可能性のみ）', async () => {
    const rpcError = { message: 'connection reset' };
    const { service } = createService({
      codes: [{ id: 'code-1', code_hash: 'matching-hash' }],
      adminRpcResult: { data: null, error: rpcError },
      rpcResults: [{ data: 5, error: null }],
    });
    listFactors.mockResolvedValue({
      data: { factors: [{ id: 'verified-1', status: 'verified' }] },
      error: null,
    });

    await expect(service.verify({ userId: USER_ID, code: CODE })).resolves.toEqual({
      success: true,
      remainingCodes: 5,
    });
    expect(deleteFactor).toHaveBeenCalledWith({ userId: USER_ID, id: 'verified-1' });
    expect(captureUnexpectedDatabaseError).toHaveBeenCalledWith(rpcError, {
      feature: 'mfa_recovery',
      operation: 'consume_recovery_code',
    });
    // factorが削除された（MFA無効化が成立した）ので通知は送る
    expect(sendMfaDisabledEmail).toHaveBeenCalledOnce();
  });

  it('factor削除後、コード消費RPCが良性のレース（並行リクエストによる既消費）を返しても Sentry には上げない', async () => {
    const { service } = createService({
      codes: [{ id: 'code-1', code_hash: 'matching-hash' }],
      adminRpcResult: { data: false, error: null },
      rpcResults: [{ data: 5, error: null }],
    });
    listFactors.mockResolvedValue({
      data: { factors: [{ id: 'verified-1', status: 'verified' }] },
      error: null,
    });

    await expect(service.verify({ userId: USER_ID, code: CODE })).resolves.toEqual({
      success: true,
      remainingCodes: 5,
    });
    expect(captureUnexpectedDatabaseError).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'consume_recovery_code' }),
    );
  });

  it('verified factorが無ければ通知メールを送らない', async () => {
    const { service } = createService({
      codes: [{ id: 'code-1', code_hash: 'matching-hash' }],
      rpcResults: [{ data: 3, error: null }],
    });
    listFactors.mockResolvedValue({ data: { factors: [] }, error: null });

    await expect(service.verify({ userId: USER_ID, code: CODE })).resolves.toEqual({
      success: true,
      remainingCodes: 3,
    });
    expect(sendMfaDisabledEmail).not.toHaveBeenCalled();
  });

  it('通知先メールアドレスが取得できない場合はresendではなくsupabase_auth起因としてcaptureする', async () => {
    const { service } = createService({
      codes: [{ id: 'code-1', code_hash: 'matching-hash' }],
      rpcResults: [{ data: 1, error: null }],
    });
    listFactors.mockResolvedValue({
      data: { factors: [{ id: 'verified-1', status: 'verified' }] },
      error: null,
    });
    getUserById.mockResolvedValue({ data: { user: { email: null } }, error: null });

    await expect(service.verify({ userId: USER_ID, code: CODE })).resolves.toEqual({
      success: true,
      remainingCodes: 1,
    });
    expect(sendMfaDisabledEmail).not.toHaveBeenCalled();
    expect(captureUnexpectedError).toHaveBeenCalledWith(expect.any(Error), {
      feature: 'mfa_recovery',
      operation: 'recovery_get_user_for_notification',
      source: 'supabase_auth',
    });
  });

  it('通知メール送信に失敗しても検証は成功として返す', async () => {
    const { service } = createService({
      codes: [{ id: 'code-1', code_hash: 'matching-hash' }],
      rpcResults: [{ data: 2, error: null }],
    });
    listFactors.mockResolvedValue({
      data: { factors: [{ id: 'verified-1', status: 'verified' }] },
      error: null,
    });
    sendMfaDisabledEmail.mockRejectedValue(new Error('resend down'));

    await expect(service.verify({ userId: USER_ID, code: CODE })).resolves.toEqual({
      success: true,
      remainingCodes: 2,
    });
    expect(captureUnexpectedError).toHaveBeenCalledWith(expect.any(Error), {
      feature: 'mfa_recovery',
      operation: 'send_mfa_disabled_email',
      source: 'resend',
    });
  });

  it('残数取得の失敗は非致命的として0を返す', async () => {
    const countError = { message: 'count failed' };
    const { service } = createService({
      codes: [{ id: 'code-1', code_hash: 'matching-hash' }],
      rpcResults: [{ data: null, error: countError }],
    });

    await expect(service.verify({ userId: USER_ID, code: CODE })).resolves.toEqual({
      success: true,
      remainingCodes: 0,
    });
    expect(captureUnexpectedDatabaseError).toHaveBeenCalledWith(countError, {
      feature: 'mfa_recovery',
      operation: 'count_remaining_recovery_codes',
    });
  });
});
