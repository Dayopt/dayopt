import { expect, type Page } from '@playwright/test';

import {
  assertServiceRoleSuiteRunnable,
  resolveServiceRoleTarget,
} from '../service-role-target-guard';
import {
  type AdminSupabase,
  cleanupCriticalPathUser,
  clickAndAwaitCreate,
  createAdminSupabase,
  createCriticalPathIdentity,
  expectReportAllocationShowsOneHour,
  loginAs,
  offsetDateParam,
  openDay,
  revealHour,
  seedCriticalPathUser,
  TIMEZONE,
} from './critical-path-fixture';
import { test } from './trpc-budget-fixture';

// desktop の critical-path と同じループなので同じ予算。実測 12〜20（2026-09-14、local dev 2 run）
test.use({ trpcProcedureBudget: 26 });

/**
 * クリティカルパス E2E（mobile）— 計画 → 実績 → 振り返りを **mobile の実導線** で通す（#2743）
 *
 * desktop の critical-path.spec.ts をエミュレータで流すだけでは mobile の UX を守れない。
 * mobile は操作境界が 3 つ違うので、それぞれを実 UI で通す:
 *
 * - 作成は **長押し**（タップは無視、`DRAG_CONSTANTS.LONG_PRESS_DURATION`）。動かさずに
 *   離すと `resolveInstantSelection` が default_duration（seed で 60 分）の選択を確定する
 * - 作成 UI は右パネルではなく **Drawer**（`TimeblockInspector` の mobile 分岐）
 * - Report へは **ヘッダーのレポートリンク**（`MobileCalendarHeader`、BottomTabBar は #2300 で廃止）
 *
 * `Mobile Chrome` project は `@mobile` tag の test だけを持つ（playwright.config.ts の grep）。
 * CI では promote.yml の層 3 で chromium と同じ invocation に入る。
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const SERVICE_ROLE_TARGET = resolveServiceRoleTarget(SUPABASE_URL, SUPABASE_SERVICE_KEY);
assertServiceRoleSuiteRunnable(SERVICE_ROLE_TARGET, 'Mobile Critical Path: 計画 → 実績 → 振り返り');
const describeWithEnv = SERVICE_ROLE_TARGET.safe ? test.describe : test.describe.skip;

const IDENTITY = createCriticalPathIdentity('mobile-critical-path');
const MOBILE_TAG = { tag: '@mobile' };

/**
 * 長押しの保持時間。UI 仕様（300ms）そのものを待つ固定 wait なので許容し、
 * CI の遅い runner でも timer が確実に発火するよう 2 倍にする。
 */
const LONG_PRESS_HOLD_MS = 600;

/**
 * hour 時ちょうど付近を長押しして離す。
 *
 * touch は `data-calendar-hour` の cell へ落とす。React の onTouchStart は
 * CalendarDragSelection の handler div が bubbling で受けるため、その子孫でないと届かない
 * （`[data-calendar-grid]` は handler の親なので不可）。座標は handler が
 * `touches[0].clientY - rect.top` で時刻へ変換するので、実際の画面位置を渡す。
 */
async function longPressHour(page: Page, hour: number) {
  const { grid, box, hourBox, hourHeight } = await revealHour(page, hour);
  const target = grid.locator(`[data-calendar-hour="${hour}"]`).first();
  await expect(target).toBeAttached();

  const x = box.x + box.width * 0.6;
  // 15 分 snap の境界を跨がないよう、hour の頭から少しだけ下げる
  const y = hourBox.y + hourHeight * 0.1;
  const touch = { identifier: 1, clientX: x, clientY: y, pageX: x, pageY: y };

  await target.dispatchEvent('touchstart', {
    touches: [touch],
    targetTouches: [touch],
    changedTouches: [touch],
  });
  await page.waitForTimeout(LONG_PRESS_HOLD_MS);
  await target.dispatchEvent('touchend', {
    touches: [],
    targetTouches: [],
    changedTouches: [touch],
  });
}

/** 作成モードの Drawer（DrawerTitle = アクティビティを選択）からアクティビティを選ぶ。 */
async function pickActivityInDrawer(page: Page, kind: 'plan' | 'record') {
  const drawer = page.getByRole('dialog', { name: 'アクティビティを選択' });
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  await clickAndAwaitCreate(
    page,
    drawer.getByRole('button', { name: IDENTITY.activityName }),
    kind,
  );
}

/** 自前ユーザーの作成済みカードだけを編集・削除し、各書き込み後の永続状態を確認する。 */
async function updateAndDeleteOwnedCard(page: Page, kind: 'plan' | 'record') {
  const date = offsetDateParam(kind === 'plan' ? 1 : -1);
  const cards = page.locator(`[data-${kind}-lane-card][data-timeblock-id]`, {
    hasText: IDENTITY.activityName,
  });
  const note = `${kind} updated ${IDENTITY.activityName}`;

  async function awaitCommand(action: 'update' | 'delete', interact: () => Promise<void>) {
    const procedure = `${kind}Commands.${action}`;
    const saved = page.waitForResponse(
      (response) => {
        const path = new URL(response.url()).pathname;
        return (
          response.request().method() === 'POST' &&
          path.startsWith('/api/trpc/') &&
          decodeURIComponent(path.slice('/api/trpc/'.length)).split(',').includes(procedure)
        );
      },
      { timeout: 15_000 },
    );
    const [response] = await Promise.all([saved, Promise.resolve().then(interact)]);
    expect(response.status(), `${procedure} の保存応答`).toBe(200);
  }

  const { card, inspector } = await test.step('owned card open', async () => {
    await openDay(page, date);
    // serial suite が作成した同じ日・同じ種別の 1 件だけを対象にする。
    await expect(cards).toHaveCount(1);
    const id = await cards.getAttribute('data-timeblock-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    const card = page.locator(`[data-${kind}-lane-card][data-timeblock-id="${id}"]`);
    const inspector = page.getByRole('dialog', { name: IDENTITY.activityName, exact: true });
    await card.click();
    await expect(inspector).toBeVisible();
    return { card, inspector };
  });

  await test.step('note update', async () => {
    await inspector.getByRole('button', { name: 'メモ', exact: true }).click();
    const noteInput = inspector.getByRole('textbox', { name: 'メモ', exact: true });
    await awaitCommand('update', async () => {
      await noteInput.fill(note);
      await noteInput.blur();
    });
  });

  await test.step('persisted note check', async () => {
    await page.reload();
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
    await expect(card).toBeVisible();
    // reload 後に Inspector が復元された場合も、一度閉じて同じ ID のカードを開く。
    if (await inspector.isVisible()) {
      await inspector.getByRole('button', { name: '閉じる', exact: true }).click();
    }
    await card.click();
    await expect(inspector).toBeVisible();
    await expect(inspector.getByRole('button', { name: 'メモ', exact: true })).toHaveText(note);
  });

  await test.step('deletion check', async () => {
    await inspector.getByRole('button', { name: 'その他の操作', exact: true }).click();
    await awaitCommand('delete', () =>
      page.getByRole('menuitem', { name: '削除', exact: true }).click(),
    );
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
    await expect(card).toHaveCount(0);
    await expect(cards).toHaveCount(0);
  });
}

describeWithEnv('Mobile Critical Path: 計画 → 実績 → 振り返り', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ timezoneId: TIMEZONE });

  let adminSupabase: AdminSupabase;

  test.beforeAll(async () => {
    adminSupabase = createAdminSupabase(SUPABASE_URL!, SUPABASE_SERVICE_KEY!);
    await seedCriticalPathUser(adminSupabase, IDENTITY, 'mobile critical path e2e');
  });

  test.afterAll(async () => {
    if (!adminSupabase) return;
    await cleanupCriticalPathUser(adminSupabase, IDENTITY.userId);
  });

  test.beforeEach(async ({ page }, testInfo) => {
    // grep で Mobile Chrome に寄せているが、project を指定しないローカル実行でも誤走しないよう残す
    test.skip(!testInfo.project.name.includes('Mobile'), 'mobile-only');
    await loginAs(page, IDENTITY);
  });

  test('明日の枠を長押しして Plan を作成し、リロード後も残る', MOBILE_TAG, async ({ page }) => {
    await openDay(page, offsetDateParam(1));

    await longPressHour(page, 9);
    await pickActivityInDrawer(page, 'plan');

    const planCard = page.locator('[data-plan-lane-card]', { hasText: IDENTITY.activityName });
    await expect(planCard.first()).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
    await expect(planCard.first()).toBeVisible({ timeout: 10_000 });
  });

  test('昨日の枠を長押しして Record を記録し、リロード後も残る', MOBILE_TAG, async ({ page }) => {
    await openDay(page, offsetDateParam(-1));

    // 過去スロットの既定は Record（resolveTimeblockDestination）。タブは触らない
    await longPressHour(page, 9);
    await pickActivityInDrawer(page, 'record');

    const recordCard = page.locator('[data-record-lane-card]', { hasText: IDENTITY.activityName });
    await expect(recordCard.first()).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
    await expect(recordCard.first()).toBeVisible({ timeout: 10_000 });
  });

  test(
    'ヘッダーのレポートリンクから開いた Report に記録が反映される',
    MOBILE_TAG,
    async ({ page }) => {
      await openDay(page, offsetDateParam(-1));
      await page.getByRole('link', { name: 'レポートを開く' }).click();
      await expect(page).toHaveURL(/\/ja\/report\?/, { timeout: 10_000 });

      await expectReportAllocationShowsOneHour(page, IDENTITY.activityName);
    },
  );
  // 更新・削除は Report の検証後。作成済みの自前データだけを消す。
  test.describe('UI で更新・削除', () => {
    // login + 編集前/保存後/削除後の読み直しを含む往復の予算。
    test.use({ trpcProcedureBudget: 40 });
    for (const kind of ['plan', 'record'] as const) {
      test(
        `作成済み ${kind} のメモを更新して保存を確認し、UI で削除する`,
        MOBILE_TAG,
        async ({ page }) => {
          test.setTimeout(60_000);
          await updateAndDeleteOwnedCard(page, kind);
        },
      );
    }
  });
});
