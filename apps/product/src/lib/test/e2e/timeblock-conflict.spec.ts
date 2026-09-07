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
 * Inspector の編集中に別 writer が同じ Plan を更新した時、無言上書きにならず
 * conflict として見えることを固定する E2E（#2631）。
 *
 * 競合検出は `update_plan_command_v1` の `p_expected_updated_at`（`IS DISTINCT FROM
 * updated_at` → DT002）に集約され、UI では `timeblock-command-client.ts` が
 * `STALE_VERSION` へ写像し `useTimeblockWriteMutations` が conflict toast を出す。
 * ただし `useCoalescedTimeblockSave` は保存待ちの変更を最新値へまとめるため、
 * 「古い版を前提にした待機分が、そのまま送られて成功してしまう」経路が単体では
 * 塞がっているかを確認できない。MCP write を production で有効化する（#2553）前に、
 * UI と別 writer の競合をこの層で固定する。
 *
 * 別 writer は service_role の直接 RPC で代替する（MCP endpoint 自体は production の
 * env 未投入で使えない）。UI と MCP は同じ SQL writer を通るため、検出経路は同じ。
 *
 * spec を分けているのは rate limit の予算を分けるため（#2246、
 * `create-scoped-test-user.ts` 参照）。
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SERVICE_ROLE_TARGET = resolveServiceRoleTarget(SUPABASE_URL, SUPABASE_SERVICE_KEY);
// CI（E2E_REQUIRE_SERVICE_ROLE_SUITES=1）では skip を許さない。env が壊れて suite が
// 丸ごと消えても「0 failed」で緑になるのを防ぐ。
assertServiceRoleSuiteRunnable(SERVICE_ROLE_TARGET, 'Timeblock conflict');
const describeWithEnv = SERVICE_ROLE_TARGET.safe ? test.describe : test.describe.skip;

const TIMEZONE = 'Asia/Tokyo';
const RUN_ID = crypto.randomUUID().slice(0, 8);
const ACTIVITY_NAME = `Conflict ${RUN_ID}`;
/** 別 writer（service_role）が書く値。UI の古い入力に上書きされてはいけない。 */
const OTHER_WRITER_NOTE = `別writerのメモ ${RUN_ID}`;
/** UI 側で入力する、古い版を前提にした値。DB へ到達してはいけない。 */
const STALE_UI_NOTE = `UIの古い入力 ${RUN_ID}`;

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

const PAST_DATE = DATE_PARAM_FORMAT.format(new Date(Date.now() - 7 * 86_400_000));

function isoAt(hhmm: string): string {
  return new Date(`${PAST_DATE}T${hhmm}:00+09:00`).toISOString();
}

describeWithEnv('Timeblock conflict', () => {
  test.use({ timezoneId: TIMEZONE });
  // 既定の 30s は beforeEach の login を含む。2 vCPU ランナーで login が伸びると
  // 競合 window の観測予算が食われ、不透明な test timeout として落ちる。
  test.setTimeout(60_000);

  let adminSupabase: SupabaseClient;
  let userId: string;
  let email: string;
  let password: string;
  let activityId: string;
  let planId: string;
  let seededUpdatedAt: string;

  test.beforeAll(async () => {
    const user = await createScopedTestUser(SUPABASE_URL!, SUPABASE_SERVICE_KEY!, 'conflict');
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
    activityId = activity.id;

    const { data: plan, error: planError } = await adminSupabase
      .from('plans')
      .insert({
        user_id: userId,
        activity_id: activityId,
        title: `Conflict plan ${RUN_ID}`,
        start_at: isoAt('09:00'),
        end_at: isoAt('10:00'),
      })
      .select('id, updated_at')
      .single();
    if (planError) throw new Error(planError.message);
    planId = plan.id;
    seededUpdatedAt = plan.updated_at;
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

  /** UI が版を握った後に、別 writer として同じ Plan を service_role で更新する。 */
  async function updateAsOtherWriter() {
    const { error } = await adminSupabase.rpc('update_plan_command_v1', {
      p_activity_id: activityId,
      p_activity_id_present: true,
      p_end_at: isoAt('10:30'),
      p_expected_updated_at: seededUpdatedAt,
      p_external_calendar_event_id: null as never,
      p_note: OTHER_WRITER_NOTE,
      p_plan_id: planId,
      p_start_at: isoAt('09:30'),
      p_title: `Conflict plan ${RUN_ID}`,
      p_user_id: userId,
    });
    if (error) throw new Error(`other writer update failed: ${error.message}`);
  }

  test('別 writer が同じ Plan を更新すると、UI は conflict として最新値を読み直す', async ({
    page,
  }) => {
    await page.goto(`/ja/calendar?view=day&date=${PAST_DATE}`);
    await page.waitForLoadState('networkidle');

    const card = page.locator('[data-plan-lane-card]', { hasText: ACTIVITY_NAME }).first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();

    // Inspector が seed 版（09:00）を握ったことを確認してから競合させる。ここを待たずに
    // 更新すると「競合前に最新版を読んでいた」だけの test になりうる。
    const startTime = page.getByRole('combobox', { name: '開始時刻' });
    await expect(startTime).toHaveValue('09:00', { timeout: 10_000 });

    await updateAsOtherWriter();

    // 古い版を前提にしたメモ編集を送る（debounce 600ms、blur で flush）。
    const noteTrigger = page.getByRole('button', { name: 'メモ' });
    await noteTrigger.click();
    const noteInput = page.getByRole('textbox', { name: 'メモ' });
    await noteInput.fill(STALE_UI_NOTE);
    await noteInput.blur();

    // 1. 無言で成功させず、conflict として見せる
    await expect(
      page.getByText('別の場所で変更されたため、最新の内容を読み込みました'),
    ).toBeVisible({ timeout: 15_000 });

    // 2. 再取得した server 値でフォームを描き直す（UI の古い入力は残さない）
    await expect(startTime).toHaveValue('09:30', { timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'メモ' })).toContainText(OTHER_WRITER_NOTE, {
      timeout: 10_000,
    });

    // 3. 待機中だった古い入力が、あとから DB へ届いて別 writer の値を潰さない。
    //    poll で「一度も STALE_UI_NOTE にならない」ことを見る（1 点観測だと
    //    debounce 分の遅れて届く保存を見逃す）。
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const { data, error } = await adminSupabase
        .from('plans')
        .select('note, start_at, end_at')
        .eq('id', planId)
        .single();
      if (error) throw new Error(error.message);
      expect(data.note).toBe(OTHER_WRITER_NOTE);
      expect(new Date(data.start_at).toISOString()).toBe(isoAt('09:30'));
      expect(new Date(data.end_at).toISOString()).toBe(isoAt('10:30'));
      await page.waitForTimeout(500);
    }
  });
});
