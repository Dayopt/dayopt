import { expect, type Page, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/database';

import {
  assertServiceRoleSuiteRunnable,
  resolveServiceRoleTarget,
} from '../service-role-target-guard';
import { createScopedTestUser, deleteScopedTestUser } from './create-scoped-test-user';
import { suppressConsentBanner } from './suppress-consent-banner';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SERVICE_ROLE_TARGET = resolveServiceRoleTarget(SUPABASE_URL, SUPABASE_SERVICE_KEY);
assertServiceRoleSuiteRunnable(SERVICE_ROLE_TARGET, 'Derived Plan / Record browser flow');
const describeWithEnv = SERVICE_ROLE_TARGET.safe ? test.describe : test.describe.skip;

const TIMEZONE = 'Asia/Tokyo';
const RUN_ID = crypto.randomUUID().slice(0, 8);
const ACTIVITY_NAME = `Derived flow ${RUN_ID}`;
const DATE_PARAM_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const PAST_DATE = DATE_PARAM_FORMAT.format(new Date(Date.now() - 7 * 86_400_000));

type SupabaseClient = ReturnType<typeof createClient<Database>>;

function isoAt(hhmm: string): string {
  return new Date(`${PAST_DATE}T${hhmm}:00+09:00`).toISOString();
}

describeWithEnv('Derived Plan / Record browser flow', () => {
  test.use({ timezoneId: TIMEZONE });
  test.setTimeout(90_000);

  let adminSupabase: SupabaseClient;
  let userId: string;
  let email: string;
  let password: string;
  let recordId: string;

  test.beforeAll(async () => {
    const user = await createScopedTestUser(
      SUPABASE_URL!,
      SUPABASE_SERVICE_KEY!,
      'derived-plan-record',
    );
    ({ email, password, userId } = user);

    adminSupabase = createClient<Database>(SUPABASE_URL!, SUPABASE_SERVICE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    await adminSupabase.from('user_settings').upsert({
      user_id: userId,
      timezone: TIMEZONE,
      preferred_locale: 'ja',
      default_view: 'day',
      default_duration: 60,
      time_format: '24h',
      week_starts_on: 1,
    });

    const { data: category, error: categoryError } = await adminSupabase
      .from('categories')
      .insert({ user_id: userId, name: `Cat ${RUN_ID}`, color: 'blue', icon: 'circle' })
      .select('id')
      .single();
    if (categoryError) throw new Error(categoryError.message);

    const { data: activity, error: activityError } = await adminSupabase
      .from('activities')
      .insert({ user_id: userId, category_id: category.id, name: ACTIVITY_NAME })
      .select('id')
      .single();
    if (activityError) throw new Error(activityError.message);

    const { error: planError } = await adminSupabase.from('plans').insert({
      user_id: userId,
      activity_id: activity.id,
      title: `Plan ${RUN_ID}`,
      start_at: isoAt('09:00'),
      end_at: isoAt('10:00'),
    });
    if (planError) throw new Error(planError.message);

    const { data: record, error: recordError } = await adminSupabase
      .from('records')
      .insert({
        user_id: userId,
        activity_id: activity.id,
        title: `Record ${RUN_ID}`,
        start_at: isoAt('09:05'),
        end_at: isoAt('10:35'),
        source: 'manual',
      })
      .select('id')
      .single();
    if (recordError) throw new Error(recordError.message);
    recordId = record.id;
  });

  test.afterAll(async () => {
    if (!adminSupabase) return;
    await adminSupabase.from('records').delete().eq('user_id', userId);
    await adminSupabase.from('plans').delete().eq('user_id', userId);
    await adminSupabase.from('activities').delete().eq('user_id', userId);
    await adminSupabase.from('categories').delete().eq('user_id', userId);
    await adminSupabase.from('user_settings').delete().eq('user_id', userId);
    await adminSupabase.from('profiles').delete().eq('id', userId);
    await deleteScopedTestUser(SUPABASE_URL!, SUPABASE_SERVICE_KEY!, userId);
  });

  async function login(page: Page) {
    await suppressConsentBanner(page);
    await page.goto('/ja/auth/login');
    await page.waitForLoadState('networkidle');
    await page.locator('input[type="email"], input[name="email"]').first().fill(email);
    await page.locator('input[type="password"]').first().fill(password);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL(/\/ja\/calendar/i, { timeout: 15_000 });
  }

  async function openDay(page: Page) {
    await page.goto(`/ja/calendar?view=day&date=${PAST_DATE}`);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
  }

  async function expectPlanRatio(page: Page) {
    await page.goto(`/ja/report?date=${PAST_DATE}&range=week`);
    const row = page.locator('[data-report-rows="execution"] > li', {
      hasText: ACTIVITY_NAME,
    });
    await expect(row).toContainText('予定比 150%', { timeout: 15_000 });
  }

  test('記録の同一週内移動でInspectorの一覧だけが変わり予定比は変わらない', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.includes('Mobile'), 'desktop-only');
    await login(page);

    await expectPlanRatio(page);
    await openDay(page);

    const planCard = page.locator('[data-plan-lane-card]', { hasText: ACTIVITY_NAME }).first();
    await planCard.click();
    const relationships = page.getByRole('region', { name: 'この時間帯の記録' });
    await expect(relationships).toBeVisible();
    await expect(
      relationships.getByRole('button', { name: new RegExp(ACTIVITY_NAME) }),
    ).toBeVisible();

    await page.keyboard.press('Escape');
    await expect.poll(() => new URL(page.url()).searchParams.get('timeblock')).toBeNull();

    const grid = page.locator('[data-calendar-grid][data-calendar-day-index="0"]').first();
    const gridHeight = await grid.evaluate((element) => element.getBoundingClientRect().height);
    const hourHeight = gridHeight / 24;
    await page
      .locator('[data-calendar-scroll]')
      .first()
      .evaluate((element, top) => element.scrollTo({ top, behavior: 'instant' }), hourHeight * 8);

    const recordCard = page.locator('[data-record-lane-card]', { hasText: ACTIVITY_NAME }).first();
    await expect(recordCard).toBeVisible();
    const box = await recordCard.boundingBox();
    if (!box) throw new Error('record card is not visible');

    const x = box.x + box.width / 2;
    const yFrom = box.y + box.height / 2;
    await page.mouse.move(x, yFrom);
    await page.mouse.down();
    await page.mouse.move(x, yFrom + 24, { steps: 4 });
    await expect
      .poll(() => page.evaluate(() => document.body.style.cursor), { timeout: 5_000 })
      .toBe('grabbing');
    // ドラッグは 15 分刻みの**相対 snap**（移動量だけを量子化し、元の分 :05 は保持する。
    // `domain/precision.ts` の `DEFAULT_DRAG_SNAP_MINUTES` と `time-math.ts` の
    // `snapDeltaMinutes`）。移動量は 15 の倍数にしておく —— 115 分だと snap 境界の
    // 中点 112.5 分まで 2.5 分しかなく、ピクセル誤差で 105 分側へ倒れて flaky になる。
    await page.mouse.move(x, yFrom + (120 / 60) * hourHeight, { steps: 12 });
    await page.mouse.up();

    await expect
      .poll(
        async () => {
          const { data } = await adminSupabase
            .from('records')
            .select('start_at, end_at')
            .eq('id', recordId)
            .single();
          return data
            ? `${new Date(data.start_at).toISOString()}/${new Date(data.end_at).toISOString()}`
            : null;
        },
        { timeout: 15_000 },
      )
      .toBe(`${isoAt('11:05')}/${isoAt('12:35')}`);

    await openDay(page);
    await page.locator('[data-plan-lane-card]', { hasText: ACTIVITY_NAME }).first().click();
    await expect(page.getByRole('heading', { name: 'この時間帯の記録' })).toHaveCount(0);

    await expectPlanRatio(page);
  });
});
