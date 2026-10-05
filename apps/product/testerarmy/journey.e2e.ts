import { test, type Browser } from '@e2e-dev/web';
import { expect, type App } from 'e2e';

import {
  cleanupCriticalPathUser,
  createAdminSupabase,
  createCriticalPathIdentity,
  offsetDateParam,
  seedCriticalPathUser,
} from '../src/lib/test/e2e/critical-path-fixture';
import { REPORT_ALLOCATION } from '../src/lib/test/e2e/report-selectors';
import { resolveServiceRoleTarget } from '../src/lib/test/service-role-target-guard';
import { finishTesterArmyPreviewFence, installTesterArmyPreviewFence } from './preview-fixture';

// Do not silently skip when selected without the verified runner's prerequisites.
const target = resolveServiceRoleTarget(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
);
if (!target.safe || process.env.E2E_PRODUCT_AUTHENTICATED !== '1') {
  throw new Error('Product journey requires a verified non-production Supabase target');
}

const identity = createCriticalPathIdentity('critical-path');
const mobileIdentity = createCriticalPathIdentity('mobile-critical-path');
const admin = createAdminSupabase(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
);

test.beforeAll(async () => {
  await seedCriticalPathUser(admin, identity, 'TesterArmy synthetic journey');
  await seedCriticalPathUser(admin, mobileIdentity, 'TesterArmy synthetic mobile settings');
});

test.afterAll(async () => {
  await Promise.all([
    cleanupCriticalPathUser(admin, identity.userId),
    cleanupCriticalPathUser(admin, mobileIdentity.userId),
  ]);
});

test.beforeEach(async ({ browser }) => {
  await installTesterArmyPreviewFence(browser);
  await browser.addInitScript(() => {
    window.localStorage.setItem(
      'dayopt_cookie_consent',
      JSON.stringify({
        necessary: true,
        analytics: false,
        marketing: false,
        timestamp: Date.now(),
      }),
    );
  });
});

test.afterEach(async () => {
  await finishTesterArmyPreviewFence();
});

async function login(app: App, browser: Browser, selectedIdentity: typeof identity) {
  await app.open('/ja/auth/login');
  await browser.locator('input[type="email"]').fill(selectedIdentity.email);
  await browser.locator('input[type="password"]').fill(selectedIdentity.password);
  await browser.locator('button[type="submit"]').tap();
  await expect(browser).toHaveURL(/\/ja\/calendar(?:\?|$)/);
}

test('Plan and Record creation persist and the Record appears in review', async ({
  app,
  browser,
  screen,
}) => {
  await login(app, browser, identity);
  for (const scenario of [
    { offset: 1, hour: 9, kind: 'plan', choosePlan: false },
    { offset: -1, hour: 9, kind: 'record', choosePlan: false },
    { offset: -1, hour: 14, kind: 'plan', choosePlan: true },
  ] as const) {
    await app.open(`/ja/calendar?view=day&date=${offsetDateParam(scenario.offset)}`);
    await expect(browser.locator('[data-calendar-grid]').first()).toBeVisible();

    const geometry = await browser.evaluate((hour: number) => {
      const grid = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-calendar-grid][data-calendar-day-index="0"]',
        ),
      ].find((element) => element.getBoundingClientRect().height > 0);
      const cell = grid?.querySelector<HTMLElement>(`[data-calendar-hour="${hour}"]`);
      const scroll = grid?.closest<HTMLElement>('[data-calendar-scroll]');
      if (!grid || !cell || !scroll) throw new Error('Calendar hour is unavailable');
      const height = cell.getBoundingClientRect().height;
      if (height <= 0) throw new Error('Calendar hour has no geometry');
      scroll.scrollTo({ top: height * (hour - 1), behavior: 'instant' });
      const bounds = grid.getBoundingClientRect();
      return { x: bounds.x + bounds.width * 0.6, y: cell.getBoundingClientRect().y, height };
    }, scenario.hour);

    await browser.mouse.move(geometry.x, geometry.y);
    await browser.mouse.down();
    await browser.mouse.move(geometry.x, geometry.y + 24);
    await browser.mouse.move(geometry.x, geometry.y + geometry.height);
    await browser.mouse.up();
    const inspector = screen.getByRole('region', 'アクティビティを選択');
    await expect(inspector).toBeVisible();
    if (scenario.choosePlan) await inspector.getByRole('tab', '予定', { exact: true }).tap();
    const [saved] = await Promise.all([
      browser.waitForResponse(`**/api/trpc/*${scenario.kind}Commands.create*`),
      inspector.getByRole('button', identity.activityName, { exact: true }).tap(),
    ]);
    expect(saved.status).toBe(200);
    await browser.reload();
    const card = browser
      .locator(`[data-${scenario.kind}-lane-card]`)
      .filter({ hasText: identity.activityName })
      .first();
    await expect(card).toBeVisible();

    // Exact persisted interval and kind catch optimistic-only and wrong-lane successes.
    const { data, error } = await admin
      .from(scenario.kind === 'plan' ? 'plans' : 'records')
      .select('start_at,end_at')
      .eq('user_id', identity.userId);
    expect(error).toBe(null);
    const expectedStart = new Date(
      `${offsetDateParam(scenario.offset)}T${String(scenario.hour).padStart(2, '0')}:00:00+09:00`,
    ).toISOString();
    const matching = data?.filter((row) => new Date(row.start_at!).toISOString() === expectedStart);
    expect(matching?.length).toBe(1);
    const interval = matching![0]!;
    expect(new Date(interval!.end_at!).getTime() - new Date(interval!.start_at!).getTime()).toBe(
      3_600_000,
    );
    const opposite = await admin
      .from(scenario.kind === 'plan' ? 'records' : 'plans')
      .select('start_at')
      .eq('user_id', identity.userId);
    expect(opposite.error).toBe(null);
    expect(
      opposite.data?.filter((row) => new Date(row.start_at!).toISOString() === expectedStart)
        .length,
    ).toBe(0);
  }

  await app.open(`/ja/report?date=${offsetDateParam(-1)}&range=week`);
  const allocation = browser.locator(REPORT_ALLOCATION.chapter);
  await expect(allocation).toBeVisible();
  await expect(
    browser.locator(`${REPORT_ALLOCATION.chapter} ${REPORT_ALLOCATION.recordedHeadline}`),
  ).toHaveText('1時間');
  await expect(
    browser
      .locator(`${REPORT_ALLOCATION.chapter} ${REPORT_ALLOCATION.usageRows}`)
      .filter({ hasText: identity.activityName }),
  ).toContainText('1時間');
});

test('calendar and review navigation retain date and day count through reload and back', async ({
  app,
  browser,
  screen,
}) => {
  await login(app, browser, identity);
  const date = offsetDateParam(1);
  await app.open(`/ja/calendar?view=day&date=${date}`);
  await expect(browser.locator('[data-calendar-grid]')).toHaveCount(1);
  await screen.getByRole('tab', 'レポート').tap();
  await expect(browser).toHaveURL(new RegExp(`/ja/report\\?.*date=${date}`));
  await browser.reload();
  await expect(browser).toHaveURL(/\/ja\/report\?/);
  await screen.getByRole('tab', 'カレンダー').tap();
  await expect(browser).toHaveURL(/view=day/);
  await screen.getByRole('button', '日', { exact: true }).tap();
  await screen.getByRole('menuitem', /^3日\s*3$/).tap();
  await expect(browser).toHaveURL(/view=3day/);
  await expect(browser.locator('[data-calendar-grid]')).toHaveCount(3);
  await browser.back();
  await expect(browser).toHaveURL(/view=day/);
  await expect(browser.locator('[data-calendar-grid]')).toHaveCount(1);
});

test('mobile settings categories open their own named pages', async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  // A fresh context per test still signs in through UI; use the second owned identity
  // for mobile so both supervisor-declared identities have their own real flow.
  await login(app, browser, mobileIdentity);
  for (const [category, title] of [
    ['account', 'アカウント'],
    ['display', '表示'],
    ['data', 'データ'],
    ['integrations', '連携'],
    ['billing', '請求'],
  ] as const) {
    await app.open('/ja/settings');
    await browser.locator(`a[href="/ja/settings/${category}"]`).tap();
    await expect(browser).toHaveURL(new RegExp(`/ja/settings/${category}(?:\\?|$)`));
    await expect(screen.getByRole('heading', title, { exact: true })).toBeVisible();
  }
});
