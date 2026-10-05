import { beforeEach, describe, expect, it, vi } from 'vitest';

const admin = vi.hoisted(() => ({
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  getUserById: vi.fn(),
  upsert: vi.fn(),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { admin },
    from: () => ({ upsert: admin.upsert }),
  }),
}));

import { createScopedTestUser, deleteScopedTestUser } from './create-scoped-test-user';

const URL = 'http://127.0.0.1:54321';
const KEY = 'synthetic-not-a-credential';

beforeEach(() => {
  vi.clearAllMocks();
  admin.createUser.mockResolvedValue({ data: { user: { id: crypto.randomUUID() } }, error: null });
  admin.upsert.mockResolvedValue({ error: null });
  admin.deleteUser.mockResolvedValue({ error: null });
  admin.getUserById.mockResolvedValue({
    data: { user: null },
    error: { code: 'user_not_found', status: 404 },
  });
});

describe('scoped synthetic user lifecycle', () => {
  it('rejects returned delete errors and retains ownership for a cleanup retry', async () => {
    const user = await createScopedTestUser(URL, KEY, 'cleanup');
    admin.deleteUser.mockResolvedValueOnce({ error: { message: 'provider-sensitive-token' } });
    await expect(deleteScopedTestUser(URL, KEY, user.userId)).rejects.toThrow(
      'E2E synthetic user cleanup failed',
    );
    await expect(deleteScopedTestUser(URL, KEY, user.userId)).resolves.toBeUndefined();
    expect(admin.deleteUser).toHaveBeenCalledTimes(2);
  });

  it('cleans a confirmed created Auth user when profile initialization returns an error', async () => {
    const userId = crypto.randomUUID();
    admin.createUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
    admin.upsert.mockResolvedValue({ error: { message: 'provider-sensitive-token' } });
    await expect(createScopedTestUser(URL, KEY, 'profile-failure')).rejects.toThrow(
      'E2E synthetic profile setup failed',
    );
    expect(admin.deleteUser).toHaveBeenCalledWith(userId);
    expect(admin.getUserById).toHaveBeenCalledWith(userId);
  });

  it('refuses cleanup for a user not created by this helper', async () => {
    await expect(deleteScopedTestUser(URL, KEY, crypto.randomUUID())).rejects.toThrow(
      'E2E synthetic user ownership is unconfirmed',
    );
    expect(admin.deleteUser).not.toHaveBeenCalled();
  });

  it('does not report successful cleanup while readback still finds the account', async () => {
    const user = await createScopedTestUser(URL, KEY, 'readback');
    admin.getUserById.mockResolvedValueOnce({ data: { user: { id: user.userId } }, error: null });
    await expect(deleteScopedTestUser(URL, KEY, user.userId)).rejects.toThrow(
      'E2E synthetic user cleanup is unconfirmed',
    );
    await expect(deleteScopedTestUser(URL, KEY, user.userId)).resolves.toBeUndefined();
  });

  it('rejects production before touching the admin API', async () => {
    await expect(
      createScopedTestUser('https://yvglwblxrnrenfifsnje.supabase.co', KEY, 'unsafe'),
    ).rejects.toThrow('E2E synthetic user target is unsafe');
    expect(admin.createUser).not.toHaveBeenCalled();
  });
  it('also cleans after a thrown profile request failure', async () => {
    const userId = crypto.randomUUID();
    admin.createUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
    admin.upsert.mockRejectedValue(new Error('provider-sensitive-token'));
    await expect(createScopedTestUser(URL, KEY, 'profile-throw')).rejects.toThrow(
      'E2E synthetic profile setup failed',
    );
    expect(admin.deleteUser).toHaveBeenCalledWith(userId);
  });

  it('sanitizes thrown cleanup failures and allows retry', async () => {
    const user = await createScopedTestUser(URL, KEY, 'cleanup-throw');
    admin.deleteUser.mockRejectedValueOnce(new Error('provider-sensitive-token'));
    await expect(deleteScopedTestUser(URL, KEY, user.userId)).rejects.toThrow(
      'E2E synthetic user cleanup failed',
    );
    await expect(deleteScopedTestUser(URL, KEY, user.userId)).resolves.toBeUndefined();
  });

  it('does not accept an unrelated readback error as proof of absence', async () => {
    const user = await createScopedTestUser(URL, KEY, 'readback-error');
    admin.getUserById.mockResolvedValueOnce({
      data: { user: null },
      error: { code: 'network_failure', status: 500, message: 'provider-sensitive-token' },
    });
    await expect(deleteScopedTestUser(URL, KEY, user.userId)).rejects.toThrow(
      'E2E synthetic user cleanup is unconfirmed',
    );
    await expect(deleteScopedTestUser(URL, KEY, user.userId)).resolves.toBeUndefined();
  });
  it('confirms absence when a retained cleanup retry reports the user already missing', async () => {
    const user = await createScopedTestUser(URL, KEY, 'already-missing');
    admin.getUserById.mockRejectedValueOnce(new Error('provider-sensitive-token'));
    await expect(deleteScopedTestUser(URL, KEY, user.userId)).rejects.toThrow(
      'E2E synthetic user cleanup is unconfirmed',
    );
    admin.deleteUser.mockResolvedValueOnce({ error: { code: 'user_not_found', status: 404 } });
    await expect(deleteScopedTestUser(URL, KEY, user.userId)).resolves.toBeUndefined();
    expect(admin.getUserById).toHaveBeenCalledTimes(2);
  });
});
