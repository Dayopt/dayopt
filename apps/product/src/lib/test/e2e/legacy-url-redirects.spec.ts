import { expect, test } from '@playwright/test';

import { resolveServiceRoleTarget } from '../service-role-target-guard';
import {
  createScopedTestUser,
  deleteScopedTestUser,
  type ScopedTestUser,
} from './create-scoped-test-user';

/**
 * Legacy URL Redirect E2E
 *
 * workspace-shell-restructure（#2181）Step 2: 旧 URL（/day, /week, /Nday、
 * `?panel=` 付き含む）から `/calendar` `/report` への写像を実ブラウザで検証する
 * （旧 docs/projects/_archive/workspace-shell-restructure/overview.md §4-4、
 * docs/projects 全廃に伴い #2473 で削除。git 履歴参照）。
 *
 * `proxy.test.ts`（unit）が同じ写像ロジックを網羅済みだが、ここでは実際の
 * ブラウザナビゲーションとして「旧 URL の deep link が壊れていない」ことを固定する。
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY;
const SERVICE_ROLE_TARGET = resolveServiceRoleTarget(SUPABASE_URL, SERVICE_ROLE_KEY);

let testUser: ScopedTestUser | undefined;

async function login(page: import('@playwright/test').Page) {
  await page.goto('/ja/auth/login');
  await page.waitForLoadState('networkidle');

  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  const passwordInput = page.locator('input[type="password"]').first();
  const submitButton = page.locator('button[type="submit"]').first();

  await emailInput.fill(testUser!.email);
  await passwordInput.fill(testUser!.password);
  await submitButton.click();

  await page.waitForURL(/\/ja\/calendar/i, { timeout: 15000 });
}

test.describe('Legacy URL redirects', () => {
  test.skip(!SERVICE_ROLE_TARGET.safe, SERVICE_ROLE_TARGET.safe ? '' : SERVICE_ROLE_TARGET.reason);

  test.beforeAll(async () => {
    if (!SERVICE_ROLE_TARGET.safe) return;
    testUser = await createScopedTestUser(SUPABASE_URL!, SERVICE_ROLE_KEY!, 'legacy-url');
  });

  test.afterAll(async () => {
    if (!testUser) return;
    await deleteScopedTestUser(SUPABASE_URL!, SERVICE_ROLE_KEY!, testUser.userId);
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  const legacyToCalendar: Array<[string, string]> = [
    ['/ja/day?date=2026-04-20', '/ja/calendar?date=2026-04-20&view=day'],
    ['/ja/week?date=2026-04-20', '/ja/calendar?date=2026-04-20&view=week'],
    ['/ja/2day?date=2026-04-20', '/ja/calendar?date=2026-04-20&view=2day'],
    ['/ja/7day?date=2026-04-20', '/ja/calendar?date=2026-04-20&view=7day'],
  ];

  for (const [from, to] of legacyToCalendar) {
    test(`${from} redirects to ${to}`, async ({ page }) => {
      await page.goto(from);
      await expect(page).toHaveURL(new RegExp(to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
  }

  test('panel=review redirects to /report with range derived from view', async ({ page }) => {
    await page.goto('/ja/week?date=2026-04-20&panel=review&reviewTagId=some-tag');
    await expect(page).toHaveURL(/\/ja\/report\?date=2026-04-20&range=week/);
    // reviewTagId は落ちる（§4-4）
    await expect(page).not.toHaveURL(/reviewTagId/);
  });

  test('panel=diff on day view redirects to /report with range=week', async ({ page }) => {
    // レポートは週 / 月 / 年の 3 粒度しか持たない（#2575）。旧 day 系リンクは週へ寄る。
    await page.goto('/ja/day?date=2026-04-20&panel=diff');
    await expect(page).toHaveURL(/\/ja\/report\?date=2026-04-20&range=week/);
  });

  test('panel=analytics（旧URL別名）redirects to /report — 恒久 shim を redirect 層が引き継ぐ', async ({
    page,
  }) => {
    await page.goto('/ja/day?date=2026-04-20&panel=analytics');
    await expect(page).toHaveURL(/\/ja\/report\?date=2026-04-20&range=week/);
  });

  test('送信済みメールが焼き付けている裸の /week（locale prefix・query 無し）も /calendar へ着地する', async ({
    page,
  }) => {
    // WelcomeEmail 等 4 通は既に `/calendar` へ修正済みだが（#2181 Step 2）、
    // 修正前に送信済みのメールは `${appUrl}/week` を焼き付けたまま回収できない
    // （overview.md §4-6）。redirect 層がこの形のまま生き続けることを固定する。
    await page.goto('/week');
    // resolveLegacyWorkspaceRedirect は legacyView を view クエリへ写すため
    // `?view=week` が付く（`/ja/calendar` への着地自体が本題で、query の有無は問わない）。
    await expect(page).toHaveURL(/\/ja\/calendar(\?|$)/);
  });
});
