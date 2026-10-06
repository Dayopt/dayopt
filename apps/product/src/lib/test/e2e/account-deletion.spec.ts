import { expect, type Page } from '@playwright/test';

import {
  assertServiceRoleSuiteRunnable,
  resolveServiceRoleTarget,
} from '../service-role-target-guard';
import {
  assertAccountDeletionUserSafe,
  cleanupAccountDeletionUser,
  confirmAccountDeletionUserAbsent,
  createAccountDeletionIdentity,
  seedAccountDeletionUser,
} from './account-deletion-fixture';
import { createAdminSupabase, type AdminSupabase } from './critical-path-fixture';
import { test } from './preview-access-fixture';
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
 * 専用の使い捨てユーザーを service role で作る。Cloud は third allocation のみ使い、
 * 作成前journal・現run marker・Free/Stripe未接続/OAuth未接続を確認する。
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

const identity = createAccountDeletionIdentity();

async function login(page: Page) {
  await suppressConsentBanner(page);
  await page.goto('/ja/auth/login');
  await page.locator('input[type="email"], input[name="email"]').first().fill(identity.email);
  await page.locator('input[type="password"]').first().fill(identity.password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/ja\/?(?:\?.*)?$/i, { timeout: 15_000 });
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
  let adminSupabase: AdminSupabase;

  test.beforeAll(async () => {
    adminSupabase = createAdminSupabase(SUPABASE_URL!, SUPABASE_SERVICE_KEY!);
    await seedAccountDeletionUser(adminSupabase, identity);
  });

  test.afterAll(async () => {
    if (!adminSupabase) return;
    await cleanupAccountDeletionUser(adminSupabase, identity);
  });

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name.includes('Mobile'),
      'desktop-only（SettingsDialog 前提の検証）',
    );
    await login(page);
  });

  test(
    'パスワード確認 + DELETE 入力でアカウントを削除し、セッション失効と再ログイン拒否を確認する',
    { tag: '@preview-e2e/product-account-deletion' },
    async ({ page }) => {
      await openAccountSettings(page);

      const deleteButton = page.getByRole('button', { name: 'アカウント削除' });
      await expect(deleteButton).toBeVisible({ timeout: 10_000 });
      await deleteButton.click();

      const dialog = page.getByRole('alertdialog', { name: 'アカウント削除の確認' });
      await expect(dialog).toBeVisible({ timeout: 10_000 });

      // hasPasswordIdentity が true（email/password で作成したユーザー）なので必須
      await dialog.getByLabel('パスワードで確認').fill(identity.password);
      await dialog.getByLabel('確認のため「DELETE」と入力').fill('DELETE');

      const confirmButton = dialog.getByRole('button', { name: '削除を実行' });
      await expect(confirmButton).toBeEnabled();
      await assertAccountDeletionUserSafe(adminSupabase, identity);
      await confirmButton.click();

      // signOut・locale redirect の途中の document load は待たず、最終画面の成立を待つ。
      // URL だけでは未完了の遷移も通るため、ログインフォームの表示も確認する。
      await expect(page).toHaveURL(/\/ja\/auth\/login(?:\?|$)/, { timeout: 15_000 });
      await expect(page.locator('input[name="email"]')).toBeVisible();
      await expect(page.locator('input[name="password"]')).toBeVisible();
      await confirmAccountDeletionUserAbsent(adminSupabase, identity);

      // セッション失効: 保護ページへ行くと未認証としてログインへ戻される
      await page.goto('/ja/');
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
      await page.locator('input[type="email"], input[name="email"]').first().fill(identity.email);
      await page.locator('input[type="password"]').first().fill(identity.password);
      await page.locator('button[type="submit"]').first().click();
      await expect(page.locator('[role="alert"][data-slot="field-error"]')).toContainText(
        'メールアドレスまたはパスワードが正しくありません',
        { timeout: 10_000 },
      );
      // 認証が通っていないこと自体も確認する（成功していれば /ja/ へ抜ける）
      await expect(page).toHaveURL(/\/auth\/login/);
    },
  );
});
