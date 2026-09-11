import { beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAuthorizeInput as realValidateAuthorizeInput } from '@/lib/oauth-server/authorize-validation';
import { resetWriteFenceCacheForTestsOnly } from '@/lib/ops/write-fence';

const redirect = vi.hoisted(() =>
  vi.fn((url: string): never => {
    throw new RedirectSignal(url);
  }),
);
const validateAuthorizeInput = vi.hoisted(() => vi.fn());
const assertTokenIssuanceDatabaseIdentity = vi.hoisted(() => vi.fn());
const grantRpc = vi.hoisted(() => vi.fn());
const getUser = vi.hoisted(() => vi.fn());
const writeFenceMaybeSingle = vi.hoisted(() => vi.fn());
const isConsentWriteEnabled = vi.hoisted(() => vi.fn());

/** `next/navigation` の redirect と同様に throw で制御を打ち切るテスト用シグナル。 */
class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect: ${url}`);
  }
}

vi.mock('next/navigation', () => ({ redirect }));
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/sentry', () => ({
  observeAuthOperation: (_operation: string, run: () => unknown) => run(),
  captureUnexpectedDatabaseError: vi.fn((error: unknown) => error),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser },
    from: (table: string) =>
      table === 'write_fence_control'
        ? { select: () => ({ eq: () => ({ maybeSingle: writeFenceMaybeSingle }) }) }
        : undefined,
  }),
}));
vi.mock('@/lib/oauth-server/authorization-request-host', () => ({
  assertOAuthAuthorizationRequestHost: vi.fn().mockResolvedValue(undefined),
}));
// scope の降格判定は本物を使う。stub に置き換えると「gate 閉なら write を落とす」
// という肝心の挙動をテストが証明しなくなる（TEST-1）。可変にするのは client 単位の
// runtime gate だけ。
vi.mock('@/lib/oauth-server', async () => {
  const scopes = await vi.importActual<typeof import('@/lib/oauth-server/scopes')>(
    '@/lib/oauth-server/scopes',
  );
  return {
    assertTokenIssuanceDatabaseIdentity,
    createOAuthDbClient: () => ({ rpc: grantRpc }),
    generateAuthorizationCode: () => ({ code: 'issued-code', hash: 'issued-code-hash' }),
    hasWriteScope: scopes.hasWriteScope,
    resolveGrantableScopes: scopes.resolveGrantableScopes,
    isConsentWriteEnabled,
    validateAuthorizeInput,
  };
});

import { processConsent } from './actions';

function createConsentFormData(): FormData {
  const formData = new FormData();
  formData.set('client_id', 'claude-ai');
  formData.set('redirect_uri', 'https://claude.ai/api/mcp/auth_callback');
  formData.set('code_challenge', 'a'.repeat(43));
  formData.set('scope', 'read:entries');
  formData.set('state', 'state-1');
  formData.set('resource', 'https://mcp.dayopt.app');
  formData.set('decision', 'approve');
  return formData;
}

describe('processConsent database identity gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWriteFenceCacheForTestsOnly();
    writeFenceMaybeSingle.mockResolvedValue({ data: { fence_enabled: false }, error: null });
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    validateAuthorizeInput.mockReturnValue({
      ok: true,
      client: { id: 'claude-ai' },
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      codeChallenge: 'a'.repeat(43),
      scopes: ['read:entries'],
      state: 'state-1',
      resourceUri: 'https://mcp.dayopt.app',
    });
    assertTokenIssuanceDatabaseIdentity.mockResolvedValue(undefined);
    grantRpc.mockResolvedValue({ error: null });
    isConsentWriteEnabled.mockResolvedValue(false);
  });

  it('DB identity不一致ならgrant RPCへ到達せずserver_errorでredirectする', async () => {
    assertTokenIssuanceDatabaseIdentity.mockRejectedValue(
      new Error('OAuth token issuance is unavailable'),
    );

    await expect(processConsent(createConsentFormData())).rejects.toBeInstanceOf(RedirectSignal);

    expect(grantRpc).not.toHaveBeenCalled();
    const redirectedTo = new URL(redirect.mock.calls.at(-1)![0]);
    expect(redirectedTo.searchParams.get('error')).toBe('server_error');
    expect(redirectedTo.searchParams.get('code')).toBeNull();
    expect(redirectedTo.searchParams.get('state')).toBe('state-1');
  });

  it('DB identity一致ならgrant RPCの前に検証してからcodeを返す', async () => {
    await expect(processConsent(createConsentFormData())).rejects.toBeInstanceOf(RedirectSignal);

    expect(assertTokenIssuanceDatabaseIdentity).toHaveBeenCalledTimes(1);
    expect(grantRpc).toHaveBeenCalledTimes(1);
    expect(assertTokenIssuanceDatabaseIdentity.mock.invocationCallOrder[0]!).toBeLessThan(
      grantRpc.mock.invocationCallOrder[0]!,
    );
    expect(grantRpc).toHaveBeenCalledWith(
      'create_oauth_authorization_grant_v2',
      expect.objectContaining({ p_code_hash: 'issued-code-hash', p_user_id: 'user-1' }),
    );
    const redirectedTo = new URL(redirect.mock.calls.at(-1)![0]);
    expect(redirectedTo.searchParams.get('code')).toBe('issued-code');
    expect(redirectedTo.searchParams.get('error')).toBeNull();
  });

  it('write fence が有効な時は grant RPC へ到達せず temporarily_unavailable でredirectする', async () => {
    writeFenceMaybeSingle.mockResolvedValue({ data: { fence_enabled: true }, error: null });

    await expect(processConsent(createConsentFormData())).rejects.toBeInstanceOf(RedirectSignal);

    expect(grantRpc).not.toHaveBeenCalled();
    const redirectedTo = new URL(redirect.mock.calls.at(-1)![0]);
    expect(redirectedTo.searchParams.get('error')).toBe('temporarily_unavailable');
    expect(redirectedTo.searchParams.get('code')).toBeNull();
  });
});

describe('processConsent write gate downgrade', () => {
  // validateAuthorizeInput は本物を通す。stub で「あり得ない validation 結果」を
  // 作ると、authorize が弾く入力を consent が降格している気になれてしまう（TEST-1）。
  function createFormData(scope: string): FormData {
    const formData = createConsentFormData();
    formData.set('scope', scope);
    return formData;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetWriteFenceCacheForTestsOnly();
    writeFenceMaybeSingle.mockResolvedValue({ data: { fence_enabled: false }, error: null });
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    assertTokenIssuanceDatabaseIdentity.mockResolvedValue(undefined);
    grantRpc.mockResolvedValue({ error: null });
    isConsentWriteEnabled.mockResolvedValue(false);
    validateAuthorizeInput.mockImplementation(realValidateAuthorizeInput);
  });

  it('write gate が閉じた client の write 要求は read へ降格して grant する', async () => {
    await expect(
      processConsent(createFormData('read:entries read:activities write:plans delete:records')),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(grantRpc).toHaveBeenCalledWith(
      'create_oauth_authorization_grant_v2',
      expect.objectContaining({
        p_scopes: ['read:entries', 'read:activities'],
        p_write_enabled: false,
      }),
    );
    const redirectedTo = new URL(redirect.mock.calls.at(-1)![0]);
    expect(redirectedTo.searchParams.get('code')).toBe('issued-code');
    expect(redirectedTo.searchParams.get('error')).toBeNull();
  });

  it('write gate が開いた client の write 要求はそのまま write 付きで grant する', async () => {
    isConsentWriteEnabled.mockResolvedValue(true);

    await expect(processConsent(createFormData('read:entries write:plans'))).rejects.toBeInstanceOf(
      RedirectSignal,
    );

    expect(grantRpc).toHaveBeenCalledWith(
      'create_oauth_authorization_grant_v2',
      expect.objectContaining({
        p_scopes: ['read:entries', 'write:plans'],
        p_write_enabled: true,
      }),
    );
  });

  it('広告済み 8 scope を要求されても gate 閉なら read 4 個だけを grant する', async () => {
    await expect(
      processConsent(
        createFormData(
          'read:entries read:activities read:constraints read:stats ' +
            'write:plans delete:plans write:records delete:records',
        ),
      ),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(grantRpc).toHaveBeenCalledWith(
      'create_oauth_authorization_grant_v2',
      expect.objectContaining({
        p_scopes: ['read:entries', 'read:activities', 'read:constraints', 'read:stats'],
        p_write_enabled: false,
      }),
    );
  });

  it('write scope だけの要求は authorize 検証が弾き、grant へ到達しない', async () => {
    await expect(processConsent(createFormData('write:plans'))).rejects.toBeInstanceOf(
      RedirectSignal,
    );

    expect(grantRpc).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenLastCalledWith('/oauth/authorize');
  });
});
