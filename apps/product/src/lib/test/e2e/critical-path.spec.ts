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

test.use({ trpcProcedureBudget: 26 });

/**
 * クリティカルパス E2E（desktop）— 計画 → 実績の中核ループを実 UI 操作で通す
 *
 * 「作成導線が存在する」ではなく、ドラッグ選択 → アクティビティ選択で実際に Plan / Record を作り、
 * リロード後も残る（= DB へ永続化された）ことを検証する。
 * mobile の同じループは mobile-critical-path.spec.ts（長押し → Drawer）。
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
assertServiceRoleSuiteRunnable(SERVICE_ROLE_TARGET, 'Critical Path: 計画 → 実績');
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

describeWithEnv('Critical Path: 計画 → 実績', () => {
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
      await loginAs(page, IDENTITY, `/ja/?view=day&date=${RETURN_TARGET_DATE}`);
      return;
    }
    await loginAs(page, IDENTITY);
  });

  test('認証後の戻り先: 元の保護URLを開く', async ({ page }) => {
    const current = new URL(page.url());
    expect(current.pathname).toBe('/ja/');
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
    await expectIndependentPersistedHour(adminSupabase, IDENTITY.userId, 'plan', tomorrow, 9);

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
    await expectIndependentPersistedHour(adminSupabase, IDENTITY.userId, 'record', twoDaysAgo, 9);

    await deleteInspectorTimeblock(page, 'record');
    await expect(recordCard).toHaveCount(0, { timeout: 10_000 });
    await page.reload();
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible({ timeout: 10_000 });
    await expect(recordCard).toHaveCount(0);
    const deletedStart = new Date(`${twoDaysAgo}T09:00:00+09:00`).toISOString();
    const deletedRecord = await adminSupabase
      .from('records')
      .select('id,deleted_at')
      .eq('user_id', IDENTITY.userId)
      .eq('start_at', deletedStart);
    expect(deletedRecord.error === null).toBe(true);
    expect(deletedRecord.data).toHaveLength(1);
    expect(deletedRecord.data?.[0]?.deleted_at).not.toBeNull();
  });

  test('プロフィールと時間表示形式を変更すると所有者の設定へ保存される', async ({ page }) => {
    const displayName = `Profile ${IDENTITY.userId.slice(0, 8)}`;
    await page.goto('/ja/settings/account');
    await page.getByRole('button', { name: /表示名/ }).click();
    const dialog = page.getByRole('dialog', { name: '表示名', exact: true });
    await dialog.getByLabel('表示名', { exact: true }).fill(displayName);
    await dialog.getByRole('button', { name: '確認', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(async () => {
        const profile = await adminSupabase
          .from('profiles')
          .select('full_name')
          .eq('id', IDENTITY.userId)
          .single();
        expect(profile.error === null).toBe(true);
        return profile.data?.full_name;
      })
      .toBe(displayName);

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
  });

  test('テーマ・タイムゾーン・表示言語を変更して保存する', async ({ page }) => {
    await page.goto('/ja/settings/display');
    const theme = page.getByRole('combobox', { name: 'テーマ', exact: true });
    await theme.click();
    await page.getByRole('option', { name: 'ダーク', exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect
      .poll(async () => {
        const result = await adminSupabase
          .from('user_settings')
          .select('theme')
          .eq('user_id', IDENTITY.userId)
          .single();
        expect(result.error === null).toBe(true);
        return result.data?.theme;
      })
      .toBe('dark');
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.goto('/ja/settings/display');
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
    await expect(page).toHaveURL(/\/en\//);
    await expect
      .poll(async () => {
        const result = await adminSupabase
          .from('user_settings')
          .select('preferred_locale')
          .eq('user_id', IDENTITY.userId)
          .single();
        return result.error === null ? result.data?.preferred_locale : null;
      })
      .toBe('en');
    await page.getByRole('combobox', { name: 'Language', exact: true }).click();
    await page.getByRole('option', { name: '日本語', exact: true }).click();
    await expect(page).toHaveURL(/\/ja\//);
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

  test('JSON と期間指定 CSV の出力が自分の Plan / Record と一致する', async ({ page }) => {
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
    expect(backup.data.plans.map((row: { id: string }) => row.id).sort()).toEqual(
      plans.data!.map((row) => row.id).sort(),
    );
    expect(backup.data.records.map((row: { id: string }) => row.id).sort()).toEqual(
      records.data!.map((row) => row.id).sort(),
    );

    await page.getByRole('combobox', { name: '形式', exact: true }).click();
    await page.getByRole('option', { name: 'CSV（スプレッドシート用）', exact: true }).click();
    await page.getByRole('combobox', { name: '範囲', exact: true }).click();
    await page.getByRole('option', { name: '期間指定', exact: true }).click();
    const yesterday = offsetDateParam(-1);
    await page.getByLabel('開始日', { exact: true }).fill(yesterday);
    await page.getByLabel('終了日', { exact: true }).fill(yesterday);
    const csv = await downloadText();
    expect(csv.name).toMatch(/\.csv$/);
    const rows = csv.text.trim().split('\n');
    expect(rows[0]).toBe(
      'kind,id,title,note,activity_id,start_at,end_at,source,fulfillment,created_at,updated_at,deleted_at',
    );
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows.slice(1)) expect(row).toContain(`${yesterday}T`);
    const dateKey = (value: string) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(value));
    const expectedIds = [...backup.data.plans, ...backup.data.records]
      .filter((row: { start_at: string }) => dateKey(row.start_at) === yesterday)
      .map((row: { id: string }) => row.id)
      .sort();
    expect(
      rows
        .slice(1)
        .map((row) => row.split(',')[1] ?? '')
        .sort(),
    ).toEqual(expectedIds);
  });

  test('アクティビティメニューから直近の記録詳細を開き記録へ移動できる', async ({ page }) => {
    await openDay(page, offsetDateParam(-1));
    const activityRow = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('button', { name: ACTIVITY_NAME, exact: true }) });
    await expect(activityRow).toHaveCount(1);
    await activityRow.hover();
    const menu = activityRow.getByRole('button', { name: 'アクティビティメニュー', exact: true });
    await menu.click();
    await page.getByRole('menuitem', { name: 'アクティビティの詳細', exact: true }).click();

    const summary = page.getByRole('region', { name: 'アクティビティの詳細' });
    await expect(summary).toBeVisible({ timeout: 10_000 });
    await expect(summary.getByRole('heading', { name: ACTIVITY_NAME })).toBeVisible();
    const records = await adminSupabase
      .from('records')
      .select('id')
      .eq('user_id', IDENTITY.userId)
      .is('deleted_at', null);
    expect(records.error === null).toBe(true);
    expect(records.data).toHaveLength(1);
    await expect(summary.getByRole('heading', { name: '記録（1件）', exact: true })).toBeVisible();
    const record = summary.getByRole('listitem').first().getByRole('button');
    await expect(record).toBeEnabled();
    await record.click();
    await expect(page.getByRole('region', { name: ACTIVITY_NAME })).toBeVisible({
      timeout: 10_000,
    });
  });
});
