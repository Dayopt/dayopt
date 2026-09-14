import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/database';

import {
  assertServiceRoleSuiteRunnable,
  resolveServiceRoleTarget,
} from '../service-role-target-guard';
import { createScopedTestUser, deleteScopedTestUser } from './create-scoped-test-user';
import { suppressConsentBanner } from './suppress-consent-banner';

/**
 * 初回 calendar load で server prefetch が client query にそのまま hydrate されることを
 * 実ブラウザの通信で証明する（#2747）。
 *
 * server prefetch と client query の input が 1 か所でもずれると query key が一致せず、
 * 画面は正しく出たまま同じ範囲を browser から取り直す（表示だけ見ていると気づけない）。
 * そこで full navigation から描画完了までに browser が送った範囲系 procedure を数え、
 * 0 件であることを要求する。週開始（日曜）・週末非表示・負オフセット TZ はどれも
 * 旧実装で key がずれていた条件なので、既定値ではなくこの組み合わせで通す。
 *
 * ログインは Turnstile を避けて magic link（timeblock-inspector-toggle.spec.ts と同じ）。
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const SERVICE_ROLE_TARGET = resolveServiceRoleTarget(SUPABASE_URL, SUPABASE_SERVICE_KEY);
assertServiceRoleSuiteRunnable(SERVICE_ROLE_TARGET, 'Calendar initial load hydration');
const describeWithEnv = SERVICE_ROLE_TARGET.safe ? test.describe : test.describe.skip;

/** client の useCalendarData が表示範囲で撃つ procedure。server が先読みする対象と同じ */
const RANGE_PROCEDURES = ['plans.list', 'records.list', 'externalCalendar.listEvents'] as const;

/** 水曜。日曜始まり + 週末非表示の週は 04-20(月)〜04-24(金) */
const TARGET_DATE = '2026-04-22';

type SupabaseClient = ReturnType<typeof createClient<Database>>;

const CASES = [
  { timezone: 'Asia/Tokyo', offset: '+09:00' },
  { timezone: 'America/Los_Angeles', offset: '-07:00' },
] as const;

for (const { timezone, offset } of CASES) {
  describeWithEnv(`Calendar initial load hydration (${timezone})`, () => {
    test.use({ timezoneId: timezone });
    test.setTimeout(90_000);

    const runId = crypto.randomUUID().slice(0, 8);
    const planTitle = `Hydrated plan ${runId}`;
    // カードはアクティビティ名と時刻を出す（plan title は出さない）
    const activityName = `Act ${runId}`;
    let adminSupabase: SupabaseClient;
    let userId: string;
    let email: string;

    test.beforeAll(async () => {
      const user = await createScopedTestUser(SUPABASE_URL!, SUPABASE_SERVICE_KEY!, 'initial-load');
      ({ email, userId } = user);
      adminSupabase = createClient<Database>(SUPABASE_URL!, SUPABASE_SERVICE_KEY!, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error: settingsError } = await adminSupabase.from('user_settings').upsert({
        user_id: userId,
        timezone,
        preferred_locale: 'ja',
        default_view: 'week',
        default_duration: 60,
        time_format: '24h',
        week_starts_on: 0,
        show_weekends: false,
      });
      if (settingsError) throw new Error(settingsError.message);
      const { data: category, error: categoryError } = await adminSupabase
        .from('categories')
        .insert({ user_id: userId, name: `Cat ${runId}`, color: 'blue', icon: 'circle' })
        .select('id')
        .single();
      if (categoryError) throw new Error(categoryError.message);
      const { data: activity, error: activityError } = await adminSupabase
        .from('activities')
        .insert({ user_id: userId, category_id: category.id, name: activityName })
        .select('id')
        .single();
      if (activityError) throw new Error(activityError.message);
      const { error: planError } = await adminSupabase.from('plans').insert({
        user_id: userId,
        activity_id: activity.id,
        title: planTitle,
        start_at: new Date(`${TARGET_DATE}T09:00:00${offset}`).toISOString(),
        end_at: new Date(`${TARGET_DATE}T10:00:00${offset}`).toISOString(),
      });
      if (planError) throw new Error(planError.message);
    });

    test.afterAll(async () => {
      if (!adminSupabase) return;
      await adminSupabase.from('plans').delete().eq('user_id', userId);
      await adminSupabase.from('activities').delete().eq('user_id', userId);
      await adminSupabase.from('categories').delete().eq('user_id', userId);
      await adminSupabase.from('user_settings').delete().eq('user_id', userId);
      await adminSupabase.from('profiles').delete().eq('id', userId);
      await deleteScopedTestUser(SUPABASE_URL!, SUPABASE_SERVICE_KEY!, userId);
    });

    test('server で先読みした範囲を browser から取り直さない', async ({ page }, testInfo) => {
      test.skip(testInfo.project.name.includes('Mobile'), 'desktop-only');
      await suppressConsentBanner(page);
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
      await page.waitForLoadState('networkidle');

      // ここから数える。ログイン直後の「今日」の週とは別の範囲なので、先に温まった cache は使えない
      const rangeRequests: string[] = [];
      page.on('request', (request) => {
        const { pathname } = new URL(request.url());
        if (!pathname.startsWith('/api/trpc/')) return;
        for (const procedure of decodeURIComponent(pathname.slice('/api/trpc/'.length)).split(
          ',',
        )) {
          if ((RANGE_PROCEDURES as readonly string[]).includes(procedure)) {
            rangeRequests.push(procedure);
          }
        }
      });

      await page.goto(`/ja/calendar?view=week&date=${TARGET_DATE}`);
      await expect(page.locator('[data-calendar-grid]')).toHaveCount(5, { timeout: 15_000 });
      // 0 件が「query が撃たれなかった」ではなく「hydrate された data で描画した」ことの証拠
      const seededCard = page
        .getByRole('group', { name: 'week view calendar' })
        .getByRole('button', { name: activityName });
      await expect(seededCard).toBeVisible({ timeout: 10_000 });
      await expect(seededCard).toContainText('09:00–10:00');
      await page.waitForLoadState('networkidle');

      expect(rangeRequests, '初回表示で範囲系 procedure を取り直していないこと').toEqual([]);
    });
  });
}
