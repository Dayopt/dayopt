import { expect, type Locator, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/database';
import { recordPreviewUser } from '../preview-user-lifecycle';
import { REPORT_ALLOCATION } from './report-selectors';
import { suppressConsentBanner } from './suppress-consent-banner';

/**
 * クリティカルパス E2E（desktop / mobile）が共有する seed と操作の足場。
 *
 * spec ごとに `createCriticalPathIdentity` で別ユーザーを作る。desktop と mobile が
 * 同じユーザーを共有すると、serial で作った Plan / Record が互いの Report 集計へ
 * 混ざり、`1時間` の assertion が片方の成否に依存する。
 */

export const TIMEZONE = 'Asia/Tokyo';

/** `formatReportSpan(60, 'ja')` の表記。E2E は ja locale で開く。 */
const ONE_HOUR_SPAN = '1時間';

export type AdminSupabase = ReturnType<typeof createClient<Database>>;

interface CriticalPathIdentity {
  userId: string;
  email: string;
  password: string;
  activityName: string;
  categoryName: string;
}

export function createCriticalPathIdentity(prefix: string): CriticalPathIdentity {
  const runId = crypto.randomUUID();
  return {
    userId: crypto.randomUUID(),
    email: `${prefix}-${runId}@example.com`,
    password: crypto.randomUUID(),
    activityName: `Journey ${runId.slice(0, 8)}`,
    categoryName: `Cat ${runId.slice(0, 8)}`,
  };
}

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

export function offsetDateParam(offsetDays: number): string {
  // Asia/Tokyo は DST を持たないため、24h 加算と暦日加算が一致する
  return DATE_PARAM_FORMAT.format(new Date(Date.now() + offsetDays * 86_400_000));
}

export function createAdminSupabase(url: string, serviceKey: string): AdminSupabase {
  return createClient<Database>(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const createdUsers = new WeakMap<AdminSupabase, Set<string>>();

/** auth user / profile / settings（default_duration 60）/ カテゴリー / アクティビティを 1 組作る。 */
export async function seedCriticalPathUser(
  admin: AdminSupabase,
  identity: CriticalPathIdentity,
  fullName: string,
) {
  recordPreviewUser(identity.userId, 'creating');
  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    id: identity.userId,
    email: identity.email,
    password: identity.password,
    email_confirm: true,
    ...(process.env.E2E_PREVIEW_RUN_ID
      ? { app_metadata: { e2e_run_id: process.env.E2E_PREVIEW_RUN_ID } }
      : {}),
    user_metadata: { full_name: fullName },
  });
  if (authError || authData.user?.id !== identity.userId) {
    recordPreviewUser(identity.userId, 'creation-unconfirmed');
    throw new Error('E2E synthetic user creation failed');
  }
  const owned = createdUsers.get(admin) ?? new Set<string>();
  owned.add(identity.userId);
  createdUsers.set(admin, owned);
  recordPreviewUser(identity.userId, 'created');

  const { error: profileError } = await admin.from('profiles').upsert({
    id: identity.userId,
    email: identity.email,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (profileError) throw new Error('E2E synthetic profile setup failed');
  const { error: settingsError } = await admin.from('user_settings').upsert({
    user_id: identity.userId,
    timezone: TIMEZONE,
    preferred_locale: 'ja',
    default_view: 'day',
    default_duration: 60,
    time_format: '24h',
    week_starts_on: 1,
  });

  if (settingsError) throw new Error('E2E synthetic settings setup failed');

  // 色・アイコンを持つのはカテゴリーだけで、アクティビティは継承する（#2162 §4-6）
  const { data: category, error: categoryError } = await admin
    .from('categories')
    .insert({
      user_id: identity.userId,
      name: identity.categoryName,
      color: 'blue',
      icon: 'circle',
    })
    .select()
    .single();
  if (categoryError || !category) throw new Error('E2E synthetic category setup failed');

  const { error: activityError } = await admin.from('activities').insert({
    user_id: identity.userId,
    category_id: category.id,
    name: identity.activityName,
  });
  if (activityError) throw new Error('E2E synthetic activity setup failed');
}

export async function cleanupCriticalPathUser(admin: AdminSupabase, userId: string) {
  // 作成応答で所有を確認できた同じ client / user だけを消す。
  // setup が途中で失敗しても afterAll で回収できるが、既存ユーザーの衝突は対象外。
  const owned = createdUsers.get(admin);
  if (!owned?.has(userId)) return;

  const failures: string[] = [];
  const operations = [
    ['records', () => admin.from('records').delete().eq('user_id', userId)],
    ['plans', () => admin.from('plans').delete().eq('user_id', userId)],
    ['activities', () => admin.from('activities').delete().eq('user_id', userId)],
    ['categories', () => admin.from('categories').delete().eq('user_id', userId)],
    ['user_settings', () => admin.from('user_settings').delete().eq('user_id', userId)],
    ['profiles', () => admin.from('profiles').delete().eq('id', userId)],
    ['auth', () => admin.auth.admin.deleteUser(userId)],
  ] as const;
  for (const [name, remove] of operations) {
    try {
      const { error } = await remove();
      if (error) failures.push(name);
    } catch {
      // 生の SDK / fetch error は credentials を含み得るため保存・表示しない。
      failures.push(name);
    }
  }
  if (failures.length) {
    recordPreviewUser(userId, 'cleanup-failed');
    throw new Error(`E2E synthetic cleanup failed for ${userId}: ${failures.join(', ')}`);
  }
  recordPreviewUser(userId, 'deleted');
  owned.delete(userId);
}

/**
 * アクティビティを押して作成し、サーバーが保存を返すまで待つ。
 *
 * カードは楽観的更新で即座に出るので、見えただけでは DB に届いた証拠にならない。
 * 保存応答より先に reload すると、作成が破棄されて「リロード後も残る」が落ちる
 * （2026-09-15 の promote run 34912772207 で mobile の初回試行が実際に落ちた）。
 * httpBatchLink は同 tick の呼び出しを `/api/trpc/a,b?batch=1` に束ねるので path は部分一致で見る。
 */
export async function clickAndAwaitCreate(
  page: Page,
  activityButton: Locator,
  kind: 'plan' | 'record',
) {
  const procedure = `${kind}Commands.create`;
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.startsWith('/api/trpc/') &&
      new URL(response.url()).pathname.includes(procedure),
    { timeout: 15_000 },
  );
  await activityButton.click();
  const response = await saved;
  expect(response.ok(), `${procedure} が保存に失敗した（HTTP ${response.status()}）`).toBe(true);
}

export async function loginAs(page: Page, identity: CriticalPathIdentity) {
  await suppressConsentBanner(page);
  await page.goto('/ja/auth/login');
  await page.locator('input[type="email"], input[name="email"]').first().fill(identity.email);
  await page.locator('input[type="password"]').first().fill(identity.password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/ja\/calendar/i, { timeout: 15_000 });
}

export async function openDay(page: Page, dateParam: string) {
  await page.goto(`/ja/calendar?view=day&date=${dateParam}`);
  await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
}

/**
 * 1 日目のグリッドを「hour 時の 1 時間前」までスクロールし、実際の時間セルの位置と高さを返す。
 * html の scroll-behavior: smooth でアニメーションすると直後の boundingBox が確定しないので instant で動かす。
 */
export async function revealHour(page: Page, hour: number) {
  // ルート遷移中は旧ビューが DOM に残る。旧ビューは高さ0の時間セルを
  // 持つことがあるため、表示中の最新グリッドを操作対象にする。
  const grid = page.locator('[data-calendar-grid][data-calendar-day-index="0"]:visible').last();
  await expect(grid).toBeVisible({ timeout: 10_000 });

  // 外側の grid は flex の再計算中に viewport 高へ一時的に縮むことがある。
  // ここを24分割すると、アプリが選択処理に使う実際の hourHeight とズレて
  // 1時間のつもりのドラッグが数時間分になる。時間セル自身はアプリと同じ
  // HOUR_HEIGHT を style で持つため、座標と高さの基準にする。
  const hourCell = grid.locator(`[data-calendar-hour="${hour}"]`).first();
  await expect(hourCell).toBeAttached();
  await expect
    .poll(() => hourCell.evaluate((el) => el.getBoundingClientRect().height), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);
  const hourHeight = await hourCell.evaluate((el) => el.getBoundingClientRect().height);

  const scroll = grid.locator('xpath=ancestor::*[@data-calendar-scroll][1]');
  await expect(scroll).toBeVisible();
  await scroll.evaluate(
    (el, top) => {
      el.scrollTo({ top, behavior: 'instant' });
    },
    hourHeight * (hour - 1),
  );

  const box = await grid.boundingBox();
  const hourBox = await hourCell.boundingBox();
  if (!box || !hourBox) throw new Error('calendar grid is not visible');
  return { grid, box, hourBox, hourHeight };
}

/**
 * 記録した 1 時間が /report の「時間の使い方」へ反映されたことを確かめる。
 *
 * **完全一致で見る。** 表記は読み物向けの `formatReportSpan`（`1時間` / `12分`）で、
 * `not.toHaveText('0:00')` のような否定は書式が変われば何にでも当たる
 * （#2773 で `h:mm` から変わった後も緑のままだった。#2774）。
 *
 * 行は**配分の横棒ではなくアクティビティ一覧**を見る。横棒は記録のあるカテゴリーも
 * アクティビティも 1 つだけだと `resolveAllocationMode` が `'none'` を返して
 * 描かれず、この seed（カテゴリー 1・アクティビティ 1）では必ず 0 件になる。
 *
 * カテゴリー紐付けが `未分類` へ落ちる回帰は unit 側で固定してある
 * （`ReportBody.test.tsx` の配分・凡例の test 群）。ここは「記録した 1 時間が
 * この面のこのアクティビティの行に出る」ことだけを end-to-end で見る。
 */
export async function expectReportAllocationShowsOneHour(page: Page, activityName: string) {
  const allocation = page.locator(REPORT_ALLOCATION.chapter);
  await expect(allocation).toBeVisible({ timeout: 10_000 });

  const recorded = allocation.locator(REPORT_ALLOCATION.recordedHeadline);
  await expect(recorded).toHaveText(ONE_HOUR_SPAN, { timeout: 10_000 });

  const usageRow = allocation
    .locator(REPORT_ALLOCATION.usageRows)
    .filter({ hasText: activityName });
  await expect(usageRow).toHaveCount(1, { timeout: 10_000 });
  await expect(usageRow).toContainText(ONE_HOUR_SPAN);
}
