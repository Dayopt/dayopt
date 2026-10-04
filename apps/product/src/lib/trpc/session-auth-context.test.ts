import { createServerClient } from '@supabase/ssr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '@/lib/database';

const mocks = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: mocks.loggerWarn },
}));

vi.mock('@/lib/sentry', () => ({
  observeAuthOperation: (_operation: string, call: () => PromiseLike<unknown>) => call(),
}));

import { resolveSessionAuthContext } from './session-auth-context';

function createSupabaseMock(options: {
  user?: { id: string } | null;
  userError?: unknown;
  sessionResult?: unknown;
  sessionError?: unknown;
  mfaData?: { currentLevel: unknown; nextLevel: unknown } | null | undefined;
  mfaError?: unknown;
}) {
  const getSession = vi.fn();
  if (options.sessionError instanceof Error) {
    getSession.mockRejectedValue(options.sessionError);
  } else {
    getSession.mockResolvedValue({
      data: {
        session:
          options.sessionResult === undefined
            ? { access_token: 'session-token' }
            : options.sessionResult,
      },
      error: options.sessionError ?? null,
    });
  }

  const getAuthenticatorAssuranceLevel = vi.fn();
  if (options.mfaError instanceof Error) {
    getAuthenticatorAssuranceLevel.mockRejectedValue(options.mfaError);
  } else {
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data:
        options.mfaData === undefined
          ? { currentLevel: 'aal1', nextLevel: 'aal1' }
          : options.mfaData,
      error: options.mfaError ?? null,
    });
  }

  return {
    client: {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: options.user === undefined ? { id: 'user-1' } : options.user },
          error: options.userError ?? null,
        }),
        getSession,
        mfa: { getAuthenticatorAssuranceLevel },
      },
    },
    getSession,
    getAuthenticatorAssuranceLevel,
  };
}

describe('resolveSessionAuthContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips session and MFA lookups when no verified user exists', async () => {
    const { client, getSession, getAuthenticatorAssuranceLevel } = createSupabaseMock({
      user: null,
    });

    await expect(resolveSessionAuthContext(client as never, 'trpc_context')).resolves.toEqual({});
    expect(getSession).not.toHaveBeenCalled();
    expect(getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
  });

  it.each([
    { currentLevel: 'aal1', nextLevel: 'aal1' },
    { currentLevel: 'aal1', nextLevel: 'aal2' },
    { currentLevel: 'aal2', nextLevel: 'aal2' },
    // #2150: MFA無効化直後、JWT由来のcurrentLevelがaal2のままnextLevelが
    // aal1（実際のfactor状態）になる正常な降格。lookupFailedにしない。
    { currentLevel: 'aal2', nextLevel: 'aal1' },
  ])('returns a valid $currentLevel -> $nextLevel assurance pair', async (mfaData) => {
    const { client, getAuthenticatorAssuranceLevel } = createSupabaseMock({ mfaData });

    await expect(resolveSessionAuthContext(client as never, 'trpc_context')).resolves.toEqual({
      userId: 'user-1',
      sessionId: 'session-token',
      mfaAssurance: mfaData,
    });
    // #2047: server未検証のcookie storageではなくjwt引数付きで呼び、
    // 内部でgetUser(jwt)によるserver検証済みfactorsを使わせる。
    expect(getAuthenticatorAssuranceLevel).toHaveBeenCalledWith('session-token');
  });

  it('fails closed when the session lookup for MFA fails', async () => {
    const { client, getAuthenticatorAssuranceLevel } = createSupabaseMock({
      sessionError: { message: 'session lookup failed' },
    });

    await expect(resolveSessionAuthContext(client as never, 'trpc_context')).resolves.toMatchObject(
      {
        userId: 'user-1',
        mfaAssurance: { currentLevel: null, nextLevel: null, lookupFailed: true },
      },
    );
    expect(getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
  });

  it.each(['returned error', 'thrown error'])(
    'keeps MFA fail-closed after a %s followed by a missing session',
    async (failure) => {
      const { client, getSession, getAuthenticatorAssuranceLevel } = createSupabaseMock({});
      if (failure === 'thrown error') {
        getSession.mockRejectedValueOnce(new Error('session unavailable'));
      } else {
        getSession.mockResolvedValueOnce({
          data: { session: null },
          error: { message: 'session unavailable' },
        });
      }
      getSession.mockResolvedValueOnce({ data: { session: null }, error: null });

      await expect(
        resolveSessionAuthContext(client as never, 'trpc_context'),
      ).resolves.toMatchObject({
        userId: 'user-1',
        sessionId: undefined,
        mfaAssurance: { currentLevel: null, nextLevel: null, lookupFailed: true },
      });
      expect(getSession).toHaveBeenCalledTimes(2);
      expect(getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
    },
  );

  it.each(['returned error', 'thrown error'])(
    'allows independently recovered MFA after a %s in the logging lookup',
    async (failure) => {
      const { client, getSession, getAuthenticatorAssuranceLevel } = createSupabaseMock({
        mfaData: { currentLevel: 'aal1', nextLevel: 'aal2' },
      });
      if (failure === 'thrown error') {
        getSession.mockRejectedValueOnce(new Error('session unavailable'));
      } else {
        getSession.mockResolvedValueOnce({
          data: { session: null },
          error: { message: 'session unavailable' },
        });
      }

      await expect(resolveSessionAuthContext(client as never, 'rsc_trpc')).resolves.toMatchObject({
        userId: 'user-1',
        sessionId: undefined,
        mfaAssurance: { currentLevel: 'aal1', nextLevel: 'aal2' },
      });
      expect(getAuthenticatorAssuranceLevel).toHaveBeenCalledWith('session-token');
    },
  );

  it('treats a missing session as aal1 (no AAL claim to normalize)', async () => {
    const { client, getAuthenticatorAssuranceLevel } = createSupabaseMock({
      sessionResult: null,
    });

    await expect(resolveSessionAuthContext(client as never, 'trpc_context')).resolves.toMatchObject(
      {
        userId: 'user-1',
        mfaAssurance: { currentLevel: 'aal1', nextLevel: 'aal1' },
      },
    );
    expect(getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'no enrolled factor',
      mfaData: { currentLevel: null, nextLevel: null },
      expected: { currentLevel: 'aal1', nextLevel: 'aal1' },
    },
    {
      label: 'an enrolled factor',
      mfaData: { currentLevel: null, nextLevel: 'aal2' },
      expected: { currentLevel: 'aal1', nextLevel: 'aal2' },
    },
  ])('normalizes a missing current AAL claim for $label', async ({ mfaData, expected }) => {
    const { client } = createSupabaseMock({ mfaData });

    await expect(resolveSessionAuthContext(client as never, 'trpc_context')).resolves.toMatchObject(
      {
        mfaAssurance: expected,
      },
    );
  });

  it('fails closed for both sessionId and MFA lookup when getSession throws', async () => {
    // #2047: resolveMfaAssurance は AAL 判定に session.access_token(jwt) を要求するため、
    // sessionIdの抽出に使うgetSession()自体がthrowする状況ではMFA判定も自前で
    // getSession()に依存し、同じ理由でfail-closedになる（以前は独立したSDK呼び出し
    // だったため、session token lookupの失敗はMFA判定に影響しなかった）。
    const { client, getAuthenticatorAssuranceLevel } = createSupabaseMock({
      sessionError: new Error('session unavailable'),
      mfaData: { currentLevel: 'aal1', nextLevel: 'aal2' },
    });

    await expect(resolveSessionAuthContext(client as never, 'rsc_trpc')).resolves.toMatchObject({
      userId: 'user-1',
      sessionId: undefined,
      mfaAssurance: { currentLevel: null, nextLevel: null, lookupFailed: true },
    });
    expect(getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'returned error', mfaError: { message: 'lookup failed' } },
    { label: 'thrown error', mfaError: new Error('lookup failed') },
    { label: 'null data', mfaData: null },
    { label: 'unknown level', mfaData: { currentLevel: 'aal3', nextLevel: 'aal3' } },
  ])('fails closed for $label', async ({ mfaData, mfaError }) => {
    const { client } = createSupabaseMock({ mfaData, mfaError });

    await expect(resolveSessionAuthContext(client as never, 'trpc_context')).resolves.toMatchObject(
      {
        userId: 'user-1',
        mfaAssurance: { currentLevel: null, nextLevel: null, lookupFailed: true },
      },
    );
  });
});

// Real SSR/auth SDK with synthetic HTTP only: no external request or credential.
describe('resolveSessionAuthContext with the SSR SDK', () => {
  it.each([
    { elapsedMs: 0, expected: { currentLevel: 'aal1', nextLevel: 'aal2' } },
    { elapsedMs: 31_000, expected: { currentLevel: null, nextLevel: null, lookupFailed: true } },
    { elapsedMs: 61_000, expected: { currentLevel: null, nextLevel: null, lookupFailed: true } },
  ])(
    'preserves the MFA contract after $elapsedMs ms of synthetic Auth latency',
    async ({ elapsedMs, expected }) => {
      let now = 1_900_000_000_000;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      const userId = '00000000-0000-4000-8000-000000000001';
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const accessToken = [
        encode({ alg: 'HS256', typ: 'JWT' }),
        encode({ sub: userId, aal: 'aal1', exp: now / 1000 + 3600 }),
        'synthetic-signature',
      ].join('.');
      const verifiedUser = {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'audit@example.invalid',
        app_metadata: {},
        user_metadata: {},
        factors: [{ id: 'factor', factor_type: 'totp', status: 'verified' }],
      };
      const session = {
        access_token: accessToken,
        refresh_token: 'synthetic-invalid-refresh',
        expires_at: now / 1000 + 10,
        expires_in: 10,
        token_type: 'bearer',
        user: { ...verifiedUser, factors: [] },
      };
      const requests: string[] = [];
      const client = createServerClient<Database>('https://audit.invalid', 'synthetic-key', {
        cookies: {
          getAll: () => [{ name: 'sb-audit-auth-token', value: `base64-${encode(session)}` }],
          setAll: () => {},
        },
        global: {
          fetch: async (input) => {
            const url = String(input);
            if (url.includes('/token')) {
              requests.push('refresh');
              return new Response(JSON.stringify({ message: 'Synthetic rejected refresh' }), {
                status: 400,
                headers: { 'content-type': 'application/json' },
              });
            }
            if (url.endsWith('/user')) {
              requests.push('user');
              now += elapsedMs;
              return new Response(JSON.stringify(verifiedUser), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              });
            }
            throw new Error('Unexpected synthetic Auth request');
          },
        },
      });
      const sessionLookup = vi.spyOn(client.auth, 'getSession');
      try {
        const context = await resolveSessionAuthContext(client, 'rsc_trpc');
        expect(context.userId).toBe(userId);
        expect(context.mfaAssurance).toEqual(expected);
        if (elapsedMs === 61_000) {
          const first = await sessionLookup.mock.results[0]?.value;
          const second = await sessionLookup.mock.results[1]?.value;
          expect(first.error).not.toBeNull();
          expect(second).toEqual({ data: { session: null }, error: null });
          expect(requests).toEqual(['refresh', 'user', 'refresh']);
        } else if (elapsedMs === 31_000) {
          expect(requests).toEqual(['refresh', 'user']);
        } else {
          expect(requests).toEqual(['refresh', 'user', 'user']);
        }
      } finally {
        client.auth.dispose();
        sessionLookup.mockRestore();
        clock.mockRestore();
      }
    },
  );
});
