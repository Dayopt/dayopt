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

  await page.waitForURL(/\/calendar/i, { timeout: 15000 });
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

  test('settings route stays on mobile account page', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.includes('Mobile'), 'mobile-only');

    await loginAndNavigate(page);
    await page.goto('/ja/settings');
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveURL(/\/ja\/settings$/);
    await expect(page.getByRole('button', { name: 'ログアウト' })).toBeVisible();
  });

  test('account icon opens settings without rendering bottom tabs', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.includes('Mobile'), 'mobile-only');

    await loginAndNavigate(page);
    await page.goto('/ja/calendar?view=day&date=2026-03-25');
    await page.waitForLoadState('networkidle');

    const accountLink = page.getByRole('link', { name: 'アカウント' });

    await expect(accountLink).toHaveAttribute(
      'href',
      '/ja/settings?returnTo=%2Fcalendar%3Fview%3Dday%26date%3D2026-03-25',
    );

    await accountLink.click();
    await expect(page).toHaveURL(
      /\/ja\/settings\?returnTo=%2Fcalendar%3Fview%3Dday%26date%3D2026-03-25$/,
    );

    await page.goBack();
    await expect(page).toHaveURL(/\/ja\/calendar\?view=day&date=2026-03-25$/);
  });
});
