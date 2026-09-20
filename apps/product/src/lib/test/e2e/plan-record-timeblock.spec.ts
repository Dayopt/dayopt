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
assertServiceRoleSuiteRunnable(SERVICE_ROLE_TARGET, 'Plan / Record Timeblock flow');
const describeWithEnv = SERVICE_ROLE_TARGET.safe ? test.describe : test.describe.skip;

const TIMEZONE = 'Asia/Tokyo';
const TEST_RUN_ID = crypto.randomUUID();
const TEST_USER_ID = crypto.randomUUID();
const TEST_EMAIL = `plan-record-${TEST_RUN_ID}@example.com`;
const TEST_PASSWORD = 'test-password-123';
const TEST_ACTIVITY_NAME = `Plan Record E2E ${TEST_RUN_ID.slice(0, 8)}`;
const PLAN_TITLE = `Plan ${TEST_RUN_ID.slice(0, 8)}`;
const RECORD_TITLE = `Record ${TEST_RUN_ID.slice(0, 8)}`;

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
  await page.waitForLoadState('networkidle');
  await page.locator('input[type="email"], input[name="email"]').first().fill(TEST_EMAIL);
  await page.locator('input[type="password"]').first().fill(TEST_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/ja\/calendar/i, { timeout: 15_000 });
}

async function openDay(page: Page, dateParam: string) {
  await page.goto(`/ja/calendar?view=day&date=${dateParam}`);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
}

describeWithEnv('Plan / Record Timeblock flow', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ timezoneId: TIMEZONE });

  let adminSupabase: SupabaseClient;
  let recordId: string;

  test.beforeAll(async () => {
    adminSupabase = createClient<Database>(SUPABASE_URL!, SUPABASE_SERVICE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { error: authError } = await adminSupabase.auth.admin.createUser({
      id: TEST_USER_ID,
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: 'plan record e2e' },
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

    // 色・アイコンを持つのはカテゴリーだけで、アクティビティは継承する（#2162 §4-6）
    const { data: category, error: categoryError } = await adminSupabase
      .from('categories')
      .insert({
        user_id: TEST_USER_ID,
        name: `Cat ${TEST_RUN_ID.slice(0, 8)}`,
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
        name: TEST_ACTIVITY_NAME,
      })
      .select('id')
      .single();
    if (activityError) throw new Error(activityError.message);

    const planDate = offsetDateParam(14);
    const recordDate = offsetDateParam(-14);
    const { error: planError } = await adminSupabase.from('plans').insert({
      user_id: TEST_USER_ID,
      activity_id: activity.id,
      title: PLAN_TITLE,
      start_at: isoAt(planDate, '09:00'),
      end_at: isoAt(planDate, '10:00'),
    });
    if (planError) throw new Error(planError.message);

    const { data: record, error: recordError } = await adminSupabase
      .from('records')
      .insert({
        user_id: TEST_USER_ID,
        activity_id: activity.id,
        title: RECORD_TITLE,
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

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.includes('Mobile'), 'desktop-only');
    await login(page);
  });

  // lane カード（TwoLane/PlanLaneCard / RecordLaneCard）は title ではなくアクティビティ名を表示する
  test('Plan と Record をそれぞれの Calendar 日付に表示する', async ({ page }) => {
    await openDay(page, offsetDateParam(14));
    await expect(
      page.locator('[data-plan-lane-card]', { hasText: TEST_ACTIVITY_NAME }).first(),
    ).toBeVisible({
      timeout: 10_000,
    });

    await openDay(page, offsetDateParam(-14));
    await expect(
      page.locator('[data-record-lane-card]', { hasText: TEST_ACTIVITY_NAME }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('Record の Inspector URL は record prefix を使う', async ({ page }) => {
    await openDay(page, offsetDateParam(-14));
    await page.locator('[data-record-lane-card]', { hasText: TEST_ACTIVITY_NAME }).first().click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('timeblock'))
      .toBe(`record:${recordId}`);
  });
});
