import { deleteScopedTestUser, type ScopedTestUser } from './e2e/create-scoped-test-user';
import type { AdminSupabase } from './e2e/critical-path-fixture';
import { resolveIsolatedServiceRoleTarget } from './isolated-service-role-target';

/** The scoped helper proves creation ownership; readback proves the local cleanup completed. */
export async function cleanupIsolatedTestUser(
  admin: AdminSupabase,
  url: string,
  key: string,
  user: ScopedTestUser,
): Promise<void> {
  if (!resolveIsolatedServiceRoleTarget(url, key).safe)
    throw new Error('Local cleanup target required');
  const before = await admin.auth.admin.getUserById(user.userId);
  if (
    before.error ||
    before.data.user?.id !== user.userId ||
    before.data.user.email !== user.email
  ) {
    throw new Error('Isolated cleanup ownership could not be confirmed');
  }
  await deleteScopedTestUser(url, key, user.userId);
  const after = await admin.auth.admin.getUserById(user.userId);
  if (after.data.user || after.error?.status !== 404 || after.error.code !== 'user_not_found') {
    throw new Error('Isolated Auth deletion could not be confirmed');
  }
  const readbacks = await Promise.all([
    admin.from('profiles').select('id', { count: 'exact', head: true }).eq('id', user.userId),
    admin
      .from('user_settings')
      .select('user_id', { count: 'exact', head: true })
      .eq('user_id', user.userId),
  ]);
  for (const result of readbacks) {
    if (result.error || result.count !== 0)
      throw new Error('Isolated row cleanup could not be confirmed');
  }
}
