import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  capturedContexts: [] as unknown[],
  createServerClient: vi.fn(),
  createServerSideHelpers: vi.fn(),
  observeAuthOperation: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, cache: <TFunction>(fn: TFunction) => fn };
});

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ getAll: vi.fn().mockReturnValue([]), set: vi.fn() }),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: mocks.createServerClient,
}));

vi.mock('@trpc/react-query/server', () => ({
  createServerSideHelpers: mocks.createServerSideHelpers,
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'test-anon-key',
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/mcp/auth', () => ({
  extractBearerToken: vi.fn(),
  verifyAccessToken: vi.fn(),
}));

vi.mock('@/lib/oauth-server', () => ({
  OAuthServerError: class OAuthServerError extends Error {},
}));

vi.mock('@/lib/sentry', () => ({
  captureUnexpectedError: vi.fn(),
  observeAuthOperation: mocks.observeAuthOperation,
}));

vi.mock('@/lib/supabase/oauth', () => ({
  createServiceRoleClient: vi.fn(),
  detectAuthMode: () => 'session',
}));

vi.mock('@/lib/trpc/root', () => ({ appRouter: {} }));

import { createFetchTRPCContext } from './context';
import { createServerHelpers } from './server';

describe('HTTP/RSC tRPC context parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.capturedContexts.length = 0;
    mocks.observeAuthOperation.mockImplementation(
      (_operation: string, call: () => PromiseLike<unknown>) => call(),
    );
    mocks.createServerSideHelpers.mockImplementation((options: { ctx: unknown }) => {
      mocks.capturedContexts.push(options.ctx);
      return {};
    });
  });

  it('populates identical MFA assurance data in HTTP and RSC contexts', async () => {
    const supabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'user-1' } },
          error: null,
        }),
        getSession: vi.fn().mockResolvedValue({
          data: { session: { access_token: 'session-token' } },
          error: null,
        }),
        mfa: {
          getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({
            data: { currentLevel: 'aal1', nextLevel: 'aal2' },
            error: null,
          }),
        },
      },
    };
    mocks.createServerClient.mockReturnValue(supabase);

    const httpContext = await createFetchTRPCContext({
      req: new Request('https://app.dayopt.app/api/trpc'),
      resHeaders: new Headers(),
    } as never);
    await createServerHelpers();

    const rscContext = mocks.capturedContexts.at(-1) as {
      userId?: string;
      sessionId?: string;
      mfaAssurance?: unknown;
    };
    expect(rscContext).toMatchObject({
      userId: httpContext.userId,
      sessionId: httpContext.sessionId,
      mfaAssurance: httpContext.mfaAssurance,
    });
    expect(mocks.observeAuthOperation.mock.calls.map(([operation]) => operation)).toEqual([
      'trpc_context_get_user',
      'trpc_context_get_session',
      'trpc_context_get_session_for_mfa',
      'trpc_context_get_authenticator_assurance_level',
      'rsc_trpc_get_user',
      'rsc_trpc_get_session',
      'rsc_trpc_get_session_for_mfa',
      'rsc_trpc_get_authenticator_assurance_level',
    ]);
  });
});
