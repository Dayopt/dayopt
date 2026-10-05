import { expect, type Page } from '@playwright/test';

import { resolveIsolatedServiceRoleTarget } from '../isolated-service-role-target';
import { cleanupIsolatedTestUser } from '../isolated-user-cleanup';
import { assertServiceRoleSuiteRunnable } from '../service-role-target-guard';
import { createScopedTestUser, type ScopedTestUser } from './create-scoped-test-user';
import { createAdminSupabase, offsetDateParam, type AdminSupabase } from './critical-path-fixture';
import { test } from './isolated-product-fixture';
import { suppressConsentBanner } from './suppress-consent-banner';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
const target = resolveIsolatedServiceRoleTarget(url, key);
assertServiceRoleSuiteRunnable(target, 'Isolated consent and iCal');
const describeWithEnv = target.safe ? test.describe : test.describe.skip;

describeWithEnv('Isolated consent and iCal', () => {
  test.describe.configure({ mode: 'serial' });
  let admin: AdminSupabase;
  let user: ScopedTestUser;
  let otherUser: ScopedTestUser;
  let planId: string;
  let recordId: string;
  let otherPlanId: string;

  const login = async (page: Page, suppress = true) => {
    if (suppress) await suppressConsentBanner(page);
    await page.goto('/ja/auth/login');
    await page.locator('input[type="email"]').first().fill(user.email);
    await page.locator('input[type="password"]').first().fill(user.password);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL(/\/ja\/?(?:\?.*)?$/i, { timeout: 15_000 });
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible();
  };

  test.beforeAll(async () => {
    admin = createAdminSupabase(url!, key!);
    user = await createScopedTestUser(url!, key!, 'consent-ical');
    otherUser = await createScopedTestUser(url!, key!, 'consent-ical-other');
    const settings = await admin.from('user_settings').upsert({
      user_id: user.userId,
      timezone: 'Asia/Tokyo',
      preferred_locale: 'ja',
      ical_feed_token: null,
    });
    expect(settings.error).toBeNull();
    const iso = (offset: number, hour: string) =>
      new Date(`${offsetDateParam(offset)}T${hour}:00+09:00`).toISOString();
    const plan = await admin
      .from('plans')
      .insert({
        user_id: user.userId,
        title: 'Owned iCal Plan',
        start_at: iso(1, '09:00'),
        end_at: iso(1, '10:00'),
      })
      .select('id')
      .single();
    const record = await admin
      .from('records')
      .insert({
        user_id: user.userId,
        title: 'Owned Record excluded from iCal',
        start_at: iso(-1, '09:00'),
        end_at: iso(-1, '10:00'),
      })
      .select('id')
      .single();
    const otherPlan = await admin
      .from('plans')
      .insert({
        user_id: otherUser.userId,
        title: 'Other account Plan excluded from iCal',
        start_at: iso(1, '11:00'),
        end_at: iso(1, '12:00'),
      })
      .select('id')
      .single();
    expect(plan.error).toBeNull();
    expect(record.error).toBeNull();
    expect(otherPlan.error).toBeNull();
    planId = plan.data!.id;
    recordId = record.data!.id;
    otherPlanId = otherPlan.data!.id;
  });
  test.afterAll(async () => {
    // Both identities are local creations with separate ownership records.
    const results = await Promise.allSettled(
      [otherUser, user]
        .filter((identity): identity is ScopedTestUser => !!identity)
        .map((identity) => cleanupIsolatedTestUser(admin, url!, key!, identity)),
    );
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('One or more isolated consent/iCal identities failed cleanup');
    }
  });

  for (const [label, allowed] of [
    ['すべて同意', true],
    ['必須のみ', false],
  ] as const) {
    test(`browser consent ${label} persists across reload without changing account consent`, async ({
      page,
    }) => {
      await login(page, false);
      const banner = page.getByRole('dialog', { name: 'Cookieの使用について', exact: true });
      await expect(banner).toBeVisible();
      await banner.getByRole('button', { name: label, exact: true }).click();
      await expect(banner).toHaveCount(0);
      const consent = await page.evaluate(() =>
        JSON.parse(localStorage.getItem('dayopt_cookie_consent')!),
      );
      expect(consent.necessary).toBe(true);
      expect(consent.analytics).toBe(allowed);
      expect(consent.marketing).toBe(allowed);
      await page.reload();
      await expect(page.locator('[data-calendar-grid]').first()).toBeVisible();
      await expect(banner).toHaveCount(0);
      const result = await admin
        .from('profiles')
        .select('analytics_consent')
        .eq('id', user.userId)
        .single();
      expect(result.error).toBeNull();
      expect(result.data!.analytics_consent).toBe(false);
    });
  }

  test('account-wide consent persists independently of the browser choice and can be revoked', async ({
    page,
  }) => {
    test.skip(process.env.POSTHOG_SERVER_ENABLED !== 'false', 'Server telemetry must be disabled');
    await login(page);
    await page.goto('/ja/settings/data');
    const section = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'アカウントの利用分析', exact: true }) });
    await expect(section.getByText('許可していません', { exact: true })).toBeVisible();
    await section.getByRole('button', { name: '許可する', exact: true }).click();
    const read = async () => {
      const result = await admin
        .from('profiles')
        .select('analytics_consent,analytics_consent_updated_at')
        .eq('id', user.userId)
        .single();
      expect(result.error).toBeNull();
      return result.data!;
    };
    await expect.poll(async () => (await read()).analytics_consent).toBe(true);
    expect((await read()).analytics_consent_updated_at).not.toBeNull();
    await page.reload();
    // Desktop settings are a shell dialog. Reload returns to Calendar, so reopen the
    // category route before asserting that the saved preference is rendered again.
    await page.goto('/ja/settings/data');
    await expect(section.getByText('許可中', { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem('dayopt_cookie_consent')!).analytics,
      ),
    ).toBe(false);
    await section.getByRole('button', { name: '撤回する', exact: true }).click();
    await expect.poll(async () => (await read()).analytics_consent).toBe(false);
    await page.reload();
    await page.goto('/ja/settings/data');
    await expect(section.getByText('許可していません', { exact: true })).toBeVisible();
  });

  test('iCal generates and rotates its private URL, serves only owned Plans, and rejects the old token', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            localStorage.setItem('isolated-clipboard', value);
          },
        },
      });
    });
    await login(page);
    await page.goto('/ja/settings/integrations');
    await page.getByRole('button', { name: 'URLを生成', exact: true }).click();
    const feedInput = page.getByRole('textbox', { name: 'フィードURL', exact: true });
    await expect(feedInput).toBeVisible();
    const oldUrl = await feedInput.inputValue();
    expect(new URL(oldUrl).origin === new URL(page.url()).origin).toBe(true);
    await page.getByRole('button', { name: 'コピー', exact: true }).click();
    await expect(page.getByText('コピーしました', { exact: true }).first()).toBeVisible();
    expect(
      await page.evaluate(
        (expected) => localStorage.getItem('isolated-clipboard') === expected,
        oldUrl,
      ),
    ).toBe(true);
    const readFeed = (href: string) =>
      page.evaluate(async (feedUrl) => {
        const response = await fetch(feedUrl);
        return {
          status: response.status,
          type: response.headers.get('content-type'),
          text: await response.text(),
        };
      }, href);
    const initial = await readFeed(oldUrl);
    expect(initial.status).toBe(200);
    expect(initial.type).toContain('text/calendar');
    expect(initial.text).toContain('BEGIN:VCALENDAR');
    expect(initial.text).toContain(`UID:${planId}@`);
    expect(initial.text).toContain('SUMMARY:Owned iCal Plan');
    expect(initial.text.includes(recordId)).toBe(false);
    expect(initial.text.includes(otherPlanId)).toBe(false);
    expect(initial.text.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    await page.getByRole('button', { name: 'URLを再生成', exact: true }).click();
    const confirmation = page.getByRole('alertdialog');
    await confirmation.getByRole('button', { name: 'URLを再生成', exact: true }).click();
    await expect.poll(async () => (await feedInput.inputValue()) !== oldUrl).toBe(true);
    const newUrl = await feedInput.inputValue();
    expect(new URL(newUrl).origin === new URL(page.url()).origin).toBe(true);
    expect((await readFeed(oldUrl)).status).toBe(401);
    const rotated = await readFeed(newUrl);
    expect(rotated.status).toBe(200);
    expect(rotated.text).toBe(initial.text);
    const result = await admin
      .from('user_settings')
      .select('ical_feed_token')
      .eq('user_id', user.userId)
      .single();
    expect(result.error).toBeNull();
    expect(
      new URL(newUrl).pathname === `/api/v1/calendar/${result.data!.ical_feed_token}.ics`,
    ).toBe(true);
    await page.reload();
    // Desktop settings are a shell dialog. Reload returns to Calendar, so reopen
    // Integrations before asserting that the rotated token is still rendered.
    await page.goto('/ja/settings/integrations');
    await expect(feedInput).toHaveValue(newUrl);
  });
});
