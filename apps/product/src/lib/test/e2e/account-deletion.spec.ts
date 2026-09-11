import { expect, type Page, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/database';
import {
  assertServiceRoleSuiteRunnable,
  resolveServiceRoleTarget,
} from '../service-role-target-guard';
import { suppressConsentBanner } from './suppress-consent-banner';

/**
 * アカウント削除 E2E — 削除フローを実 UI 操作で通し、セッション失効と
 * 再ログイン拒否まで検証する
 *
 * 「削除 mutation が実装されている」ではなく、設定画面からパスワード再確認 +
 * 確認テキスト「DELETE」入力で実際にアカウントを削除し、
 * - 削除後にログインページへリダイレクトされる
 * - セッションが失効し、保護ページへ行くと未認証としてログインへ戻される
 * - 同一資格情報での再ログインが拒否される
 * ところまでを一連の flow として検証する。
 *
 * 共有テストユーザー（TEST_USER_EMAIL / TEST_USER_PASSWORD）は絶対に使わない。
 * 削除の対象にしてしまうと、認証必須の他 spec を巻き添えにする。
 * spec 専用の使い捨てユーザーを service role で作って削除する
 * （billing.spec.ts / critical-path.spec.ts と同型の seed パターン）。
 * 実行先は resolveServiceRoleTarget が安全と判定した時だけ有効になる。
 *
 * 非課金ユーザー（stripe_customer_id 無し）で作成するため、削除 mutation 内の
 * Stripe 連携処理は no-op になる
 * （features/settings/server/account-deletion.ts の
 * quiesceBoundBillingAccountData / deleteBoundBillingAccountData）。
 *
 * @see Issue #1872
 * @see 決定ログ（削除済み、git 履歴参照）
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
// service role で auth user / profile を作って消すため、実行先が安全な時だけ有効にする
const SERVICE_ROLE_TARGET = resolveServiceRoleTarget(SUPABASE_URL, SUPABASE_SERVICE_KEY);
// CI（E2E_REQUIRE_SERVICE_ROLE_SUITES=1）では skip を許さない。env が壊れて suite が
// 丸ごと消えても「0 failed」で緑になるのを防ぐ。
assertServiceRoleSuiteRunnable(
  SERVICE_ROLE_TARGET,
  'Account Deletion: 削除 → セッション失効 → 再ログイン拒否',
);
const describeWithEnv = SERVICE_ROLE_TARGET.safe ? test.describe : test.describe.skip;

const TEST_RUN_ID = crypto.randomUUID();
const TEST_USER_ID = crypto.randomUUID();
const TEST_EMAIL = `account-deletion-${TEST_RUN_ID}@example.com`;
const TEST_PASSWORD = 'test-password-123';

type SupabaseClient = ReturnType<typeof createClient<Database>>;

async function login(page: Page) {
  await suppressConsentBanner(page);
  await page.goto('/ja/auth/login');
  await page.locator('input[type="email"], input[name="email"]').first().fill(TEST_EMAIL);
  await page.locator('input[type="password"]').first().fill(TEST_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/ja\/calendar/i, { timeout: 15_000 });
}

/**
 * 設定 > アカウントカテゴリへ遷移する。
 *
 * desktop は `/settings/[category]/page.tsx` が `openSettings(category)` +
 * `router.replace('/')` するため、ホームへ戻った上で SettingsDialog が開く
 * （GlobalOverlays.tsx に常駐、billing.spec.ts の openBillingSettings と同型）。
 */
async function openAccountSettings(page: Page) {
  await page.goto('/ja/settings/account');
}

describeWithEnv('Account Deletion: 削除 → セッション失効 → 再ログイン拒否', () => {
  let adminSupabase: SupabaseClient;

  test.beforeAll(async () => {
    adminSupabase = createClient<Database>(SUPABASE_URL!, SUPABASE_SERVICE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { error: authError } = await adminSupabase.auth.admin.createUser({
      id: TEST_USER_ID,
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: 'account deletion e2e' },
    });
    // CI retries:2 の再実行で "already exists" になりうるため許容する。
    // 削除が成功した後に retry が起きた場合はユーザーが実在しないため、ここは
    // "already exists" にならず同一 ID でそのまま新規作成される。
    if (authError && !authError.message.includes('already exists')) {
      throw new Error(authError.message);
    }

    // 既定は Free プラン（stripe_customer_id 無し）。削除 mutation 内の Stripe
    // 連携処理が no-op になるため、Stripe env 無しのローカル実行でも完走できる。
    const { error: profileError } = await adminSupabase.from('profiles').upsert({
      id: TEST_USER_ID,
      email: TEST_EMAIL,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (profileError) throw new Error(profileError.message);

    const { error: settingsError } = await adminSupabase.from('user_settings').upsert({
      user_id: TEST_USER_ID,
      timezone: 'Asia/Tokyo',
      preferred_locale: 'ja',
      default_view: 'day',
      default_duration: 60,
      time_format: '24h',
      week_starts_on: 1,
    });
    if (settingsError) throw new Error(settingsError.message);
  });

  test.afterAll(async () => {
    if (!adminSupabase) return;

    // テストが成功していれば auth.users 削除の CASCADE DELETE で既に消えている。
    // PostgREST の DELETE は 0 行一致でも 204 を返すため、対象が既に無いことは
    // error にならない。error が立つのは実際の失敗だけなので、そのまま記録する。
    const { error: settingsError } = await adminSupabase
      .from('user_settings')
      .delete()
      .eq('user_id', TEST_USER_ID);
    if (settingsError) {
      console.error('[account-deletion.spec] user_settings cleanup failed', settingsError);
    }

    const { error: profileError } = await adminSupabase
      .from('profiles')
      .delete()
      .eq('id', TEST_USER_ID);
    if (profileError) {
      console.error('[account-deletion.spec] profiles cleanup failed', profileError);
    }

    const { error: authDeleteError } = await adminSupabase.auth.admin.deleteUser(TEST_USER_ID);
    // 削除成功後の cleanup は「既に存在しない」が正常系（silent に握りつぶさず記録だけする）
    if (authDeleteError && !authDeleteError.message.toLowerCase().includes('not found')) {
      console.error('[account-deletion.spec] auth user cleanup failed', authDeleteError);
    }
  });

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name.includes('Mobile'),
      'desktop-only（SettingsDialog 前提の検証）',
    );
    await login(page);
  });

  test('パスワード確認 + DELETE 入力でアカウントを削除し、セッション失効と再ログイン拒否を確認する', async ({
    page,
  }) => {
    await openAccountSettings(page);

    const deleteButton = page.getByRole('button', { name: 'アカウント削除' });
    await expect(deleteButton).toBeVisible({ timeout: 10_000 });
    await deleteButton.click();

    const dialog = page.getByRole('alertdialog', { name: 'アカウント削除の確認' });
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // hasPasswordIdentity が true（email/password で作成したユーザー）なので必須
    await dialog.getByLabel('パスワードで確認').fill(TEST_PASSWORD);
    await dialog.getByLabel('確認のため「DELETE」と入力').fill('DELETE');

    const confirmButton = dialog.getByRole('button', { name: '削除を実行' });
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();

    // AccountDeletionDialog.tsx onSuccess: signOut() → window.location.href = '/auth/login'
    await page.waitForURL(/\/auth\/login/, { timeout: 15_000 });

    // セッション失効: 保護ページへ行くと未認証としてログインへ戻される
    await page.goto('/ja/calendar');
    await expect(page).toHaveURL(/\/ja\/auth\/login/, { timeout: 10_000 });

    // 同一資格情報で再ログインすると失敗する。
    //
    // 待つ対象はサーバーエラーの FieldError と invalidCredentials の文言に限定する。
    // `.text-destructive` を含む複合 locator では、必須ラベルの「＊」マーカー
    // （field.tsx が required に付ける）が送信前から可視なため即座に一致してしまい、
    // 削除が効かず再ログインが成功する regression でもテストが green になる。
    // role="alert" が付くのは announceImmediately の FieldError（= サーバーエラー）
    // だけだが、Next.js の route announcer も role="alert" を持つため
    // data-slot でさらに絞る。
    await page.goto('/ja/auth/login');
    await page.locator('input[type="email"], input[name="email"]').first().fill(TEST_EMAIL);
    await page.locator('input[type="password"]').first().fill(TEST_PASSWORD);
    await page.locator('button[type="submit"]').first().click();
    await expect(page.locator('[role="alert"][data-slot="field-error"]')).toContainText(
      'メールアドレスまたはパスワードが正しくありません',
      { timeout: 10_000 },
    );
    // 認証が通っていないこと自体も確認する（成功していれば /ja/calendar へ抜ける）
    await expect(page).toHaveURL(/\/auth\/login/);
  });
});
