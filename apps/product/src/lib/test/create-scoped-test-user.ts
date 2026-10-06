import { createClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/database';

import { resolveServiceRoleTarget } from './service-role-target-guard';

const ownedUsers = new Map<string, Set<string>>();

function safeOrigin(url: string, key: string) {
  if (!resolveServiceRoleTarget(url, key).safe) {
    throw new Error('E2E synthetic user target is unsafe');
  }
  return new URL(url).origin;
}

/**
 * spec ファイルごとに専用の使い捨て test user を service role で作成する。
 *
 * 旧実装は全 E2E spec が単一の `TEST_USER_EMAIL` / `TEST_USER_PASSWORD`
 * （`scripts/ci/create-e2e-test-user.mjs` が発行）を共有していたため、
 * `workers` 並列実行下で procedures.ts の in-memory rate limiter（userId 単位
 * 300req/60s。#2669 までは 100）を spec 間で共有し、閾値超過で calendar data の取得が
 * timeout する不具合があった（#2246）。spec ごとに account を分離することで、
 * rate limit の予算も spec 単位に分離する。
 *
 * `block-search.spec.ts` 等が既に使う service-role seed パターンと同じ経路
 * （`supabase-js` の `auth.admin.createUser` + `profiles` upsert）を使う。
 * plan/record 等の重い fixture が要る spec は呼び出し元で追加で作る。
 */
export interface ScopedTestUser {
  email: string;
  password: string;
  userId: string;
}

function createAdminClient(supabaseUrl: string, serviceRoleKey: string) {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** scope（呼び出し元 spec 名）ごとに一意な email で test user を作成する。 */
export async function createScopedTestUser(
  supabaseUrl: string,
  serviceRoleKey: string,
  scope: string,
): Promise<ScopedTestUser> {
  const origin = safeOrigin(supabaseUrl, serviceRoleKey);
  const admin = createAdminClient(supabaseUrl, serviceRoleKey);
  const runId = crypto.randomUUID();
  const email = `e2e-${scope}-${runId}@example.com`;
  const password = `E2e-${runId}`;

  const creation = await admin.auth.admin
    .createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: `e2e ${scope} user` },
    })
    .catch(() => {
      throw new Error('E2E synthetic user creation failed');
    });
  if (creation.error || !creation.data.user) {
    throw new Error('E2E synthetic user creation failed');
  }
  const userId = creation.data.user.id;
  const owned = ownedUsers.get(origin) ?? new Set<string>();
  owned.add(userId);
  ownedUsers.set(origin, owned);

  const profile = await admin
    .from('profiles')
    .upsert({
      id: userId,
      email,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .then(
      (result) => ({ failed: result.error !== null }),
      () => ({ failed: true }),
    );
  if (profile.failed) {
    await deleteScopedTestUser(supabaseUrl, serviceRoleKey, userId);
    throw new Error('E2E synthetic profile setup failed');
  }

  return { email, password, userId };
}

/** createScopedTestUser で作った user を service role で削除する。 */
export async function deleteScopedTestUser(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
): Promise<void> {
  const origin = safeOrigin(supabaseUrl, serviceRoleKey);
  const owned = ownedUsers.get(origin);
  if (!owned?.has(userId)) throw new Error('E2E synthetic user ownership is unconfirmed');
  const admin = createAdminClient(supabaseUrl, serviceRoleKey);
  const { error } = await admin.auth.admin.deleteUser(userId).catch(() => {
    throw new Error('E2E synthetic user cleanup failed');
  });
  if (error && !(error.code === 'user_not_found' && error.status === 404)) {
    throw new Error('E2E synthetic user cleanup failed');
  }
  const readback = await admin.auth.admin.getUserById(userId).catch(() => {
    throw new Error('E2E synthetic user cleanup is unconfirmed');
  });
  if (
    readback.data.user ||
    readback.error?.code !== 'user_not_found' ||
    readback.error.status !== 404
  ) {
    throw new Error('E2E synthetic user cleanup is unconfirmed');
  }
  owned.delete(userId);
  if (owned.size === 0) ownedUsers.delete(origin);
}
