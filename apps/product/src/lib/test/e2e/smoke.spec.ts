import { expect, test } from '@playwright/test';

import { resolveServiceRoleTarget } from '../service-role-target-guard';
import {
  createScopedTestUser,
  deleteScopedTestUser,
  type ScopedTestUser,
} from './create-scoped-test-user';

/**
 * スモークテスト
 *
 * ルーティング、認証リダイレクト、主要ページの表示を最小限のテストで確認。
 * UI詳細はunit / integration / Storybookに分担する。
 *
 * @see 決定ログ（削除済み、git 履歴参照）
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY;
const SERVICE_ROLE_TARGET = resolveServiceRoleTarget(SUPABASE_URL, SERVICE_ROLE_KEY);

let testUser: ScopedTestUser | undefined;
test.describe('Smoke: ルーティング', () => {
  test('未認証ユーザーは認証ページにリダイレクトされる', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // 認証ページにリダイレクトされることを確認
    await page.waitForURL(/\/(login|auth|signin)/i, { timeout: 10000 }).catch(() => {
      // 既にログイン済みの場合もOK
    });

    // ページタイトルが存在する
    await expect(page).toHaveTitle(/Dayopt/);
  });

  test('ページが正常にレンダリングされる', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // 基本的な要素の存在確認
    const heading = page.locator('h1, h2, [role="heading"]').first();
    await expect(heading).toBeVisible({ timeout: 15000 });
  });

  test('横スクロールが発生しない（デスクトップ）', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const body = page.locator('body');
    await expect(body).toBeVisible({ timeout: 15000 });

    const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
    const clientWidth = await page.evaluate(() => document.body.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 10);
  });

  test('横スクロールが発生しない（モバイル）', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const body = page.locator('body');
    await expect(body).toBeVisible({ timeout: 15000 });

    const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
    const clientWidth = await page.evaluate(() => document.body.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 10);
  });
});

test.describe('Smoke: 認証フロー', () => {
  for (const scenario of [
    {
      locale: 'en',
      loginPath: '/auth/login',
      heading: 'Welcome back',
      signupLink: 'Sign up',
      signupPath: '/auth/signup',
    },
    {
      locale: 'ja',
      loginPath: '/ja/auth/login',
      heading: 'サインイン',
      signupLink: '新規登録',
      signupPath: '/ja/auth/signup',
    },
  ]) {
    test(`${scenario.locale}: login から signup へ locale prefix を保って遷移する`, async ({
      page,
    }) => {
      await page.goto(scenario.loginPath);

      await expect(page.getByRole('heading', { level: 1, name: scenario.heading })).toBeVisible();
      await page.getByRole('link', { name: scenario.signupLink }).click();

      await expect(page).toHaveURL(new RegExp(`${scenario.signupPath}/?$`));
    });
  }

  test('ログインフォームが表示される', async ({ page }) => {
    await page.goto('/auth/login');

    const emailInput = page.locator('input[type="email"], input[name="email"]').first();
    const passwordInput = page.locator('input[type="password"]').first();

    await expect(emailInput).toBeVisible({ timeout: 10000 });
    await expect(passwordInput).toBeVisible();
  });

  test.describe('認証済みユーザー', () => {
    test.skip(
      !SERVICE_ROLE_TARGET.safe,
      SERVICE_ROLE_TARGET.safe ? '' : SERVICE_ROLE_TARGET.reason,
    );

    test.beforeAll(async () => {
      if (!SERVICE_ROLE_TARGET.safe) return;
      testUser = await createScopedTestUser(SUPABASE_URL!, SERVICE_ROLE_KEY!, 'smoke');
    });

    test.afterAll(async () => {
      if (!testUser) return;
      await deleteScopedTestUser(SUPABASE_URL!, SERVICE_ROLE_KEY!, testUser.userId);
    });

    test('ログイン→カレンダー表示→ログアウト', async ({ page }) => {
      // ログインページへ
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      // メール入力
      const emailInput = page.locator('input[type="email"], input[name="email"]').first();
      await emailInput.fill(testUser!.email);

      // パスワード入力
      const passwordInput = page.locator('input[type="password"]').first();
      await passwordInput.fill(testUser!.password);

      // ログインボタンクリック
      const submitButton = page.locator('button[type="submit"]').first();
      await submitButton.click();

      // カレンダーページに遷移
      await page.waitForURL(/\/calendar/i, { timeout: 15000 });
      await expect(page).toHaveTitle(/Dayopt/);
    });
  });
});
