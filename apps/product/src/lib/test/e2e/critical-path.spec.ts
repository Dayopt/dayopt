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

test.use({ trpcProcedureBudget: 26 });

/**
 * クリティカルパス E2E（desktop）— 計画 → 実績 → 振り返りの中核ループを実 UI 操作で通す
 *
 * 「作成導線が存在する」ではなく、ドラッグ選択 → アクティビティ選択で実際に Plan / Record を作り、
 * リロード後も残る（= DB へ永続化された）ことと、Report の配分へ反映されることを検証する。
 * mobile の同じループは mobile-critical-path.spec.ts（長押し → Drawer → ヘッダーのレポートリンク）。
 *
 * 過去帯ドラッグでパレットが開かない症状は、ドラッグ x 座標が Plan lane 側
 * （`box.width * 0.15`）だったことが原因だった。過去スロットの新規作成は宛先が
 * Record になる（docs/product/specs/plan-record.md §新規作成時の保存先ルール）ため、
 * Record lane 側（`box.width * 0.6`）へ変更して解消した。
 *
 * seed は service role で自前ユーザーを作る（block-search.spec.ts と同型）。
 * 実行先は resolveServiceRoleTarget が安全と判定した時だけ有効になる。
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
// service role で auth user / plan / record を作って消すため、実行先が安全な時だけ有効にする
const SERVICE_ROLE_TARGET = resolveServiceRoleTarget(SUPABASE_URL, SUPABASE_SERVICE_KEY);
// CI（E2E_REQUIRE_SERVICE_ROLE_SUITES=1）では skip を許さない。env が壊れて suite が
// 丸ごと消えても「0 failed」で緑になるのを防ぐ。
assertServiceRoleSuiteRunnable(SERVICE_ROLE_TARGET, 'Critical Path: 計画 → 実績 → 振り返り');
const describeWithEnv = SERVICE_ROLE_TARGET.safe ? test.describe : test.describe.skip;

const IDENTITY = createCriticalPathIdentity('critical-path');
const ACTIVITY_NAME = IDENTITY.activityName;
const RETURN_TARGET_DATE = offsetDateParam(1);

async function waitForTimeblockMutation(
  page: Page,
  procedure: string,
  action: () => Promise<void>,
) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.startsWith('/api/trpc/') &&
      new URL(response.url()).pathname.includes(procedure),
    { timeout: 15_000 },
  );
  await action();
  const response = await responsePromise;
  expect(response.ok(), `${procedure} が保存に失敗した（HTTP ${response.status()}）`).toBe(true);
}

async function editInspectorNote(page: Page, kind: 'plan' | 'record', note: string) {
  const inspector = page.getByRole('region', { name: ACTIVITY_NAME });
  const noteField = inspector.getByRole('textbox', { name: 'メモ' });
  await waitForTimeblockMutation(page, `${kind}Commands.update`, async () => {
    await noteField.fill(note);
    await noteField.blur();
  });
}

async function deleteInspectorTimeblock(page: Page, kind: 'plan' | 'record') {
  const inspector = page.getByRole('region', { name: ACTIVITY_NAME });
  await inspector.getByRole('button', { name: 'その他の操作' }).click();
  await waitForTimeblockMutation(page, `${kind}Commands.delete`, async () => {
    await page.getByRole('menuitem', { name: '削除', exact: true }).click();
  });
}

/**
 * カレンダーグリッド上を hourFrom → hourTo までドラッグ選択する。
 *
 * - 実際の時間セルから hourHeight を測り、レンダー中の外側グリッド高さには依存しない
 * - ドラッグ選択は mouse イベント + 5px 超の移動で成立（useDragSelection.ts）
 * - 対象時間帯が viewport 外だと mouse 座標が届かないため、先にスクロールで露出させる
 */
async function dragSelect(page: Page, hourFrom: number, hourTo: number) {
  const { box, hourBox, hourHeight } = await revealHour(page, hourFrom);

  const x = box.x + box.width * 0.6; // record lane 側
  const yFrom = hourBox.y;
  const yTo = hourBox.y + hourHeight * (hourTo - hourFrom);

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

  let adminSupabase: AdminSupabase;
  const tomorrow = offsetDateParam(1);

  test.beforeAll(async () => {
    adminSupabase = createAdminSupabase(SUPABASE_URL!, SUPABASE_SERVICE_KEY!);
    await seedCriticalPathUser(adminSupabase, IDENTITY, 'critical path e2e');
  });

  test.afterAll(async () => {
    if (!adminSupabase) return;
    await cleanupCriticalPathUser(adminSupabase, IDENTITY.userId);
  });

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name.includes('Mobile'),
      'desktop-only（ドラッグ座標は desktop 前提）',
    );
    if (testInfo.title.startsWith('認証後の戻り先:')) {
      await loginAs(page, IDENTITY, `/ja/calendar?view=day&date=${RETURN_TARGET_DATE}`);
      return;
    }
    await loginAs(page, IDENTITY);
  });

  test('認証後の戻り先: 元の保護URLを開く', async ({ page }) => {
    const current = new URL(page.url());
    expect(current.pathname).toBe('/ja/calendar');
    expect(current.searchParams.get('view')).toBe('day');
    expect(current.searchParams.get('date')).toBe(RETURN_TARGET_DATE);
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
  });

  test('明日の Plan を作成・編集・削除し、変更が永続化される', async ({ page }) => {
    await openDay(page, tomorrow);

    await dragSelect(page, 9, 10);

    // ドラッグ確定 → 編集と同じ右パネルが作成モードで開く
    const createPanel = page.getByRole('region', { name: 'アクティビティを選択' });
    await expect(createPanel).toBeVisible({ timeout: 10_000 });
    await clickAndAwaitCreate(
      page,
      createPanel.getByRole('button', { name: ACTIVITY_NAME }),
      'plan',
    );

    // Plan lane にカードが現れる（lane カードはアクティビティ名を表示する）
    const planCard = page.locator('[data-plan-lane-card]', { hasText: ACTIVITY_NAME }).first();
    await expect(planCard).toBeVisible({ timeout: 10_000 });

    await planCard.click();
    await editInspectorNote(page, 'plan', 'Preview E2E edited plan');

    // Full navigation clears the client cache; opening the block again confirms the DB value.
    await openDay(page, tomorrow);
    const persistedPlan = page.locator('[data-plan-lane-card]', { hasText: ACTIVITY_NAME }).first();
    await expect(persistedPlan).toBeVisible({ timeout: 10_000 });
    await persistedPlan.click();
    await expect(
      page.getByRole('region', { name: ACTIVITY_NAME }).getByRole('textbox', { name: 'メモ' }),
    ).toHaveValue('Preview E2E edited plan');

    await deleteInspectorTimeblock(page, 'plan');
    await expect(planCard).toHaveCount(0, { timeout: 10_000 });
    await page.reload();
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
    await expect(planCard).toHaveCount(0);
  });

  test('過去帯をドラッグして Record を記録し、リロード後も残る', async ({ page }) => {
    await openDay(page, offsetDateParam(-1));

    await dragSelect(page, 9, 10);

    // ドラッグ確定 → 編集と同じ右パネルが作成モードで開く
    const createPanel = page.getByRole('region', { name: 'アクティビティを選択' });
    await expect(createPanel).toBeVisible({ timeout: 10_000 });
    await clickAndAwaitCreate(
      page,
      createPanel.getByRole('button', { name: ACTIVITY_NAME }),
      'record',
    );

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
    await clickAndAwaitCreate(
      page,
      createPanel.getByRole('button', { name: ACTIVITY_NAME }),
      'plan',
    );

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

    await expectReportAllocationShowsOneHour(page, IDENTITY.activityName);
  });

  test('Record を作成・編集・削除し、変更が永続化される', async ({ page }) => {
    const twoDaysAgo = offsetDateParam(-2);
    await openDay(page, twoDaysAgo);
    await dragSelect(page, 9, 10);

    const createPanel = page.getByRole('region', { name: 'アクティビティを選択' });
    await expect(createPanel).toBeVisible({ timeout: 10_000 });
    await clickAndAwaitCreate(
      page,
      createPanel.getByRole('button', { name: ACTIVITY_NAME }),
      'record',
    );

    const recordCard = page.locator('[data-record-lane-card]', { hasText: ACTIVITY_NAME });
    await expect(recordCard).toHaveCount(1, { timeout: 10_000 });
    await recordCard.first().click();
    await editInspectorNote(page, 'record', 'Preview E2E edited record');

    // Reloading before reading checks the saved value rather than the optimistic UI state.
    await openDay(page, twoDaysAgo);
    const persistedRecord = page.locator('[data-record-lane-card]', { hasText: ACTIVITY_NAME });
    await expect(persistedRecord).toHaveCount(1, { timeout: 10_000 });
    await persistedRecord.first().click();
    await expect(
      page.getByRole('region', { name: ACTIVITY_NAME }).getByRole('textbox', { name: 'メモ' }),
    ).toHaveValue('Preview E2E edited record');

    await deleteInspectorTimeblock(page, 'record');
    await expect(recordCard).toHaveCount(0, { timeout: 10_000 });
    await page.reload();
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
    await expect(recordCard).toHaveCount(0);
  });
});
