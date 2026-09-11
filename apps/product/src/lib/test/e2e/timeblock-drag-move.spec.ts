import { expect, type Page, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/database';

import {
  assertServiceRoleSuiteRunnable,
  resolveServiceRoleTarget,
} from '../service-role-target-guard';
import { createScopedTestUser, deleteScopedTestUser } from './create-scoped-test-user';
import { suppressConsentBanner } from './suppress-consent-banner';

/**
 * カレンダー上の既存カードを実際に掴んで動かす E2E。
 *
 * 過去 Plan の同一レーン内ドラッグ移動は、drop のコミット経路に残っていた旧 DT006
 * （過去 Plan の時刻変更禁止）の名残ガードが `onEventUpdate` を握り潰していたため
 * 保存されなかった。旧仕様を assert する単体テストがそれを緑のまま隠していたので、
 * 「掴んで動かして保存される」ところまで通す層をここで持つ。
 *
 * spec を分けているのは rate limit の予算を分けるため（#2246、
 * `create-scoped-test-user.ts` 参照）。procedures.ts の user 単位 300req/60s（#2669 までは 100）は
 * calendar を数回ロードすると尽き、同居させると mutation が 429 で落ちる。
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
// service role で auth user / plan を作って消すため、実行先が安全な時だけ有効にする
const SERVICE_ROLE_TARGET = resolveServiceRoleTarget(SUPABASE_URL, SUPABASE_SERVICE_KEY);
// CI（E2E_REQUIRE_SERVICE_ROLE_SUITES=1）では skip を許さない。env が壊れて suite が
// 丸ごと消えても「0 failed」で緑になるのを防ぐ。
assertServiceRoleSuiteRunnable(SERVICE_ROLE_TARGET, 'Timeblock drag move');
const describeWithEnv = SERVICE_ROLE_TARGET.safe ? test.describe : test.describe.skip;

const TIMEZONE = 'Asia/Tokyo';
const RUN_ID = crypto.randomUUID().slice(0, 8);
const ACTIVITY_NAME = `Drag move ${RUN_ID}`;

type SupabaseClient = ReturnType<typeof createClient<Database>>;

/**
 * 日付は必ず TIMEZONE 基準で決める。`test.use({ timezoneId })` は browser context
 * にしか効かず、Node 側の `Date` は runner の host TZ（CI では UTC）を返すため。
 */
const DATE_PARAM_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** ドラッグ移動を試す過去日。Asia/Tokyo は DST を持たないため 24h 加算と暦日加算が一致する。 */
const PAST_DATE = DATE_PARAM_FORMAT.format(new Date(Date.now() - 7 * 86_400_000));

function isoAt(hhmm: string): string {
  return new Date(`${PAST_DATE}T${hhmm}:00+09:00`).toISOString();
}

describeWithEnv('Timeblock drag move', () => {
  test.use({ timezoneId: TIMEZONE });
  // 既定の 30s は beforeEach の login を含む。2 vCPU ランナーで login が伸びると
  // DB poll の予算が食われ、「保存されなかった」ではなく不透明な test timeout として
  // 落ちる。原因の切り分けが効かなくなるのが困るので明示的に広げる。
  test.setTimeout(60_000);

  let adminSupabase: SupabaseClient;
  let userId: string;
  let email: string;
  let password: string;
  let planId: string;

  test.beforeAll(async () => {
    const user = await createScopedTestUser(SUPABASE_URL!, SUPABASE_SERVICE_KEY!, 'drag-move');
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

    const { data: plan, error: planError } = await adminSupabase
      .from('plans')
      .insert({
        user_id: userId,
        activity_id: activity.id,
        title: `Past plan ${RUN_ID}`,
        start_at: isoAt('09:00'),
        end_at: isoAt('10:00'),
      })
      .select('id')
      .single();
    if (planError) throw new Error(planError.message);
    planId = plan.id;
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

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.includes('Mobile'), 'desktop-only');
    await login(page);
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

  /**
   * 移動先も過去に留める（09:00 → 10:00）。Plan は時間軸のどこにでも置けるが、
   * 「過去の予定を過去の範囲内で動かせない」という報告そのものを踏むのが目的。
   */
  test('過去 Plan をドラッグ移動すると新しい時刻が保存される', async ({ page }) => {
    await page.goto(`/ja/calendar?view=day&date=${PAST_DATE}`);
    await page.waitForLoadState('networkidle');

    const grid = page.locator('[data-calendar-grid][data-calendar-day-index="0"]').first();
    await expect(grid).toBeVisible({ timeout: 10_000 });
    const gridHeight = await grid.evaluate((el) => el.getBoundingClientRect().height);
    const hourHeight = gridHeight / 24;

    // 09:00 を viewport へ出す（1 時間分の余白を上に残す）。html の scroll-behavior:
    // smooth でアニメーションすると直後の boundingBox が確定しないため instant。
    await page
      .locator('[data-calendar-scroll]')
      .first()
      .evaluate((el, top) => el.scrollTo({ top, behavior: 'instant' }), hourHeight * 8);

    const card = page.locator('[data-plan-lane-card]', { hasText: ACTIVITY_NAME }).first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    const box = await card.boundingBox();
    if (!box) throw new Error('past plan card is not visible');

    // x は動かさない。Record レーン側へ寄せると Plan → Record 変換の判定に入るため、
    // ここで見たい「同一レーンの時間移動」にならない。
    const x = box.x + box.width / 2;
    const yFrom = box.y + box.height / 2;

    await page.mouse.move(x, yFrom);
    await page.mouse.down();
    // mousemove は rAF スロットルされるため、中間 move を挟んで drag を確定させる
    await page.mouse.move(x, yFrom + 24, { steps: 4 });
    // drag が成立しないまま mouse.up すると「掴めなかった」と「動かせなかった」が
    // 区別できない。dragging 中だけ body へ載るカーソルで前者を先に潰す。
    await expect
      .poll(() => page.evaluate(() => document.body.style.cursor), { timeout: 5_000 })
      .toBe('grabbing');
    await page.mouse.move(x, yFrom + hourHeight, { steps: 8 });
    await page.mouse.up();

    // UI の見た目ではなく永続化された行を見る。楽観的更新だけが動いて mutation が
    // 飛んでいない、という今回の不具合の形をここで弾く。
    await expect
      .poll(
        async () => {
          const { data } = await adminSupabase
            .from('plans')
            .select('start_at, end_at')
            .eq('id', planId)
            .single();
          // PostgREST は `+00:00` 表記で返すため、比較前に ISO へ正規化する。
          return data
            ? `${new Date(data.start_at).toISOString()}/${new Date(data.end_at).toISOString()}`
            : null;
        },
        { timeout: 15_000 },
      )
      .toBe(`${isoAt('10:00')}/${isoAt('11:00')}`);

    // Plan のまま。編集で Record へ暗黙変換されないこと（plan-record.md）。
    const { count } = await adminSupabase
      .from('records')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    expect(count).toBe(0);
  });
});
