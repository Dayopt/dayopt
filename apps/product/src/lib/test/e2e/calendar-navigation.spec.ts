import { expect, type Page, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/database';

import {
  assertServiceRoleSuiteRunnable,
  resolveServiceRoleTarget,
} from '../service-role-target-guard';
import { suppressConsentBanner } from './suppress-consent-banner';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const SERVICE_ROLE_TARGET = resolveServiceRoleTarget(SUPABASE_URL, SUPABASE_SERVICE_KEY);
// CI（E2E_REQUIRE_SERVICE_ROLE_SUITES=1）では skip を許さない。env が壊れて suite が
// 丸ごと消えても「0 failed」で緑になるのを防ぐ。
assertServiceRoleSuiteRunnable(SERVICE_ROLE_TARGET, 'Calendar navigation');
const describeWithEnv = SERVICE_ROLE_TARGET.safe ? test.describe : test.describe.skip;

const TIMEZONE = 'Asia/Tokyo';
const TEST_DATE = '2026-04-20';
const TEST_RUN_ID = crypto.randomUUID();
const TEST_USER_ID = crypto.randomUUID();
const TEST_EMAIL = `calendar-navigation-${TEST_RUN_ID}@example.com`;
const TEST_PASSWORD = 'test-password-123';

type SupabaseClient = ReturnType<typeof createClient<Database>>;

async function expectCalendarUrl(page: Page, expected: { pathname: string; date: string }) {
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return {
        pathname: url.pathname,
        date: url.searchParams.get('date'),
      };
    })
    .toEqual({
      pathname: expected.pathname,
      date: expected.date,
    });
}

async function login(page: Page) {
  await suppressConsentBanner(page);
  await page.goto('/ja/auth/login');
  await page.locator('input[type="email"], input[name="email"]').first().fill(TEST_EMAIL);
  await page.locator('input[type="password"]').first().fill(TEST_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/ja\/calendar/i, { timeout: 15_000 });
  await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
}

describeWithEnv('Calendar navigation', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ timezoneId: TIMEZONE });

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
      user_metadata: { full_name: 'calendar navigation e2e' },
    });
    if (authError && !authError.message.includes('already exists')) {
      throw new Error(authError.message);
    }

    await adminSupabase.from('profiles').upsert({
      id: TEST_USER_ID,
      email: TEST_EMAIL,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await adminSupabase.from('user_settings').upsert({
      user_id: TEST_USER_ID,
      timezone: TIMEZONE,
      preferred_locale: 'ja',
      default_view: 'day',
      default_duration: 60,
      time_format: '24h',
      week_starts_on: 1,
    });
  });

  test.afterAll(async () => {
    if (!adminSupabase) return;
    await adminSupabase.from('user_settings').delete().eq('user_id', TEST_USER_ID);
    await adminSupabase.from('profiles').delete().eq('id', TEST_USER_ID);
    await adminSupabase.auth.admin.deleteUser(TEST_USER_ID);
  });

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.includes('Mobile'), 'desktop-only');
    await login(page);
    await page.goto(`/ja/calendar?view=day&date=${TEST_DATE}`);
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
  });

  // カレンダー内 review panel（CalendarReviewRail）は廃止済み（#2181 Step 4）。
  // 振り返りは /report へのタブ遷移に置き換わった（Step 6 で旧 panel 経路を削除）。
  test('レポートタブとviewを実UI操作・reload・browser backで復元する', async ({ page }) => {
    const reportTab = page.getByRole('tab', { name: 'レポート' });
    const calendarTab = page.getByRole('tab', { name: 'カレンダー' });

    await reportTab.click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/ja/report');
    await expect.poll(() => new URL(page.url()).searchParams.get('date')).toBe(TEST_DATE);

    await page.reload();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/ja/report');

    await calendarTab.click();
    await expectCalendarUrl(page, { pathname: '/ja/calendar', date: TEST_DATE });
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: '日', exact: true }).click();
    await page.getByRole('menuitem', { name: /^3日\s*3$/ }).click();
    await expectCalendarUrl(page, { pathname: '/ja/calendar', date: TEST_DATE });
    await expect(page.locator('[data-calendar-grid]')).toHaveCount(3);

    await page.goBack();
    await expectCalendarUrl(page, { pathname: '/ja/calendar', date: TEST_DATE });
    await expect(page.locator('[data-calendar-grid]')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '日', exact: true })).toBeVisible();
  });

  test('sidebarのclose/open状態をreload後も復元する', async ({ page }) => {
    await expect(page.getByRole('complementary').first()).toBeVisible();

    await page.getByRole('button', { name: 'サイドバーを閉じる' }).click();
    await expect(page.getByRole('complementary')).toHaveCount(0);
    const openSidebar = page.getByRole('button', {
      name: /^(Open sidebar|サイドバーを開く)$/,
    });
    await expect(openSidebar).toBeVisible();

    await page.reload();
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('complementary')).toHaveCount(0);
    await expect(openSidebar).toBeVisible();
    await openSidebar.click();
    await expect(page.getByRole('complementary').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'サイドバーを閉じる' })).toBeVisible();

    await page.reload();
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('complementary').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'サイドバーを閉じる' })).toBeVisible();
  });
});
