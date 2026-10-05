import { expect, test } from '@playwright/test';

import { resolveServiceRoleTarget } from '../service-role-target-guard';
import {
  createScopedTestUser,
  deleteScopedTestUser,
  type ScopedTestUser,
} from './create-scoped-test-user';

/**
 * Mobile Navigation E2E
 *
 * Calendar 1画面化後の mobile shell regression guard:
 * フッターはアクティビティ作成専用にし、アカウント導線は右上 icon から設定へ遷移する。
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY;
const SERVICE_ROLE_TARGET = resolveServiceRoleTarget(SUPABASE_URL, SERVICE_ROLE_KEY);

let testUser: ScopedTestUser | undefined;

async function loginAndNavigate(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  const passwordInput = page.locator('input[type="password"]').first();
  const submitButton = page.locator('button[type="submit"]').first();

  await emailInput.fill(testUser!.email);
  await passwordInput.fill(testUser!.password);
  await submitButton.click();

  await page.waitForURL(/\/(?:ja\/?)?(?:\?.*)?$/i, { timeout: 15000 });
}

test.describe('Mobile Navigation', () => {
  test.skip(!SERVICE_ROLE_TARGET.safe, SERVICE_ROLE_TARGET.safe ? '' : SERVICE_ROLE_TARGET.reason);

  test.beforeAll(async () => {
    if (!SERVICE_ROLE_TARGET.safe) return;
    testUser = await createScopedTestUser(SUPABASE_URL!, SERVICE_ROLE_KEY!, 'mobile-nav');
  });

  test.afterAll(async () => {
    if (!testUser) return;
    await deleteScopedTestUser(SUPABASE_URL!, SERVICE_ROLE_KEY!, testUser.userId);
  });

  test(
    'settings route stays on mobile account page',
    { tag: '@mobile' },
    async ({ page }, testInfo) => {
      test.skip(!testInfo.project.name.includes('Mobile'), 'mobile-only');

      await loginAndNavigate(page);
      await page.goto('/ja/settings');
      await page.waitForLoadState('networkidle');

      await expect(page).toHaveURL(/\/ja\/settings$/);
      // mobile は /settings を一覧ページとして描く（desktop のように account 詳細へ飛ばさない）。
      // 旧 assertion の「ログアウト」ボタンは文言変更（サインアウト）と account 詳細への移設で
      // 消えていたが、Mobile Chrome が CI 対象外だった間この test は一度も走らず腐っていた（#2743）。
      await expect(page.getByRole('heading', { level: 1, name: 'アカウント' })).toBeVisible();
      await expect(
        page.getByRole('heading', { level: 2, name: '設定', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { level: 2, name: 'データ', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { level: 2, name: 'プラン', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { level: 2, name: 'サポート', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { level: 2, name: 'その他', exact: true }),
      ).toBeVisible();
      await expect(page.getByText('月 $5 で利用する', { exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'アカウント', exact: true })).toHaveAttribute(
        'href',
        '/ja/settings/account',
      );
      await expect(page.getByRole('link', { name: '表示', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'データ', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: '連携', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: '請求', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'リリースノート', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'ドキュメント', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'お問い合わせ', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'サインアウト', exact: true })).toBeVisible();

      await page.getByRole('button', { name: '法的情報', exact: true }).click();
      await expect(page.getByRole('link', { name: '利用規約', exact: true })).toBeVisible();
    },
  );

  test(
    'account icon opens settings without rendering bottom tabs',
    { tag: '@mobile' },
    async ({ page }, testInfo) => {
      test.skip(!testInfo.project.name.includes('Mobile'), 'mobile-only');

      await loginAndNavigate(page);
      await page.goto('/ja/?view=day&date=2026-03-25');
      await page.waitForLoadState('networkidle');

      const accountLink = page.getByRole('link', { name: 'アカウント' });

      await expect(accountLink).toHaveAttribute(
        'href',
        '/ja/settings?returnTo=%2F%3Fview%3Dday%26date%3D2026-03-25',
      );

      await accountLink.click();
      await expect(page).toHaveURL(
        /\/ja\/settings\?returnTo=%2F%3Fview%3Dday%26date%3D2026-03-25$/,
      );

      await page.goBack();
      await expect(page).toHaveURL(/\/ja\/?\?view=day&date=2026-03-25$/);
    },
  );
});
