import { expect } from '@playwright/test';

import { test } from './preview-access-fixture';

/**
 * スモークテスト
 *
 * ルーティング、認証リダイレクト、主要ページの表示を最小限のテストで確認。
 * UI詳細はunit / integration / Storybookに分担する。
 *
 * @see 決定ログ（削除済み、git 履歴参照）
 */

test.describe('Smoke: ルーティング', () => {
  test(
    '未認証ユーザーは認証ページにリダイレクトされる',
    { tag: '@preview-e2e/product-smoke-unauth-redirect' },
    async ({ page }) => {
      await page.goto('/');
      await page.waitForURL(/\/(?:ja\/)?auth\/login(?:\/|\?|$)/i, { timeout: 10_000 });
      await expect(page.locator('input[type="email"], input[name="email"]').first()).toBeVisible();

      await expect(page).toHaveTitle(/Dayopt/);
    },
  );
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
    test(
      `${scenario.locale}: login から signup へ locale prefix を保って遷移する`,
      { tag: `@preview-e2e/product-smoke-${scenario.locale}-signup-locale` },
      async ({ page }) => {
        await page.goto(scenario.loginPath);

        await expect(page.getByRole('heading', { level: 1, name: scenario.heading })).toBeVisible();
        await page.getByRole('link', { name: scenario.signupLink }).click();

        await expect(page).toHaveURL(new RegExp(`${scenario.signupPath}/?$`));
      },
    );
  }
});
