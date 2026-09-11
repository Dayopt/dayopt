import { expect, type Page, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/database';
import {
  assertServiceRoleSuiteRunnable,
  resolveServiceRoleTarget,
} from '../service-role-target-guard';
import { suppressConsentBanner } from './suppress-consent-banner';

/**
 * クリティカルパス E2E — 計画 → 実績 → 振り返りの中核ループを実 UI 操作で通す
 *
 * 「作成導線が存在する」ではなく、ドラッグ選択 → アクティビティ選択で実際に Plan / Record を作り、
 * リロード後も残る（= DB へ永続化された）ことと、Review panel の Time P/L へ反映される
 * ことを検証する。
 *
 * 過去帯ドラッグでパレットが開かない症状は、ドラッグ x 座標が Plan lane 側
 * （`box.width * 0.15`）だったことが原因だった。過去スロットの新規作成は宛先が
 * Record になる（docs/product/specs/plan-record.md §新規作成時の保存先ルール）ため、
 * Record lane 側（`box.width * 0.6`）へ変更して解消した。
 *
 * seed は service role で自前ユーザーを作る（block-search.spec.ts と同型）。
 * 実行先は resolveServiceRoleTarget が安全と判定した時だけ有効になる。
 *
 * @see 決定ログ（削除済み、git 履歴参照）
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
// service role で auth user / plan / record を作って消すため、実行先が安全な時だけ有効にする
const SERVICE_ROLE_TARGET = resolveServiceRoleTarget(SUPABASE_URL, SUPABASE_SERVICE_KEY);
// CI（E2E_REQUIRE_SERVICE_ROLE_SUITES=1）では skip を許さない。env が壊れて suite が
// 丸ごと消えても「0 failed」で緑になるのを防ぐ。
assertServiceRoleSuiteRunnable(SERVICE_ROLE_TARGET, 'Critical Path: 計画 → 実績 → 振り返り');
const describeWithEnv = SERVICE_ROLE_TARGET.safe ? test.describe : test.describe.skip;

const TIMEZONE = 'Asia/Tokyo';
const TEST_RUN_ID = crypto.randomUUID();
const TEST_USER_ID = crypto.randomUUID();
const TEST_EMAIL = `critical-path-${TEST_RUN_ID}@example.com`;
const TEST_PASSWORD = 'test-password-123';
const ACTIVITY_NAME = `Journey ${TEST_RUN_ID.slice(0, 8)}`;
const CATEGORY_NAME = `Cat ${TEST_RUN_ID.slice(0, 8)}`;

type SupabaseClient = ReturnType<typeof createClient<Database>>;

/**
 * 日付は必ず TIMEZONE 基準で決める。
 *
 * `test.use({ timezoneId })` が効くのは browser context だけで、Node 側の
 * `Date` の getFullYear / getMonth / getDate は runner の host TZ を返す。
 * CI runner は UTC なので、Tokyo の 00:00-09:00（UTC では前日 15:00-24:00）に
 * 実行すると host 日付が Tokyo より 1 日前になり、`tomorrow` が当日へ落ちて
 * 09:00 が過去になる = Plan ではなく Record が作られて assertion が壊れる。
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

async function login(page: Page) {
  await suppressConsentBanner(page);
  await page.goto('/ja/auth/login');
  await page.locator('input[type="email"], input[name="email"]').first().fill(TEST_EMAIL);
  await page.locator('input[type="password"]').first().fill(TEST_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/ja\/calendar/i, { timeout: 15_000 });
}

async function openDay(page: Page, dateParam: string) {
  await page.goto(`/ja/calendar?view=day&date=${dateParam}`);
  await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
}

/**
 * カレンダーグリッド上を hourFrom → hourTo までドラッグ選択する。
 *
 * - グリッドは 00:00-24:00 を等分するので hourHeight = grid高さ / 24
 * - ドラッグ選択は mouse イベント + 5px 超の移動で成立（useDragSelection.ts）
 * - 対象時間帯が viewport 外だと mouse 座標が届かないため、先にスクロールで露出させる
 */
async function dragSelect(page: Page, hourFrom: number, hourTo: number) {
  const grid = page.locator('[data-calendar-grid][data-calendar-day-index="0"]').first();
  await expect(grid).toBeVisible({ timeout: 10_000 });

  const gridHeight = await grid.evaluate((el) => el.getBoundingClientRect().height);
  const hourHeight = gridHeight / 24;

  // 対象時間帯をスクロールで露出させる（1 時間分の余白を上に残す）
  await page
    .locator('[data-calendar-scroll]')
    .first()
    .evaluate(
      (el, top) => {
        // html の scroll-behavior: smooth でアニメーションすると直後の boundingBox が確定しない
        el.scrollTo({ top, behavior: 'instant' });
      },
      hourHeight * (hourFrom - 1),
    );

  const box = await grid.boundingBox();
  if (!box) throw new Error('calendar grid is not visible');

  const x = box.x + box.width * 0.6; // record lane 側
  const yFrom = box.y + hourHeight * hourFrom;
  const yTo = box.y + hourHeight * hourTo;

  await page.mouse.move(x, yFrom);
  await page.mouse.down();
  // mousemove は rAF スロットルされるため中間 move を挟んで hasDragged を確定させる
  await page.mouse.move(x, yFrom + 24, { steps: 4 });
  await page.mouse.move(x, yTo, { steps: 8 });
  await page.mouse.up();
}

describeWithEnv('Critical Path: 計画 → 実績 → 振り返り', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ timezoneId: TIMEZONE });

  let adminSupabase: SupabaseClient;
  const tomorrow = offsetDateParam(1);

  test.beforeAll(async () => {
    adminSupabase = createClient<Database>(SUPABASE_URL!, SUPABASE_SERVICE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { error: authError } = await adminSupabase.auth.admin.createUser({
      id: TEST_USER_ID,
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: 'critical path e2e' },
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
        name: CATEGORY_NAME,
        color: 'blue',
        icon: 'circle',
      })
      .select()
      .single();
    if (categoryError) throw new Error(categoryError.message);

    const { error: activityError } = await adminSupabase.from('activities').insert({
      user_id: TEST_USER_ID,
      category_id: category.id,
      name: ACTIVITY_NAME,
    });
    if (activityError) throw new Error(activityError.message);
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
    test.skip(
      testInfo.project.name.includes('Mobile'),
      'desktop-only（ドラッグ座標は desktop 前提）',
    );
    await login(page);
  });

  test('ドラッグ選択とアクティビティ選択で明日の Plan を作成し、リロード後も残る', async ({
    page,
  }) => {
    await openDay(page, tomorrow);

    await dragSelect(page, 9, 10);

    // ドラッグ確定 → 編集と同じ右パネルが作成モードで開く
    const createPanel = page.getByRole('region', { name: 'アクティビティを選択' });
    await expect(createPanel).toBeVisible({ timeout: 10_000 });
    await createPanel.getByRole('button', { name: ACTIVITY_NAME }).click();

    // Plan lane にカードが現れる（lane カードはアクティビティ名を表示する）
    const planCard = page.locator('[data-plan-lane-card]', { hasText: ACTIVITY_NAME }).first();
    await expect(planCard).toBeVisible({ timeout: 10_000 });

    // リロードしても残る = DB へ永続化されている
    await page.reload();
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('[data-plan-lane-card]', { hasText: ACTIVITY_NAME }).first(),
    ).toBeVisible({
      timeout: 10_000,
    });
  });

  test('過去帯をドラッグして Record を記録し、リロード後も残る', async ({ page }) => {
    await openDay(page, offsetDateParam(-1));

    await dragSelect(page, 9, 10);

    // ドラッグ確定 → 編集と同じ右パネルが作成モードで開く
    const createPanel = page.getByRole('region', { name: 'アクティビティを選択' });
    await expect(createPanel).toBeVisible({ timeout: 10_000 });
    await createPanel.getByRole('button', { name: ACTIVITY_NAME }).click();

    // Record レーンにカードが現れる（lane カードはアクティビティ名を表示する）
    const recordCard = page.locator('[data-record-lane-card]', { hasText: ACTIVITY_NAME }).first();
    await expect(recordCard).toBeVisible({ timeout: 10_000 });

    // リロードしても残る = DB へ永続化されている
    await page.reload();
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('[data-record-lane-card]', { hasText: ACTIVITY_NAME }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('過去帯でも予定タブを選べば Plan として作成できる', async ({ page }) => {
    await openDay(page, offsetDateParam(-1));

    await dragSelect(page, 14, 15);

    const createPanel = page.getByRole('region', { name: 'アクティビティを選択' });
    await expect(createPanel).toBeVisible({ timeout: 10_000 });

    // 過去帯の既定は「記録」。タブで「予定」へ切り替えてから選ぶ
    await createPanel.getByRole('tab', { name: '予定', exact: true }).click();
    await createPanel.getByRole('button', { name: ACTIVITY_NAME }).click();

    const planCard = page.locator('[data-plan-lane-card]', { hasText: ACTIVITY_NAME }).first();
    await expect(planCard).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('[data-plan-lane-card]', { hasText: ACTIVITY_NAME }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('記録した実績が /report の 1 章（配分）に反映される', async ({ page }) => {
    // レポートは週 / 月 / 年の 3 粒度（#2575）。前日の記録は今週の中に入る。
    await page.goto(`/ja/report?date=${offsetDateParam(-1)}&range=week`);

    const allocation = page.locator('[data-report-chapter="allocation"]');
    await expect(allocation).toBeVisible({ timeout: 10_000 });

    // ヘッドラインは記録合計の `h:mm`。1 時間の記録があるので 0:00 のままにはならない。
    const headline = allocation.locator('[data-report-headline="recorded"]');
    await expect(headline).toBeVisible({ timeout: 10_000 });
    await expect(headline).not.toHaveText('0:00');

    // 凡例のうち「このカテゴリーの行」が 1 時間ぶんを出す。`未分類` を許容しない —
    // カテゴリー紐付けを失う回帰では label が未分類へ落ちてこの行が消えるため、
    // getByText('1:00') のような行を特定しない一致では緑になってしまう。
    const legendRow = allocation
      .locator('[data-report-legend="allocation"] li')
      .filter({ hasText: CATEGORY_NAME });
    await expect(legendRow).toHaveCount(1, { timeout: 10_000 });
    await expect(legendRow).toContainText('1:00');
  });
});
