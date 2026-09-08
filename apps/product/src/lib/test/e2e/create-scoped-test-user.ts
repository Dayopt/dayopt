import { createClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/database';

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
  const admin = createAdminClient(supabaseUrl, serviceRoleKey);
  const runId = crypto.randomUUID();
  const email = `e2e-${scope}-${runId}@example.com`;
  const password = `E2e-${runId}`;

  const { data, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `e2e ${scope} user` },
  });
  if (authError || !data.user) {
    throw new Error(authError?.message ?? `createUser failed for scope=${scope}`);
  }
  const userId = data.user.id;

  const { error: profileError } = await admin.from('profiles').upsert({
    id: userId,
    email,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (profileError) throw new Error(profileError.message);

  return { email, password, userId };
}

/** createScopedTestUser で作った user を service role で削除する。 */
export async function deleteScopedTestUser(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
): Promise<void> {
  const admin = createAdminClient(supabaseUrl, serviceRoleKey);
  await admin.auth.admin.deleteUser(userId);
}
