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
        await expect(page.locator('input[type="password"]').first()).toBeVisible();
      },
    );
    const prefix = scenario.locale === 'ja' ? '/ja' : '';
    test(`${scenario.locale}: password reset から login へ locale を保って戻る`, async ({
      page,
    }) => {
      await page.goto(scenario.loginPath);
      await page.locator(`a[href="${prefix}/auth/password"]`).click();
      await expect(page).toHaveURL(new RegExp(`${prefix}/auth/password/?$`));
      await expect(page.locator('input[type="email"]')).toBeVisible();
      await page.locator(`a[href="${scenario.loginPath}"]`).click();
      await expect(page).toHaveURL(new RegExp(`${scenario.loginPath}/?$`));
      await expect(page.locator('input[type="password"]')).toBeVisible();
    });

    for (const route of [
      '/',
      '/settings',
      '/settings/account',
      '/settings/display',
      '/settings/data',
      '/settings/integrations',
      '/settings/billing',
    ]) {
      test(`${scenario.locale}: 未認証の ${route} は login へ戻る`, async ({ page }) => {
        await page.goto(`${prefix}${route}`);
        await expect(page).toHaveURL(new RegExp(`${scenario.loginPath}\\?`));
        expect(new URL(page.url()).searchParams.get('redirect')).toBe(route);
        await expect(page.locator('input[type="email"]')).toBeVisible();
        await expect(page.locator('input[type="password"]')).toBeVisible();
      });
    }

    test(
      `${scenario.locale}: mobile signup と reset のタップ導線が locale を保つ`,
      { tag: '@mobile' },
      async ({ page }) => {
        await page.goto(scenario.loginPath);
        await page.getByRole('link', { name: scenario.signupLink }).tap();
        await expect(page).toHaveURL(new RegExp(`${scenario.signupPath}/?$`));
        await expect(page.locator('input[type="password"]').first()).toBeVisible();
        await expect(page.locator('input[type="password"]').first()).toBeVisible();
        await page.locator(`a[href="${scenario.loginPath}"]`).tap();
        await expect(page).toHaveURL(new RegExp(`${scenario.loginPath}/?$`));
        await page.locator(`a[href="${prefix}/auth/password"]`).tap();
        await expect(page).toHaveURL(new RegExp(`${prefix}/auth/password/?$`));
        await page.locator(`a[href="${scenario.loginPath}"]`).tap();
        await expect(page).toHaveURL(new RegExp(`${scenario.loginPath}/?$`));
        await expect(page.locator('input[type="password"]')).toBeVisible();
      },
    );
  }
});
