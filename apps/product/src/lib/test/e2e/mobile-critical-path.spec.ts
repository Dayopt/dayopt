import { expect, type Page } from '@playwright/test';

import { expectIndependentPersistedHour } from '../critical-path-persistence';

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
 * クリティカルパス E2E（mobile）— 計画 → 実績 → アクティビティ詳細を **mobile の実導線** で通す（#2743）
 *
 * desktop の critical-path.spec.ts をエミュレータで流すだけでは mobile の UX を守れない。
 * mobile は操作境界が 3 つ違うので、それぞれを実 UI で通す:
 *
 * - 作成は **長押し**（タップは無視、`DRAG_CONSTANTS.LONG_PRESS_DURATION`）。動かさずに
 *   離すと `resolveInstantSelection` が default_duration（seed で 60 分）の選択を確定する
 * - 作成 UI は右パネルではなく **Drawer**（`TimeblockInspector` の mobile 分岐）
 * - アクティビティ詳細は **ActivityChipRow のメニュー**から開き、記録を選ぶと Inspector へ移る
 *
 * `Mobile Chrome` project は `@mobile` tag の test だけを持つ（playwright.config.ts の grep）。
 * CI では promote.yml の層 3 で chromium と同じ invocation に入る。
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const SERVICE_ROLE_TARGET = resolveServiceRoleTarget(SUPABASE_URL, SUPABASE_SERVICE_KEY);
assertServiceRoleSuiteRunnable(
  SERVICE_ROLE_TARGET,
  'Mobile Critical Path: 計画 → 実績 → アクティビティ詳細',
);
const describeWithEnv = SERVICE_ROLE_TARGET.safe ? test.describe : test.describe.skip;

const IDENTITY = createCriticalPathIdentity('mobile-critical-path');

function mobilePreviewFlowTag(flowId: string) {
  return { tag: ['@mobile', `@preview-e2e/${flowId}`] };
}

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

describeWithEnv('Mobile Critical Path: 計画 → 実績 → アクティビティ詳細', () => {
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

  test(
    '明日の枠を長押しして Plan を作成し、リロード後も残る',
    mobilePreviewFlowTag('mobile-plan-create'),
    async ({ page }) => {
      await openDay(page, offsetDateParam(1));

      await longPressHour(page, 9);
      await pickActivityInDrawer(page, 'plan');

      const planCard = page.locator('[data-plan-lane-card]', { hasText: IDENTITY.activityName });
      await expect(planCard.first()).toBeVisible({ timeout: 10_000 });

      await page.reload();
      await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
      await expect(planCard.first()).toBeVisible({ timeout: 10_000 });
      await expectIndependentPersistedHour(
        adminSupabase,
        IDENTITY.userId,
        'plan',
        offsetDateParam(1),
        9,
      );
    },
  );

  test(
    '昨日の枠を長押しして Record を記録し、リロード後も残る',
    mobilePreviewFlowTag('mobile-record-create'),
    async ({ page }) => {
      await openDay(page, offsetDateParam(-1));

      // 過去スロットの既定は Record（resolveTimeblockDestination）。タブは触らない
      await longPressHour(page, 9);
      await pickActivityInDrawer(page, 'record');

      const recordCard = page.locator('[data-record-lane-card]', {
        hasText: IDENTITY.activityName,
      });
      await expect(recordCard.first()).toBeVisible({ timeout: 10_000 });

      await page.reload();
      await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
      await expect(recordCard.first()).toBeVisible({ timeout: 10_000 });
      await expectIndependentPersistedHour(
        adminSupabase,
        IDENTITY.userId,
        'record',
        offsetDateParam(-1),
        9,
      );
    },
  );

  test(
    'ActivityChipRow から詳細を開き、記録を選んで Inspector へ移る',
    mobilePreviewFlowTag('mobile-summary-to-inspector'),
    async ({ page }) => {
      await openDay(page, offsetDateParam(-1));
      await page
        .getByRole('button', {
          name: `アクティビティメニュー: ${IDENTITY.activityName}`,
          exact: true,
        })
        .click();
      await page.getByRole('menuitem', { name: 'アクティビティの詳細', exact: true }).click();

      const sheet = page.locator('[data-activity-summary-sheet="true"]');
      await expect(sheet).toBeVisible();
      await expect(sheet.getByText('記録合計', { exact: true }).locator('..')).toContainText(
        '1時間',
      );
      const record = await adminSupabase
        .from('records')
        .select('id')
        .eq('user_id', IDENTITY.userId)
        .single();
      expect(record.error === null).toBe(true);
      const recordRows = sheet.locator('section ul > li > button');
      await expect(recordRows).toHaveCount(1);
      await recordRows.first().click();

      await expect
        .poll(() => new URL(page.url()).searchParams.get('timeblock'))
        .toBe(`record:${record.data!.id}`);
      await expect(sheet).toBeHidden();
      await expect(page.getByRole('textbox', { name: 'メモ', exact: true })).toBeVisible();
    },
  );

  test(
    'mobile の設定一覧から表示設定を変更し、戻る導線と永続化を確認する',
    mobilePreviewFlowTag('mobile-settings-display'),
    async ({ page }) => {
      await page.goto('/ja/settings?returnTo=%2F%3Fview%3Dday');
      await page.getByRole('link', { name: '表示', exact: true }).click();
      await expect(page).toHaveURL(/\/ja\/settings\/display\?/);
      const format = page.getByRole('combobox', { name: '時間表示形式', exact: true });
      await format.click();
      await page.getByRole('option', { name: '12時間表記 (1:00 PM)', exact: true }).click();
      await expect
        .poll(async () => {
          const result = await adminSupabase
            .from('user_settings')
            .select('time_format')
            .eq('user_id', IDENTITY.userId)
            .single();
          expect(result.error === null).toBe(true);
          return result.data?.time_format;
        })
        .toBe('12h');
      await page.reload();
      await expect(format).toContainText('12時間表記');
      await page.getByRole('link', { name: '戻る', exact: true }).click();
      await expect(page).toHaveURL(/\/ja\/settings\?/);
      await page.getByRole('link', { name: '戻る', exact: true }).click();
      await expect(page).toHaveURL(/\/ja\/?\?view=day(?:&.*)?$/);
      await expect(page.locator('[data-calendar-grid]').first()).toBeVisible();
    },
  );
  test('過去の枠でも明示選択すれば Plan として保存される', { tag: '@mobile' }, async ({ page }) => {
    const yesterday = offsetDateParam(-1);
    await openDay(page, yesterday);

    await longPressHour(page, 14);
    const drawer = page.getByRole('dialog', { name: 'アクティビティを選択' });
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    await drawer.getByRole('tab', { name: '予定', exact: true }).click();
    await clickAndAwaitCreate(
      page,
      drawer.getByRole('button', { name: IDENTITY.activityName }),
      'plan',
    );

    const planCard = page.locator('[data-plan-lane-card]', { hasText: IDENTITY.activityName });
    await expect(planCard.first()).toBeVisible({ timeout: 10_000 });
    await page.reload();
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
    await expect(planCard.first()).toBeVisible({ timeout: 10_000 });
    await expectIndependentPersistedHour(adminSupabase, IDENTITY.userId, 'plan', yesterday, 14);
  });
});
