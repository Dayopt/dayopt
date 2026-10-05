import type { User } from '@supabase/supabase-js';

import { resolvePreviewCloudUserId } from '../preview-cloud-identity';
import { recordPreviewUser } from '../preview-user-lifecycle';
import type { AdminSupabase } from './critical-path-fixture';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ownedUsers = new WeakMap<AdminSupabase, Map<string, string>>();
const EXTERNAL_TABLES = [
  'calendar_connections',
  'oauth_connections',
  'oauth_tokens',
  'oauth_authorization_codes',
] as const;

export interface AccountDeletionIdentity {
  userId: string;
  runId: string;
  email: string;
  password: string;
}

export function createAccountDeletionIdentity(): AccountDeletionIdentity {
  const allocatedId = resolvePreviewCloudUserId('account-deletion');
  if (allocatedId && !process.env.E2E_PREVIEW_EVIDENCE_DIR) {
    throw new Error('Preview account deletion requires a durable ownership journal');
  }
  const runId = process.env.E2E_PREVIEW_RUN_ID ?? crypto.randomUUID();
  if (!UUID.test(runId)) throw new Error('Account deletion run identity is invalid');
  return {
    userId: allocatedId ?? crypto.randomUUID(),
    runId,
    email: `account-deletion-${crypto.randomUUID()}@example.com`,
    password: crypto.randomUUID(),
  };
}

async function readAuthUser(admin: AdminSupabase, userId: string): Promise<User | null> {
  try {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error?.status === 404 && error.code === 'user_not_found') return null;
    if (error || !data.user || data.user.id !== userId) throw new Error();
    return data.user;
  } catch {
    throw new Error('Account deletion Auth readback failed');
  }
}

function belongsToRun(user: User, identity: AccountDeletionIdentity): boolean {
  return (
    user.id === identity.userId &&
    user.email === identity.email &&
    user.app_metadata.e2e_run_id === identity.runId
  );
}

/** A collision is never adopted, even if the existing user has the same marker. */
export async function seedAccountDeletionUser(
  admin: AdminSupabase,
  identity: AccountDeletionIdentity,
) {
  const allocatedId = resolvePreviewCloudUserId('account-deletion');
  if (
    allocatedId &&
    (identity.userId !== allocatedId ||
      identity.runId !== process.env.E2E_PREVIEW_RUN_ID ||
      !process.env.E2E_PREVIEW_EVIDENCE_DIR)
  )
    throw new Error('Account deletion allocation differs');
  if (await readAuthUser(admin, identity.userId))
    throw new Error('Account deletion allocation is already present');
  recordPreviewUser(identity.userId, 'creating');
  let created: User | null = null;
  try {
    const { data, error } = await admin.auth.admin.createUser({
      id: identity.userId,
      email: identity.email,
      password: identity.password,
      email_confirm: true,
      app_metadata: { e2e_run_id: identity.runId },
      user_metadata: { full_name: 'account deletion e2e' },
    });
    if (!error && data.user && belongsToRun(data.user, identity)) created = data.user;
  } catch {
    // Keep uncertain creation recoverable; never adopt a user on a provider error.
    created = null;
  }
  if (!created) {
    recordPreviewUser(identity.userId, 'creation-unconfirmed');
    throw new Error('Account deletion synthetic creation failed');
  }
  const owned = ownedUsers.get(admin) ?? new Map<string, string>();
  owned.set(identity.userId, identity.runId);
  ownedUsers.set(admin, owned);
  recordPreviewUser(identity.userId, 'created');
  const { error: profileError } = await admin.from('profiles').upsert({
    id: identity.userId,
    email: identity.email,
    stripe_customer_id: null,
    subscription_status: 'free',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (profileError) throw new Error('Account deletion profile setup failed');
  const { error: settingsError } = await admin.from('user_settings').upsert({
    user_id: identity.userId,
    timezone: 'Asia/Tokyo',
    preferred_locale: 'ja',
    default_view: 'day',
    default_duration: 60,
    time_format: '24h',
    week_starts_on: 1,
  });
  if (settingsError) throw new Error('Account deletion settings setup failed');
  await assertAccountDeletionUserSafe(admin, identity);
}

/** Recheck immediately before destructive UI confirmation, including provider-free state. */
export async function assertAccountDeletionUserSafe(
  admin: AdminSupabase,
  identity: AccountDeletionIdentity,
) {
  if (ownedUsers.get(admin)?.get(identity.userId) !== identity.runId)
    throw new Error('Account deletion user is not owned');
  const user = await readAuthUser(admin, identity.userId);
  if (
    !user ||
    !belongsToRun(user, identity) ||
    !user.identities?.length ||
    user.identities.some((item) => item.provider !== 'email') ||
    (Array.isArray(user.app_metadata.providers) &&
      user.app_metadata.providers.some((provider: unknown) => provider !== 'email'))
  ) {
    throw new Error('Account deletion user ownership or provider differs');
  }
  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('stripe_customer_id, subscription_status')
    .eq('id', identity.userId)
    .single();
  if (
    profileError ||
    !profile ||
    profile.stripe_customer_id !== null ||
    profile.subscription_status !== 'free'
  ) {
    throw new Error('Account deletion requires an unbilled Free user');
  }
  for (const table of EXTERNAL_TABLES) {
    const { count, error } = await admin
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('user_id', identity.userId);
    if (error || count !== 0)
      throw new Error('Account deletion requires no external OAuth grants or tokens');
  }
}

/** UI success must be followed by positive Auth-absence evidence before recording deletion. */
export async function confirmAccountDeletionUserAbsent(
  admin: AdminSupabase,
  identity: AccountDeletionIdentity,
) {
  if (ownedUsers.get(admin)?.get(identity.userId) !== identity.runId)
    throw new Error('Account deletion user is not owned');
  if (await readAuthUser(admin, identity.userId))
    throw new Error('Account deletion Auth user remains');
  recordPreviewUser(identity.userId, 'deleted');
  ownedUsers.get(admin)!.delete(identity.userId);
}

/** Interrupted UI flows can reclaim only the user created here and still marked for this run. */
export async function cleanupAccountDeletionUser(
  admin: AdminSupabase,
  identity: AccountDeletionIdentity,
) {
  if (ownedUsers.get(admin)?.get(identity.userId) !== identity.runId) return;
  try {
    const user = await readAuthUser(admin, identity.userId);
    if (!user) {
      await confirmAccountDeletionUserAbsent(admin, identity);
      return;
    }
    if (!belongsToRun(user, identity))
      throw new Error('Account deletion cleanup ownership differs');
    // Auth deletion cascades only this synthetic user's rows. No provider calls.
    const { error } = await admin.auth.admin.deleteUser(identity.userId);
    if (error) throw new Error();
    await confirmAccountDeletionUserAbsent(admin, identity);
  } catch {
    recordPreviewUser(identity.userId, 'cleanup-failed');
    throw new Error('Account deletion owned cleanup failed');
  }
}
