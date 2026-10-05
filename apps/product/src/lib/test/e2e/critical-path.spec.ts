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
    await expectIndependentPersistedHour(adminSupabase, IDENTITY.userId, 'plan', tomorrow, 9);
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
    await expectIndependentPersistedHour(
      adminSupabase,
      IDENTITY.userId,
      'record',
      offsetDateParam(-1),
      9,
    );
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
    await expectIndependentPersistedHour(
      adminSupabase,
      IDENTITY.userId,
      'plan',
      offsetDateParam(-1),
      14,
    );
  });

  test('記録した実績が /report の 1 章（配分）に反映される', async ({ page }) => {
    // レポートは週 / 月 / 年の 3 粒度（#2575）。前日の記録は今週の中に入る。
    await page.goto(`/ja/report?date=${offsetDateParam(-1)}&range=week`);

    await expectReportAllocationShowsOneHour(page, IDENTITY.activityName);
  });

  test('表示名と時間表示を変更するとリロード後も UI と DB に残る', async ({ page }) => {
    const displayName = `Profile ${IDENTITY.userId.slice(0, 8)}`;
    await page.goto('/ja/settings/account');
    await page.getByRole('button', { name: /表示名/ }).click();
    const dialog = page.getByRole('dialog', { name: '表示名', exact: true });
    await dialog.getByLabel('表示名', { exact: true }).fill(displayName);
    await dialog.getByRole('button', { name: '確認', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    await expect(page.getByRole('button', { name: /表示名/ })).toContainText(displayName);
    const profile = await adminSupabase
      .from('profiles')
      .select('full_name')
      .eq('id', IDENTITY.userId)
      .single();
    expect(profile.error === null).toBe(true);
    expect(profile.data?.full_name).toBe(displayName);

    await page.goto('/ja/settings/display');
    const timeFormat = page.getByRole('combobox', { name: '時間表示形式', exact: true });
    await timeFormat.click();
    await page.getByRole('option', { name: '12時間表記 (1:00 PM)', exact: true }).click();
    await expect
      .poll(async () => {
        const settings = await adminSupabase
          .from('user_settings')
          .select('time_format')
          .eq('user_id', IDENTITY.userId)
          .single();
        expect(settings.error === null).toBe(true);
        return settings.data?.time_format;
      })
      .toBe('12h');
    await page.reload();
    await expect(timeFormat).toContainText('12時間表記');
  });

  test('JSON と期間指定 CSV を実際にダウンロードし、所有する Plan / Record が入る', async ({
    page,
  }) => {
    await page.goto('/ja/settings/data');
    const downloadText = async () => {
      const pending = page.waitForEvent('download');
      await page.getByRole('button', { name: 'エクスポート', exact: true }).click();
      const download = await pending;
      expect(await download.failure()).toBeNull();
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return { name: download.suggestedFilename(), text: Buffer.concat(chunks).toString('utf8') };
    };
    const json = await downloadText();
    expect(json.name).toMatch(/\.json$/);
    const backup = JSON.parse(json.text);
    expect(backup.userId).toBe(IDENTITY.userId);
    const plans = await adminSupabase.from('plans').select('id').eq('user_id', IDENTITY.userId);
    const records = await adminSupabase.from('records').select('id').eq('user_id', IDENTITY.userId);
    expect(plans.error === null && records.error === null).toBe(true);
    expect(plans.data).toHaveLength(2);
    expect(records.data).toHaveLength(1);
    expect(backup.data.plans.map((row: { id: string }) => row.id).sort()).toEqual(
      plans.data!.map((row) => row.id).sort(),
    );
    expect(backup.data.records.map((row: { id: string }) => row.id).sort()).toEqual(
      records.data!.map((row) => row.id).sort(),
    );
    expect(backup.data.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: ACTIVITY_NAME, user_id: IDENTITY.userId }),
      ]),
    );
    expect(backup.data.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: IDENTITY.categoryName, user_id: IDENTITY.userId }),
      ]),
    );

    await page.getByRole('combobox', { name: '形式', exact: true }).click();
    await page.getByRole('option', { name: 'CSV（スプレッドシート用）', exact: true }).click();
    await page.getByRole('combobox', { name: '範囲', exact: true }).click();
    await page.getByRole('option', { name: '期間指定', exact: true }).click();
    await page.getByLabel('開始日', { exact: true }).fill(offsetDateParam(-1));
    await page.getByLabel('終了日', { exact: true }).fill(offsetDateParam(-1));
    const csv = await downloadText();
    expect(csv.name).toMatch(/\.csv$/);
    const rows = csv.text.split('\n');
    expect(rows[0]).toBe(
      'kind,id,title,note,activity_id,start_at,end_at,source,fulfillment,created_at,updated_at,deleted_at',
    );
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.startsWith('plan,'))).toHaveLength(1);
    expect(rows.filter((row) => row.startsWith('record,'))).toHaveLength(1);
    for (const row of rows.slice(1)) expect(row).toContain(`${offsetDateParam(-1)}T`);
    const exportedIds = rows
      .slice(1)
      .map((row) => row.split(',')[1])
      .sort();
    const expectedIds = [...backup.data.plans, ...backup.data.records]
      .filter((row: { start_at: string }) => row.start_at.startsWith(offsetDateParam(-1)))
      .map((row: { id: string }) => row.id)
      .sort();
    expect(exportedIds).toEqual(expectedIds);
    const tomorrowPlan = backup.data.plans.find((row: { start_at: string }) =>
      row.start_at.startsWith(tomorrow),
    );
    expect(tomorrowPlan).toBeDefined();
    expect(csv.text).not.toContain(tomorrowPlan.id);
  });

  test('アクティビティの改名・アーカイブ・復元が保存され、既存 Plan / Record は消えない', async ({
    page,
  }) => {
    const renamed = `Renamed ${IDENTITY.userId.slice(0, 8)}`;
    const beforePlans = await adminSupabase
      .from('plans')
      .select('id,activity_id')
      .eq('user_id', IDENTITY.userId)
      .order('id');
    const beforeRecords = await adminSupabase
      .from('records')
      .select('id,activity_id')
      .eq('user_id', IDENTITY.userId)
      .order('id');
    expect(beforePlans.error === null && beforeRecords.error === null).toBe(true);
    await openDay(page, tomorrow);
    const activityRow = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('button', { name: ACTIVITY_NAME, exact: true }) });
    await expect(activityRow).toHaveCount(1);
    await activityRow.hover();
    await activityRow.getByRole('button', { name: 'アクティビティメニュー', exact: true }).click();
    await page.getByRole('menuitem', { name: '名前を変更', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '名前を変更', exact: true });
    await dialog.getByRole('textbox', { name: '名前', exact: true }).fill(renamed);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    const renamedRow = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('button', { name: renamed, exact: true }) });
    await expect(renamedRow).toHaveCount(1);
    await renamedRow.hover();
    await renamedRow.getByRole('button', { name: 'アクティビティメニュー', exact: true }).click();
    await page.getByRole('menuitem', { name: 'アーカイブ', exact: true }).click();
    await expect
      .poll(async () => {
        const result = await adminSupabase
          .from('activities')
          .select('name,archived_at')
          .eq('user_id', IDENTITY.userId)
          .single();
        expect(result.error === null).toBe(true);
        expect(result.data?.name).toBe(renamed);
        return result.data?.archived_at != null;
      })
      .toBe(true);
    await page.reload();
    await expect(renamedRow).toHaveCount(0);
    // Archived items are shown through the actual sidebar filter, then restored by its menu.
    await page.getByRole('button', { name: 'フィルター', exact: true }).click();
    await page.getByRole('menuitem', { name: /ステータス/ }).hover();
    await page.getByRole('menuitemradio', { name: 'すべて', exact: true }).click();
    const archivedRow = page
      .getByRole('listitem')
      .filter({ has: page.getByText(renamed, { exact: true }) });
    await expect(archivedRow).toHaveCount(1);
    await archivedRow.hover();
    await archivedRow.getByRole('button', { name: 'アクティビティメニュー', exact: true }).click();
    await page.getByRole('menuitem', { name: '復元', exact: true }).click();
    await expect
      .poll(async () => {
        const result = await adminSupabase
          .from('activities')
          .select('archived_at')
          .eq('user_id', IDENTITY.userId)
          .single();
        expect(result.error === null).toBe(true);
        return result.data?.archived_at;
      })
      .toBeNull();
    await page.reload();
    await expect(renamedRow).toHaveCount(1);
    const afterPlans = await adminSupabase
      .from('plans')
      .select('id,activity_id')
      .eq('user_id', IDENTITY.userId)
      .order('id');
    const afterRecords = await adminSupabase
      .from('records')
      .select('id,activity_id')
      .eq('user_id', IDENTITY.userId)
      .order('id');
    expect(afterPlans.error === null && afterRecords.error === null).toBe(true);
    expect(afterPlans.data).toEqual(beforePlans.data);
    expect(afterRecords.data).toEqual(beforeRecords.data);
  });

  test('テーマ・タイムゾーン・言語の変更がリロード後も保持される', async ({ page }) => {
    await page.goto('/ja/settings/display');
    await page.getByRole('combobox', { name: 'テーマ', exact: true }).click();
    await page.getByRole('option', { name: 'ダーク', exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(page.getByRole('combobox', { name: 'テーマ', exact: true })).toContainText(
      'ダーク',
    );
    const timezone = page.getByRole('combobox', { name: 'タイムゾーン', exact: true });
    await timezone.click();
    await page.getByRole('option', { name: 'シドニー (GMT+10)', exact: true }).click();
    await expect
      .poll(async () => {
        const result = await adminSupabase
          .from('user_settings')
          .select('timezone')
          .eq('user_id', IDENTITY.userId)
          .single();
        expect(result.error === null).toBe(true);
        return result.data?.timezone;
      })
      .toBe('Australia/Sydney');
    await page.reload();
    await expect(timezone).toContainText('シドニー');
    await timezone.click();
    await page.getByRole('option', { name: '東京 (GMT+9)', exact: true }).click();
    await expect
      .poll(async () => {
        const result = await adminSupabase
          .from('user_settings')
          .select('timezone')
          .eq('user_id', IDENTITY.userId)
          .single();
        return result.error === null ? result.data?.timezone : null;
      })
      .toBe(TIMEZONE);
    await page.getByRole('combobox', { name: '言語', exact: true }).click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await expect(page).toHaveURL(/\/en\/settings\/display$/);
    await expect
      .poll(async () => {
        const result = await adminSupabase
          .from('user_settings')
          .select('preferred_locale')
          .eq('user_id', IDENTITY.userId)
          .single();
        expect(result.error === null).toBe(true);
        return result.data?.preferred_locale;
      })
      .toBe('en');
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toContainText(
      'English',
    );
    await page.getByRole('combobox', { name: 'Language', exact: true }).click();
    await page.getByRole('option', { name: '日本語', exact: true }).click();
    await expect(page).toHaveURL(/\/ja\/settings\/display$/);
    await expect
      .poll(async () => {
        const result = await adminSupabase
          .from('user_settings')
          .select('preferred_locale')
          .eq('user_id', IDENTITY.userId)
          .single();
        return result.error === null ? result.data?.preferred_locale : null;
      })
      .toBe('ja');
  });

  test.describe('Activity management', () => {
    // This CRUD round-trip intentionally performs more mutations than one core timeblock flow.
    test.use({ trpcProcedureBudget: 60 });
    test('カテゴリーと所属アクティビティを UI から作成し、カテゴリー削除は未分類化だけを行う', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const categoryName = `Created Cat ${IDENTITY.userId.slice(0, 8)}`;
      const activityName = `Created Activity ${IDENTITY.userId.slice(0, 8)}`;
      await openDay(page, tomorrow);
      const createCategory = page.getByRole('button', { name: 'カテゴリーを作成', exact: true });
      await createCategory.hover();
      await createCategory.click();
      const categoryDialog = page.getByRole('dialog', { name: 'カテゴリーを作成', exact: true });
      await categoryDialog
        .getByRole('textbox', { name: 'カテゴリーを作成', exact: true })
        .fill(categoryName);
      await categoryDialog.getByRole('button', { name: 'カテゴリーを作成', exact: true }).click();
      await expect(categoryDialog).toBeHidden();
      let categoryHeader = page.getByText(categoryName, { exact: true }).locator('..');
      await expect(categoryHeader).toBeVisible();
      await categoryHeader.hover();
      await categoryHeader.getByRole('button', { name: 'カテゴリーメニュー', exact: true }).click();
      await page.getByRole('menuitem', { name: 'アクティビティを追加', exact: true }).click();
      const activityDialog = page.getByRole('dialog', {
        name: '新しいアクティビティを作成',
        exact: true,
      });
      await activityDialog
        .getByRole('textbox', { name: 'アクティビティ名', exact: true })
        .fill(activityName);
      await expect(
        activityDialog.getByRole('radio', { name: categoryName, exact: true }),
      ).toHaveAttribute('aria-checked', 'true');
      await activityDialog.getByRole('button', { name: '作成', exact: true }).click();
      await expect(activityDialog).toBeHidden();
      await page.reload();
      await expect(page.getByRole('button', { name: activityName, exact: true })).toBeVisible();
      const category = await adminSupabase
        .from('categories')
        .select('id')
        .eq('user_id', IDENTITY.userId)
        .eq('name', categoryName)
        .single();
      const activity = await adminSupabase
        .from('activities')
        .select('id,category_id')
        .eq('user_id', IDENTITY.userId)
        .eq('name', activityName)
        .single();
      expect(category.error === null && activity.error === null).toBe(true);
      expect(activity.data?.category_id).toBe(category.data?.id);
      expect(category.data?.id).toBeDefined();
      const categoryId = category.data!.id;
      const activityId = activity.data!.id;
      // Rename keeps the same category and the existing membership.
      await categoryHeader.hover();
      await categoryHeader.getByRole('button', { name: 'カテゴリーメニュー', exact: true }).click();
      await page.getByRole('menuitem', { name: '名前を変更', exact: true }).click();
      const rename = page.getByRole('dialog', { name: '名前を変更', exact: true });
      const renamedCategory = `${categoryName} edited`;
      await rename.getByRole('textbox', { name: '名前', exact: true }).fill(renamedCategory);
      await rename.getByRole('button', { name: '保存', exact: true }).click();
      await expect(rename).toBeHidden();
      await page.reload();
      categoryHeader = page.getByText(renamedCategory, { exact: true }).locator('..');
      await expect(categoryHeader).toBeVisible();
      const renamedCategoryRow = await adminSupabase
        .from('categories')
        .select('name')
        .eq('user_id', IDENTITY.userId)
        .eq('id', categoryId)
        .single();
      expect(renamedCategoryRow.error === null).toBe(true);
      expect(renamedCategoryRow.data?.name).toBe(renamedCategory);
      const memberRow = page
        .getByRole('listitem')
        .filter({ has: page.getByRole('button', { name: activityName, exact: true }) });
      await memberRow.hover();
      await memberRow.getByRole('button', { name: 'アクティビティメニュー', exact: true }).click();
      await page.getByRole('menuitem', { name: 'カテゴリーを変更', exact: true }).hover();
      await page.getByRole('menuitem', { name: 'カテゴリーなし', exact: true }).click();
      await expect
        .poll(async () => {
          const result = await adminSupabase
            .from('activities')
            .select('category_id')
            .eq('user_id', IDENTITY.userId)
            .eq('id', activityId)
            .single();
          expect(result.error === null).toBe(true);
          return result.data?.category_id;
        })
        .toBeNull();
      await memberRow.hover();
      await memberRow.getByRole('button', { name: 'アクティビティメニュー', exact: true }).click();
      await page.getByRole('menuitem', { name: 'カテゴリーを変更', exact: true }).hover();
      await page.getByRole('menuitem', { name: renamedCategory, exact: true }).click();
      await expect
        .poll(async () => {
          const result = await adminSupabase
            .from('activities')
            .select('category_id')
            .eq('user_id', IDENTITY.userId)
            .eq('id', activityId)
            .single();
          expect(result.error === null).toBe(true);
          return result.data?.category_id;
        })
        .toBe(categoryId);

      await categoryHeader.hover();
      await categoryHeader.getByRole('button', { name: 'カテゴリーメニュー', exact: true }).click();
      await page.getByRole('menuitem', { name: 'カラーを変更', exact: true }).hover();
      await page.getByRole('menuitem', { name: '赤', exact: true }).click();
      await expect
        .poll(async () => {
          const result = await adminSupabase
            .from('categories')
            .select('color')
            .eq('user_id', IDENTITY.userId)
            .eq('id', categoryId)
            .single();
          expect(result.error === null).toBe(true);
          return result.data?.color;
        })
        .toBe('red');
      await categoryHeader.hover();
      await categoryHeader.getByRole('button', { name: 'カテゴリーメニュー', exact: true }).click();
      await page.getByRole('menuitem', { name: 'アイコンを変更', exact: true }).hover();
      await page.getByRole('menuitem', { name: 'briefcase', exact: true }).click();
      await expect
        .poll(async () => {
          const result = await adminSupabase
            .from('categories')
            .select('icon')
            .eq('user_id', IDENTITY.userId)
            .eq('id', categoryId)
            .single();
          expect(result.error === null).toBe(true);
          return result.data?.icon;
        })
        .toBe('briefcase');
      await categoryHeader.hover();
      await categoryHeader.getByRole('button', { name: 'カテゴリーメニュー', exact: true }).click();
      await page.getByRole('menuitem', { name: 'アーカイブ', exact: true }).click();
      await expect
        .poll(async () => {
          const result = await adminSupabase
            .from('categories')
            .select('archived_at')
            .eq('user_id', IDENTITY.userId)
            .eq('id', categoryId)
            .single();
          expect(result.error === null).toBe(true);
          return result.data?.archived_at != null;
        })
        .toBe(true);
      const retainedMember = await adminSupabase
        .from('activities')
        .select('category_id,archived_at')
        .eq('user_id', IDENTITY.userId)
        .eq('id', activityId)
        .single();
      expect(retainedMember.error === null).toBe(true);
      expect(retainedMember.data).toEqual({ category_id: categoryId, archived_at: null });
      await page.getByRole('button', { name: 'フィルター', exact: true }).click();
      await page.getByRole('menuitem', { name: /ステータス/ }).hover();
      await page.getByRole('menuitemradio', { name: 'すべて', exact: true }).click();
      const archivedCategory = page
        .getByRole('listitem')
        .filter({ has: page.getByText(renamedCategory, { exact: true }) });
      await expect(archivedCategory).toHaveCount(1);
      await archivedCategory.hover();
      await archivedCategory
        .getByRole('button', { name: 'カテゴリーメニュー', exact: true })
        .click();
      await page.getByRole('menuitem', { name: '復元', exact: true }).click();
      await expect
        .poll(async () => {
          const result = await adminSupabase
            .from('categories')
            .select('archived_at,color,icon')
            .eq('user_id', IDENTITY.userId)
            .eq('id', categoryId)
            .single();
          expect(result.error === null).toBe(true);
          expect(result.data?.color).toBe('red');
          expect(result.data?.icon).toBe('briefcase');
          return result.data?.archived_at;
        })
        .toBeNull();
      await page.reload();
      await expect(categoryHeader).toBeVisible();
      await categoryHeader.hover();
      await categoryHeader.getByRole('button', { name: 'カテゴリーメニュー', exact: true }).click();
      await page.getByRole('menuitem', { name: '削除', exact: true }).click();
      const confirmation = page.getByRole('alertdialog');
      await expect(confirmation).toContainText('未分類');
      await confirmation.getByRole('button', { name: '削除', exact: true }).click();
      await expect(confirmation).toBeHidden();
      await expect
        .poll(async () => {
          const result = await adminSupabase
            .from('activities')
            .select('category_id')
            .eq('user_id', IDENTITY.userId)
            .eq('id', activityId)
            .single();
          expect(result.error === null).toBe(true);
          return result.data?.category_id;
        })
        .toBeNull();
      const deleted = await adminSupabase
        .from('categories')
        .select('id')
        .eq('user_id', IDENTITY.userId)
        .eq('id', categoryId);
      expect(deleted.error === null).toBe(true);
      expect(deleted.data).toEqual([]);
      await page.reload();
      await expect(page.getByText(renamedCategory, { exact: true })).toHaveCount(0);
      const row = page
        .getByRole('listitem')
        .filter({ has: page.getByRole('button', { name: activityName, exact: true }) });
      await expect(row).toHaveCount(1);
      await row.hover();
      await row.getByRole('button', { name: 'アクティビティメニュー', exact: true }).click();
      await page.getByRole('menuitem', { name: '削除', exact: true }).click();
      await confirmation.getByRole('button', { name: '削除', exact: true }).click();
      await expect(confirmation).toBeHidden();
      await page.reload();
      await expect(page.getByRole('button', { name: activityName, exact: true })).toHaveCount(0);
      const deletedActivity = await adminSupabase
        .from('activities')
        .select('id')
        .eq('user_id', IDENTITY.userId)
        .eq('id', activityId);
      expect(deletedActivity.error === null).toBe(true);
      expect(deletedActivity.data).toEqual([]);
    });
  });
});
