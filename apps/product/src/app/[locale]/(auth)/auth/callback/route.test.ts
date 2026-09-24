import { beforeEach, describe, expect, it, vi } from 'vitest';

const exchangeCodeForSession = vi.hoisted(() => vi.fn());
const deliverWelcomeEmailOnce = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({ auth: { exchangeCodeForSession } }),
}));
vi.mock('@/features/auth/server/welcome-email', () => ({ deliverWelcomeEmailOnce }));
vi.mock('@/lib/sentry', () => ({
  observeAuthOperation: (_name: string, operation: () => unknown) => operation(),
}));

import { GET } from './route';

function registeredIn(response: Response): string | null {
  return new URL(response.headers.get('location') ?? '').searchParams.get('registered');
}

describe('OAuth registration analytics redirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    exchangeCodeForSession.mockResolvedValue({
      data: { session: { user: { id: 'user-1' } } },
      error: null,
    });
  });

  it('marks only the first confirmed account creation', async () => {
    deliverWelcomeEmailOnce.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const request = new Request('https://app.dayopt.app/auth/callback?code=valid');

    expect(registeredIn(await GET(request))).toBe('google');
    expect(registeredIn(await GET(request))).toBeNull();
    expect(exchangeCodeForSession).toHaveBeenCalledWith('valid');
  });

  it('does not mark an unsuccessful code exchange', async () => {
    exchangeCodeForSession.mockResolvedValue({ data: {}, error: new Error('invalid code') });

    expect(
      registeredIn(await GET(new Request('https://app.dayopt.app/auth/callback?code=invalid'))),
    ).toBeNull();
    expect(deliverWelcomeEmailOnce).not.toHaveBeenCalled();
  });
});
