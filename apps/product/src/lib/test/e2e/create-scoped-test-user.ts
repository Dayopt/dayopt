import type { createClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/database';
import { resolvePreviewCloudUserId } from '../preview-cloud-identity';
import { recordPreviewUser } from '../preview-user-lifecycle';
import { createAdminSupabase } from './critical-path-fixture';

/** Local specs retain separate users. Cloud specs reuse the two preallocated IDs sequentially. */
export interface ScopedTestUser {
  email: string;
  password: string;
  userId: string;
}

const CLOUD_SCOPES = new Set([
  'auth',
  'a11y',
  'calendar-navigation',
  'block-search',
  'plan-record',
  'deep-link',
  'initial-load',
  'derived-plan-record',
  'conflict',
  'drag-move',
  'repro',
  'mobile-nav',
  'billing',
]);

type AdminClient = ReturnType<typeof createClient<Database>>;
const ownedUsers = new Map<string, { admin: AdminClient; key: string }>();

/** scope + project select a reviewed allocation; no Cloud fallback to a random ID. */
export async function createScopedTestUser(
  supabaseUrl: string,
  serviceRoleKey: string,
  scope: string,
  project?: string,
): Promise<ScopedTestUser> {
  const prefix = project === 'Mobile Chrome' ? 'mobile-critical-path' : 'critical-path';
  const cloudUserId = resolvePreviewCloudUserId(prefix);
  if (
    cloudUserId &&
    (!CLOUD_SCOPES.has(scope) ||
      !['chromium', 'Mobile Chrome'].includes(project ?? '') ||
      !process.env.E2E_PREVIEW_EVIDENCE_DIR)
  ) {
    throw new Error('Preview Cloud scoped identity configuration is invalid');
  }
  const userId = cloudUserId ?? crypto.randomUUID();
  const ownerKey = `${supabaseUrl}/${userId}`;
  if (ownedUsers.has(ownerKey))
    throw new Error('E2E synthetic user is still owned by another scope');
  const nonce = crypto.randomUUID();
  const email = cloudUserId
    ? `${prefix}-${nonce}@example.com`
    : `e2e-${scope}-${nonce}@example.com`;
  const password = `E2e-${nonce}`;
  const admin = createAdminSupabase(supabaseUrl, serviceRoleKey);
  recordPreviewUser(userId, 'creating');
  let created = false;
  try {
    const { data, error } = await admin.auth.admin.createUser({
      id: userId,
      email,
      password,
      email_confirm: true,
      ...(cloudUserId ? { app_metadata: { e2e_run_id: process.env.E2E_PREVIEW_RUN_ID } } : {}),
      user_metadata: { full_name: `e2e ${scope} user` },
    });
    created = !error && data.user?.id === userId;
  } catch {
    // Provider errors may contain credentials; only the durable state is retained.
    created = false;
  }
  if (!created) {
    recordPreviewUser(userId, 'creation-unconfirmed');
    throw new Error('E2E synthetic user creation failed');
  }
  ownedUsers.set(ownerKey, { admin, key: serviceRoleKey });
  recordPreviewUser(userId, 'created');
  let profileReady = false;
  try {
    const { error } = await admin.from('profiles').upsert({
      id: userId,
      email,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    profileReady = !error;
  } catch {
    profileReady = false;
  }
  if (!profileReady) {
    await deleteScopedTestUser(supabaseUrl, serviceRoleKey, userId);
    throw new Error('E2E synthetic profile setup failed');
  }
  return { email, password, userId };
}

/** Only successfully created users owned by this target/client are eligible for cleanup. */
export async function deleteScopedTestUser(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
): Promise<void> {
  const ownerKey = `${supabaseUrl}/${userId}`;
  const owned = ownedUsers.get(ownerKey);
  if (!owned || owned.key !== serviceRoleKey) return;
  const { admin } = owned;
  const failures: string[] = [];
  const operations = [
    ['records', () => admin.from('records').delete().eq('user_id', userId)],
    ['plans', () => admin.from('plans').delete().eq('user_id', userId)],
    ['activities', () => admin.from('activities').delete().eq('user_id', userId)],
    ['categories', () => admin.from('categories').delete().eq('user_id', userId)],
    ['user_settings', () => admin.from('user_settings').delete().eq('user_id', userId)],
    ['profiles', () => admin.from('profiles').delete().eq('id', userId)],
    ['auth', () => admin.auth.admin.deleteUser(userId)],
  ] as const;
  for (const [table, remove] of operations) {
    try {
      const { error } = await remove();
      if (error) failures.push(table);
    } catch {
      failures.push(table);
    }
  }
  if (failures.length) {
    recordPreviewUser(userId, 'cleanup-failed');
    throw new Error(`E2E synthetic cleanup failed: ${failures.join(', ')}`);
  }
  recordPreviewUser(userId, 'deleted');
  ownedUsers.delete(ownerKey);
}
