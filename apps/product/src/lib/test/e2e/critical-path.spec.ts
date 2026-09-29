import { expect, type Page } from '@playwright/test';

import { loadPreviewFixtureRegistry, resolveCriticalPathTarget } from '../preview-fixture-registry';
import { assertServiceRoleSuiteRunnable } from '../service-role-target-guard';
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
 * legacy は service role で自前ユーザーを作る。registry は既に用意された通常ユーザーを使う。
 * どちらも resolveCriticalPathTarget が安全と判定した時だけ有効になる。
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const REGISTRY = loadPreviewFixtureRegistry();
const SERVICE_ROLE_TARGET = resolveCriticalPathTarget();
// CI（E2E_REQUIRE_SERVICE_ROLE_SUITES=1）では skip を許さない。env が壊れて suite が
// 丸ごと消えても「0 failed」で緑になるのを防ぐ。
assertServiceRoleSuiteRunnable(SERVICE_ROLE_TARGET, 'Critical Path: 計画 → 実績 → 振り返り');
const describeWithEnv = SERVICE_ROLE_TARGET.safe ? test.describe : test.describe.skip;

const IDENTITY = createCriticalPathIdentity('critical-path');
const ACTIVITY_NAME = IDENTITY.activityName;

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
    const inspector = page.getByRole('region', { name: IDENTITY.activityName, exact: true });
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

describeWithEnv('Critical Path: 計画 → 実績 → 振り返り', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ timezoneId: TIMEZONE });

  let adminSupabase: AdminSupabase;
  const tomorrow = offsetDateParam(1);

  test.beforeAll(async () => {
    if (REGISTRY) return;
    adminSupabase = createAdminSupabase(SUPABASE_URL!, SUPABASE_SERVICE_KEY!);
    await seedCriticalPathUser(adminSupabase, IDENTITY, 'critical path e2e');
  });

  test.afterAll(async () => {
    if (REGISTRY) return;
    if (!adminSupabase) return;
    await cleanupCriticalPathUser(adminSupabase, IDENTITY.userId);
  });

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name.includes('Mobile'),
      'desktop-only（ドラッグ座標は desktop 前提）',
    );
    await loginAs(page, IDENTITY);
  });

  test('ドラッグ選択とアクティビティ選択で明日の Plan を作成し、リロード後も残る', async ({
    page,
  }) => {
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

    // リロードしても残る = DB へ永続化されている
    await page.reload();
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('[data-plan-lane-card]', { hasText: ACTIVITY_NAME }).first(),
    ).toBeVisible({
      timeout: 10_000,
    });
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
  // 更新・削除は Report の検証後。作成済みの自前データだけを消す。
  test.describe('UI で更新・削除', () => {
    // login + 編集前/保存後/削除後の読み直しを含む往復の予算。
    test.use({ trpcProcedureBudget: 40 });
    for (const kind of ['plan', 'record'] as const) {
      test(`作成済み ${kind} のメモを更新して保存を確認し、UI で削除する`, async ({ page }) => {
        test.setTimeout(60_000);
        await updateAndDeleteOwnedCard(page, kind);
      });
    }
  });
});
