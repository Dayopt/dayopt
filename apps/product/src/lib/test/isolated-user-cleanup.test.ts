import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminSupabase } from './e2e/critical-path-fixture';
import { cleanupIsolatedTestUser } from './isolated-user-cleanup';

const removeOwned = vi.hoisted(() => vi.fn());
vi.mock('./e2e/create-scoped-test-user', () => ({ deleteScopedTestUser: removeOwned }));
const user = {
  userId: 'a0000000-0000-4000-8000-000000000001',
  email: 'e2e-owned@example.com',
  password: 'unused',
};
const present = { data: { user: { id: user.userId, email: user.email } }, error: null };
const absent = { data: { user: null }, error: { status: 404, code: 'user_not_found' } };

function client() {
  const getUserById = vi.fn().mockResolvedValueOnce(present).mockResolvedValueOnce(absent);
  const eq = vi.fn().mockResolvedValue({ error: null, count: 0 });
  const from = vi.fn((_table: string) => ({ select: vi.fn(() => ({ eq })) }));
  const admin = { auth: { admin: { getUserById } }, from } as unknown as AdminSupabase;
  return { admin, getUserById, eq, from };
}

describe('isolated owned user cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('E2E_PREVIEW_ORIGIN', '');
    vi.stubEnv('E2E_PREVIEW_CLOUD_INTENT', '0');
    vi.stubEnv('E2E_ALLOW_NONLOCAL_SUPABASE', '0');
    removeOwned.mockResolvedValue(undefined);
  });

  it('delegates to creation ownership and positively reads Auth/profile/settings absence', async () => {
    const c = client();
    await cleanupIsolatedTestUser(c.admin, 'http://127.0.0.1:54321', 'local-key', user);
    expect(removeOwned).toHaveBeenCalledWith('http://127.0.0.1:54321', 'local-key', user.userId);
    expect(c.getUserById).toHaveBeenNthCalledWith(2, user.userId);
    expect(c.from.mock.calls.map(([table]) => table)).toEqual(['profiles', 'user_settings']);
    expect(c.eq).toHaveBeenCalledWith('id', user.userId);
    expect(c.eq).toHaveBeenCalledWith('user_id', user.userId);
  });

  it('rejects a conflicting Auth identity before any deletion', async () => {
    const c = client();
    c.getUserById.mockReset().mockResolvedValue({
      ...present,
      data: { user: { id: user.userId, email: 'someone-else@example.com' } },
    });
    await expect(
      cleanupIsolatedTestUser(c.admin, 'http://localhost:54321', 'local-key', user),
    ).rejects.toThrow('ownership');
    expect(removeOwned).not.toHaveBeenCalled();
  });

  it.each([
    present,
    { data: { user: null }, error: { status: 503, code: 'unavailable' } },
    { data: { user: null }, error: null },
  ])('does not claim cleanup for remaining Auth or ambiguous readback: %j', async (outcome) => {
    const c = client();
    c.getUserById.mockReset().mockResolvedValueOnce(present).mockResolvedValueOnce(outcome);
    await expect(
      cleanupIsolatedTestUser(c.admin, 'http://localhost:54321', 'local-key', user),
    ).rejects.toThrow('Auth deletion');
    expect(c.from).not.toHaveBeenCalled();
  });

  it('rejects remaining profile/settings rows', async () => {
    const c = client();
    c.eq.mockResolvedValue({ error: null, count: 1 });
    await expect(
      cleanupIsolatedTestUser(c.admin, 'http://localhost:54321', 'local-key', user),
    ).rejects.toThrow('row cleanup');
  });

  it('never attempts reads or cleanup on a shared database', async () => {
    const c = client();
    await expect(
      cleanupIsolatedTestUser(c.admin, 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co', 'key', user),
    ).rejects.toThrow('Local cleanup');
    expect(removeOwned).not.toHaveBeenCalled();
    expect(c.getUserById).not.toHaveBeenCalled();
  });
});
