import { expect, test } from '@playwright/test';

import { resolveServiceRoleTarget } from '../service-role-target-guard';
import {
  createScopedTestUser,
  deleteScopedTestUser,
  type ScopedTestUser,
} from './create-scoped-test-user';

/**
 * Deep Link E2E
 *
 * `/calendar`（view はクエリで受ける）への direct access が SSR で正常描画され、
 * Sidebar が初回レンダリングから表示されることを検証する。
 *
 * 旧 URL（/day, /week, /Nday, `?panel=`）からの redirect 網羅は
 * `legacy-url-redirects.spec.ts` を正とする
 * （旧 docs/projects/_archive/workspace-shell-restructure/overview.md §4-4、
 * docs/projects 全廃に伴い #2473 で削除。git 履歴参照）。
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

test.describe('Deep Link: SSR rendering of /calendar', () => {
  test.skip(!SERVICE_ROLE_TARGET.safe, SERVICE_ROLE_TARGET.safe ? '' : SERVICE_ROLE_TARGET.reason);

  test.beforeAll(async () => {
    if (!SERVICE_ROLE_TARGET.safe) return;
    testUser = await createScopedTestUser(SUPABASE_URL!, SERVICE_ROLE_KEY!, 'deep-link');
  });

  test.afterAll(async () => {
    if (!testUser) return;
    await deleteScopedTestUser(SUPABASE_URL!, SERVICE_ROLE_KEY!, testUser.userId);
  });

  test('calendar week renders with sidebar on direct access', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.includes('Mobile'), 'desktop-only');

    await loginAndNavigate(page);

    // 直接 /calendar?view=week に遷移
    await page.goto('/ja/calendar?view=week&date=2026-04-20');
    await expect(page).toHaveURL(/\/ja\/calendar\?view=week&date=2026-04-20/);

    // Sidebar が初回レンダリングから表示されている（現 shell は <aside> = complementary landmark）
    const sidebar = page.getByRole('complementary').first();
    await expect(sidebar).toBeVisible();

    // Calendar グリッドが deep link 直後から描画される
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });

    // view 種別の assert: week は複数日カラムを持つ（day view=1 列と区別する）
    await expect(page.locator('[data-calendar-grid]')).not.toHaveCount(1);
  });

  test('prefixless default-locale calendar renders only its own visible header', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.includes('Mobile'), 'desktop-only');

    await loginAndNavigate(page);

    await page.goto('/calendar?view=day&date=2026-04-20');
    await expect(page).toHaveURL(/\/calendar\?view=day&date=2026-04-20/);
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });

    // view 種別の assert: day view は単一カラムのみ
    await expect(page.locator('[data-calendar-grid]')).toHaveCount(1);

    // CalendarLayout は responsive header を2つDOMに持つため、実際に表示中のheaderを数える。
    // shell側のlocale誤判定が再発すると、desktopでvisible headerが2つになる。
    await expect(page.locator('header:visible')).toHaveCount(1);
  });

  test('/calendar without view defaults to week', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.includes('Mobile'), 'desktop-only');

    await loginAndNavigate(page);

    await page.goto('/ja/calendar?date=2026-04-20');
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-calendar-grid]')).not.toHaveCount(1);
  });

  test('out-of-range multi-day view (8day) returns 404', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.includes('Mobile'), 'desktop-only');

    await loginAndNavigate(page);

    const response = await page.goto('/ja/calendar?view=8day&date=2026-04-20');
    expect(response?.status()).toBe(404);
  });
});
