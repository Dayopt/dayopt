import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetWriteFenceCacheForTestsOnly } from '@/lib/ops/write-fence';

const mocks = vi.hoisted(() => ({
  captureUnexpectedDatabaseError: vi.fn(),
  createClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
  from: vi.fn(),
  generateRecoveryCodes: vi.fn(),
  getUser: vi.fn(),
  hashRecoveryCode: vi.fn(),
  observeAuthOperation: vi.fn(),
  resolveMfaAssurance: vi.fn(),
  rpc: vi.fn(),
  writeFenceMaybeSingle: vi.fn(),
}));

vi.mock('@/lib/auth/recovery-codes', () => ({
  generateRecoveryCodes: mocks.generateRecoveryCodes,
  hashRecoveryCode: mocks.hashRecoveryCode,
}));

vi.mock('@/lib/sentry', () => ({
  captureUnexpectedDatabaseError: mocks.captureUnexpectedDatabaseError,
  observeAuthOperation: mocks.observeAuthOperation,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: mocks.createClient,
}));

vi.mock('@/lib/supabase/oauth', () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

vi.mock('@/lib/trpc/session-auth-context', () => ({
  resolveMfaAssurance: mocks.resolveMfaAssurance,
}));

import { generateAndSaveRecoveryCodesAction } from './recovery-code-actions';

const USER_ID = '12345678-1234-4234-9234-123456789abc';
const FIXED_FAILURE = 'Failed to generate recovery codes';
const MFA_REQUIRED = 'MFA verification is required to issue recovery codes';

describe('generateAndSaveRecoveryCodesAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWriteFenceCacheForTestsOnly();
    mocks.generateRecoveryCodes.mockReturnValue(['recovery-a', 'recovery-b']);
    mocks.hashRecoveryCode.mockImplementation((code: string) => `hash:${code}`);
    mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
    mocks.observeAuthOperation.mockImplementation(
      async (_operation: string, call: () => PromiseLike<unknown>) => call(),
    );
    mocks.resolveMfaAssurance.mockResolvedValue({ currentLevel: 'aal2', nextLevel: 'aal2' });
    mocks.rpc.mockResolvedValue({ data: 2, error: null });
    mocks.writeFenceMaybeSingle.mockResolvedValue({ data: { fence_enabled: false }, error: null });
    mocks.from.mockImplementation(() => ({
      select: () => ({ eq: () => ({ maybeSingle: mocks.writeFenceMaybeSingle }) }),
    }));
    mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser }, from: mocks.from });
    mocks.createServiceRoleClient.mockReturnValue({ rpc: mocks.rpc });
  });

  // #2618: 書き込みは service_role の RPC 経由のみ。認証主体は自分の行を植えられない。
  it('service-role の RPC でコードを一括再発行し、生成した平文を返す', async () => {
    await expect(generateAndSaveRecoveryCodesAction()).resolves.toEqual({
      codes: ['recovery-a', 'recovery-b'],
      error: null,
    });

    expect(mocks.rpc).toHaveBeenCalledWith('replace_mfa_recovery_codes_v1', {
      p_user_id: USER_ID,
      p_code_hashes: ['hash:recovery-a', 'hash:recovery-b'],
    });
    expect(mocks.captureUnexpectedDatabaseError).not.toHaveBeenCalled();
  });

  // #2618: 第二要素を通していないセッションからの発行は、攻撃者が (平文, hash) の組を
  // 学ぶ入口だった。aal1 では発行させない。
  it('aal1 セッションからの発行を拒否する', async () => {
    mocks.resolveMfaAssurance.mockResolvedValue({ currentLevel: 'aal1', nextLevel: 'aal2' });

    await expect(generateAndSaveRecoveryCodesAction()).resolves.toEqual({
      codes: null,
      error: MFA_REQUIRED,
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('MFA 未設定（aal1 → aal1）のセッションからの発行も拒否する', async () => {
    mocks.resolveMfaAssurance.mockResolvedValue({ currentLevel: 'aal1', nextLevel: 'aal1' });

    await expect(generateAndSaveRecoveryCodesAction()).resolves.toEqual({
      codes: null,
      error: MFA_REQUIRED,
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('assurance を確定できない時は fail-closed で拒否する', async () => {
    mocks.resolveMfaAssurance.mockResolvedValue({
      currentLevel: null,
      nextLevel: null,
      lookupFailed: true,
    });

    await expect(generateAndSaveRecoveryCodesAction()).resolves.toEqual({
      codes: null,
      error: MFA_REQUIRED,
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('RPC の失敗を 1 度だけ記録し、provider の詳細を返さない', async () => {
    const replaceError = { code: '42501', message: 'private permission detail' };
    mocks.rpc.mockResolvedValueOnce({ data: null, error: replaceError });

    const result = await generateAndSaveRecoveryCodesAction();

    expect(result).toEqual({ codes: null, error: FIXED_FAILURE });
    expect(mocks.captureUnexpectedDatabaseError).toHaveBeenCalledTimes(1);
    expect(mocks.captureUnexpectedDatabaseError).toHaveBeenCalledWith(replaceError, {
      feature: 'mfa_recovery_codes',
      operation: 'replace_recovery_codes',
    });
    expect(JSON.stringify(result)).not.toContain(replaceError.message);
  });

  it('captures a thrown original Error once and returns the fixed failure', async () => {
    const originalError = new Error('connection failed');
    mocks.createClient.mockRejectedValueOnce(originalError);

    await expect(generateAndSaveRecoveryCodesAction()).resolves.toEqual({
      codes: null,
      error: FIXED_FAILURE,
    });
    expect(mocks.captureUnexpectedDatabaseError).toHaveBeenCalledOnce();
    expect(mocks.captureUnexpectedDatabaseError).toHaveBeenCalledWith(originalError, {
      feature: 'mfa_recovery_codes',
      operation: 'generate_and_save_codes',
    });
  });

  it('treats an unauthenticated user as an expected outcome', async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: null });

    await expect(generateAndSaveRecoveryCodesAction()).resolves.toEqual({
      codes: null,
      error: 'User not found',
    });
    expect(mocks.captureUnexpectedDatabaseError).not.toHaveBeenCalled();
  });

  it('write fence が有効な時は既存コードを削除せずに拒否する', async () => {
    mocks.writeFenceMaybeSingle.mockResolvedValue({ data: { fence_enabled: true }, error: null });

    const result = await generateAndSaveRecoveryCodesAction();

    expect(result).toEqual({
      codes: null,
      error: 'Writes are temporarily paused for maintenance',
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
