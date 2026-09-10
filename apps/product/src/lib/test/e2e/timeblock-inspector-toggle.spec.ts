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
 * ブロックのクリックで詳細パネルが開閉するかを実機で通す E2E。
 *
 * 単体テストでは掴めなかった不具合の層を持つ: 掴めるカードは pointer の状態機械
 * （EVENT_CLICK）とブラウザの click の 2 経路でクリックが届き、トグルにした途端に
 * 打ち消し合って「押しても何も起きない」になった（2026-09-10）。2 経路の間隔は
 * レンダリング負荷で変わるため、時間で畳む実装は再現しては消える flake になる。
 * ここは「開く → 同じブロックで閉じる → 開いて別ブロックへ差し替える」を実際の
 * mouse で通し、経路の数が 1 に保たれていることを担保する。
 *
 * ログインはフォームを使わない（Turnstile が出るため）。service role でマジック
 * リンクを発行し、/auth/confirm の verifyOtp でセッションを張る。
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SERVICE_ROLE_TARGET = resolveServiceRoleTarget(SUPABASE_URL, SUPABASE_SERVICE_KEY);
assertServiceRoleSuiteRunnable(SERVICE_ROLE_TARGET, 'Inspector toggle repro');
const describeWithEnv = SERVICE_ROLE_TARGET.safe ? test.describe : test.describe.skip;

const TIMEZONE = 'Asia/Tokyo';
const RUN_ID = crypto.randomUUID().slice(0, 8);
const ACTIVITY_A = `Repro A ${RUN_ID}`;
const ACTIVITY_B = `Repro B ${RUN_ID}`;

type SupabaseClient = ReturnType<typeof createClient<Database>>;

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

describeWithEnv('Inspector toggle repro', () => {
  test.use({ timezoneId: TIMEZONE });
  test.setTimeout(90_000);

  let adminSupabase: SupabaseClient;
  let userId: string;
  let email: string;

  test.beforeAll(async () => {
    const user = await createScopedTestUser(SUPABASE_URL!, SUPABASE_SERVICE_KEY!, 'repro');
    ({ email, userId } = user);
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
    const { data: category } = await adminSupabase
      .from('categories')
      .insert({ user_id: userId, name: `Cat ${RUN_ID}`, color: 'blue', icon: 'circle' })
      .select('id')
      .single();
    const { data: actA } = await adminSupabase
      .from('activities')
      .insert({ user_id: userId, category_id: category!.id, name: ACTIVITY_A })
      .select('id')
      .single();
    const { data: actB } = await adminSupabase
      .from('activities')
      .insert({ user_id: userId, category_id: category!.id, name: ACTIVITY_B })
      .select('id')
      .single();
    await adminSupabase.from('plans').insert([
      {
        user_id: userId,
        activity_id: actA!.id,
        title: `A ${RUN_ID}`,
        start_at: isoAt('09:00'),
        end_at: isoAt('10:00'),
      },
      {
        user_id: userId,
        activity_id: actB!.id,
        title: `B ${RUN_ID}`,
        start_at: isoAt('11:00'),
        end_at: isoAt('12:00'),
      },
    ]);
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
    await suppressConsentBanner(page);
    // ログインフォームは Turnstile を通るので使わない。service role でマジックリンクを
    // 発行し、/auth/confirm の verifyOtp でセッションを張る（CAPTCHA には触れない）
    const { data, error } = await adminSupabase.auth.admin.generateLink({
      type: 'magiclink',
      email,
    });
    if (error || !data.properties?.hashed_token) {
      throw new Error(`magic link 発行に失敗: ${error?.message ?? 'no hashed_token'}`);
    }
    await page.goto(
      `/ja/auth/confirm?token_hash=${encodeURIComponent(data.properties.hashed_token)}&type=magiclink&next=${encodeURIComponent('/ja/calendar')}`,
    );
    await page.waitForURL(/\/ja\/calendar/i, { timeout: 15_000 });
  });

  async function openDay(page: Page) {
    await page.goto(`/ja/calendar?view=day&date=${PAST_DATE}`);
    await page.waitForLoadState('networkidle');
    const grid = page.locator('[data-calendar-grid][data-calendar-day-index="0"]').first();
    await expect(grid).toBeVisible({ timeout: 10_000 });
    const gridHeight = await grid.evaluate((el) => el.getBoundingClientRect().height);
    await page
      .locator('[data-calendar-scroll]')
      .first()
      .evaluate((el, top) => el.scrollTo({ top, behavior: 'instant' }), (gridHeight / 24) * 8);
  }

  test('クリックで開く / 再クリックで閉じる / 別ブロックで差し替わる', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    await openDay(page);
    const cardA = page.locator('[data-plan-lane-card]', { hasText: ACTIVITY_A }).first();
    const cardB = page.locator('[data-plan-lane-card]', { hasText: ACTIVITY_B }).first();
    await expect(cardA).toBeVisible({ timeout: 10_000 });
    const panelA = page.getByRole('region', { name: ACTIVITY_A });
    const panelB = page.getByRole('region', { name: ACTIVITY_B });

    // 1. 開く
    await cardA.click();
    await page.waitForTimeout(600);
    expect(await panelA.count(), 'クリックで開く').toBe(1);
    expect(page.url(), 'URL にも反映される').toContain('timeblock=plan%3A');

    // 2. 同じブロックの再クリックで閉じる
    await cardA.click();
    await page.waitForTimeout(600);
    expect(await panelA.count(), '再クリックで閉じる').toBe(0);
    expect(page.url(), 'URL からも消える').not.toContain('timeblock=');

    // 3. 開いてから別のブロックへ
    await cardA.click();
    await page.waitForTimeout(600);
    expect(await panelA.count(), '再度開く').toBe(1);
    await cardB.click();
    await page.waitForTimeout(600);
    expect(await panelB.count(), '別ブロックへ差し替わる').toBe(1);
    expect(await panelA.count(), '前のブロックのパネルは残らない').toBe(0);

    expect(consoleErrors, 'ブラウザ側のエラーなし').toEqual([]);
  });
});
