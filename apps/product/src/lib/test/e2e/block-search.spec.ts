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
// service role で auth user / plan / record を作って消すため、実行先が安全な時だけ有効にする
const SERVICE_ROLE_TARGET = resolveServiceRoleTarget(SUPABASE_URL, SUPABASE_SERVICE_KEY);
// CI（E2E_REQUIRE_SERVICE_ROLE_SUITES=1）では skip を許さない。env が壊れて suite が
// 丸ごと消えても「0 failed」で緑になるのを防ぐ。
assertServiceRoleSuiteRunnable(SERVICE_ROLE_TARGET, 'Block search');
const describeWithEnv = SERVICE_ROLE_TARGET.safe ? test.describe : test.describe.skip;

const TIMEZONE = 'Asia/Tokyo';
const TEST_RUN_ID = crypto.randomUUID();
const TEST_USER_ID = crypto.randomUUID();
const TEST_EMAIL = `block-search-${TEST_RUN_ID}@example.com`;
const TEST_PASSWORD = 'test-password-123';
const SEARCH_TOKEN = TEST_RUN_ID.slice(0, 8);
const ACTIVITY_NAME = `Search activity ${SEARCH_TOKEN}`;
const PLAN_NOTE = `Plan note ${SEARCH_TOKEN}`;
const RECORD_NOTE = `Record note ${SEARCH_TOKEN}`;
const PLAN_COMPATIBILITY_TITLE = `Legacy plan ${SEARCH_TOKEN}`;
const RECORD_COMPATIBILITY_TITLE = `Legacy record ${SEARCH_TOKEN}`;

type SupabaseClient = ReturnType<typeof createClient<Database>>;

/**
 * 日付は必ず TIMEZONE 基準で決める。`test.use({ timezoneId })` は browser context
 * にしか効かず、Node 側の `Date` は runner の host TZ（CI では UTC）を返すため。
 * ここは ±14 日の余裕があるので 1 日のズレでは壊れないが、同じ helper が
 * critical-path.spec.ts では ±1 日で使われるので基準を揃えておく。
 */
const DATE_PARAM_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function offsetDateParam(offsetDays: number): string {
  // Asia/Tokyo は DST を持たないため、24h 加算と暦日加算が一致する
  return DATE_PARAM_FORMAT.format(new Date(Date.now() + offsetDays * 86_400_000));
}

function isoAt(dateParam: string, hhmm: string): string {
  return new Date(`${dateParam}T${hhmm}:00+09:00`).toISOString();
}

async function login(page: Page) {
  await suppressConsentBanner(page);
  await page.goto('/ja/auth/login');
  await page.locator('input[type="email"], input[name="email"]').first().fill(TEST_EMAIL);
  await page.locator('input[type="password"]').first().fill(TEST_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/ja\/calendar/i, { timeout: 15_000 });
  // URL 遷移だけでは hydration 完了を保証しない。ショートカットは mount 時の
  // useEffect で registry へ登録されるため、grid の描画を待たずに Ctrl+K を
  // 押すとイベントが誰にも拾われず検索ダイアログが開かない。
  await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
}

describeWithEnv('Block search', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ timezoneId: TIMEZONE });

  let adminSupabase: SupabaseClient;
  let planId: string;
  let recordId: string;
  const planDate = offsetDateParam(14);
  const recordDate = offsetDateParam(-14);

  test.beforeAll(async () => {
    adminSupabase = createClient<Database>(SUPABASE_URL!, SUPABASE_SERVICE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { error: authError } = await adminSupabase.auth.admin.createUser({
      id: TEST_USER_ID,
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: 'block search e2e' },
    });
    if (authError && !authError.message.includes('already exists'))
      throw new Error(authError.message);

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

    // 色・アイコンを持つのはカテゴリーだけで、アクティビティは継承する（#2162 §4-6）
    const { data: category, error: categoryError } = await adminSupabase
      .from('categories')
      .insert({
        user_id: TEST_USER_ID,
        name: `Cat ${SEARCH_TOKEN}`,
        color: 'blue',
        icon: 'circle',
      })
      .select('id')
      .single();
    if (categoryError) throw new Error(categoryError.message);

    const { data: activity, error: activityError } = await adminSupabase
      .from('activities')
      .insert({
        user_id: TEST_USER_ID,
        category_id: category.id,
        name: ACTIVITY_NAME,
      })
      .select('id')
      .single();
    if (activityError) throw new Error(activityError.message);

    const { data: plan, error: planError } = await adminSupabase
      .from('plans')
      .insert({
        user_id: TEST_USER_ID,
        activity_id: activity.id,
        title: PLAN_COMPATIBILITY_TITLE,
        note: PLAN_NOTE,
        start_at: isoAt(planDate, '09:00'),
        end_at: isoAt(planDate, '10:00'),
      })
      .select('id')
      .single();
    if (planError) throw new Error(planError.message);
    planId = plan.id;

    const { data: record, error: recordError } = await adminSupabase
      .from('records')
      .insert({
        user_id: TEST_USER_ID,
        activity_id: activity.id,
        title: RECORD_COMPATIBILITY_TITLE,
        note: RECORD_NOTE,
        start_at: isoAt(recordDate, '09:00'),
        end_at: isoAt(recordDate, '10:00'),
        source: 'manual',
      })
      .select('id')
      .single();
    if (recordError) throw new Error(recordError.message);
    recordId = record.id;
  });

  test.afterAll(async () => {
    if (!adminSupabase) return;
    await adminSupabase.from('records').delete().eq('user_id', TEST_USER_ID);
    await adminSupabase.from('plans').delete().eq('user_id', TEST_USER_ID);
    await adminSupabase.from('activities').delete().eq('user_id', TEST_USER_ID);
    await adminSupabase.from('categories').delete().eq('user_id', TEST_USER_ID);
    await adminSupabase.from('user_settings').delete().eq('user_id', TEST_USER_ID);
    await adminSupabase.from('profiles').delete().eq('id', TEST_USER_ID);
    await adminSupabase.auth.admin.deleteUser(TEST_USER_ID);
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('desktop shortcut・note/アクティビティ検索・Inspector遷移がつながる', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.includes('Mobile'), 'desktop-only');

    await page.keyboard.press('Control+K');
    const input = page.getByRole('combobox', { name: '予定と記録を検索' });
    await input.fill(RECORD_NOTE);
    await page.getByText(RECORD_NOTE).click();
    await expect(input).toHaveCount(0);
    await expect
      .poll(() => new URL(page.url()).searchParams.get('timeblock'))
      .toBe(`record:${recordId}`);
    expect(new URL(page.url()).searchParams.get('date')).toBe(recordDate);
    await expect(
      page
        .locator('[data-calendar-grid][data-calendar-day-index="0"] [data-record-lane-card]', {
          hasText: ACTIVITY_NAME,
        })
        .first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('region', { name: ACTIVITY_NAME })).toBeVisible();

    // Inspectorを閉じた直後に同じblockを検索し直しても、close時のURL cleanupが
    // 後着して再オープンを打ち消さない。
    await page.keyboard.press('Escape');
    await expect(page.getByRole('region', { name: ACTIVITY_NAME })).toHaveCount(0);
    await page.getByRole('button', { name: 'ブロックを検索' }).first().click();
    await page.getByRole('combobox', { name: '予定と記録を検索' }).fill(RECORD_NOTE);
    await page.getByText(RECORD_NOTE).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('timeblock'))
      .toBe(`record:${recordId}`);
    await expect(page.getByRole('region', { name: ACTIVITY_NAME })).toBeVisible();

    // 検索ダイアログが exit 中（DOM に残っている間）に Escape を押すと Radix の
    // DismissableLayer がそれを消費し、Inspector は #2661 の意図どおり閉じない。
    // 実際の導線と同じく、ダイアログが消えてから Inspector を閉じる（#2669）。
    await expect(page.getByRole('combobox', { name: '予定と記録を検索' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('region', { name: ACTIVITY_NAME })).toHaveCount(0);

    await page.getByRole('button', { name: 'ブロックを検索' }).first().click();
    await page.getByRole('combobox', { name: '予定と記録を検索' }).fill(ACTIVITY_NAME);
    await expect(page.getByText(PLAN_NOTE)).toBeVisible();
    await expect(page.getByText(RECORD_NOTE)).toBeVisible();
    await page.getByText(PLAN_NOTE).click();

    await expect
      .poll(() => new URL(page.url()).searchParams.get('timeblock'))
      .toBe(`plan:${planId}`);
    expect(new URL(page.url()).searchParams.get('date')).toBe(planDate);
    await expect(
      page
        .locator('[data-calendar-grid][data-calendar-day-index="0"] [data-plan-lane-card]', {
          hasText: ACTIVITY_NAME,
        })
        .first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('region', { name: ACTIVITY_NAME })).toBeVisible();
  });

  test('mobileは展開mini calendarから検索を開ける', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.includes('Mobile'), 'mobile-only');

    await page.getByRole('button', { name: 'カレンダーを開く' }).click();
    await page.getByRole('button', { name: 'ブロックを検索' }).click();
    await page.getByRole('combobox', { name: '予定と記録を検索' }).fill(ACTIVITY_NAME);

    await expect(page.getByText(PLAN_NOTE)).toBeVisible();
    await expect(page.getByText(RECORD_NOTE)).toBeVisible();
  });
});
