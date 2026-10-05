import { expect, type Page } from '@playwright/test';

import { resolveIsolatedServiceRoleTarget } from '../isolated-service-role-target';
import { cleanupIsolatedTestUser } from '../isolated-user-cleanup';
import { assertServiceRoleSuiteRunnable } from '../service-role-target-guard';
import { createScopedTestUser, type ScopedTestUser } from './create-scoped-test-user';
import {
  createAdminSupabase,
  offsetDateParam,
  openDay,
  revealHour,
  type AdminSupabase,
} from './critical-path-fixture';
import { test } from './isolated-product-fixture';
import { suppressConsentBanner } from './suppress-consent-banner';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
const target = resolveIsolatedServiceRoleTarget(url, key);
assertServiceRoleSuiteRunnable(target, 'Isolated Record lifecycle');
const describeWithEnv = target.safe ? test.describe : test.describe.skip;
const pastDate = offsetDateParam(-14);
const isoAt = (time: string) => new Date(`${pastDate}T${time}:00+09:00`).toISOString();

describeWithEnv('Isolated Record lifecycle', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ timezoneId: 'Asia/Tokyo' });
  let admin: AdminSupabase;
  let user: ScopedTestUser;
  let activityId: string;
  let activityName: string;
  let replacementActivityId: string;
  let replacementActivityName: string;
  let recordId: string;
  let originalPlans: unknown;

  const readRecord = async () => {
    const result = await admin
      .from('records')
      .select('id,user_id,activity_id,note,start_at,end_at,fulfillment,deleted_at')
      .eq('user_id', user.userId)
      .eq('id', recordId)
      .single();
    expect(result.error).toBeNull();
    return result.data!;
  };
  const readPlans = async () => {
    const result = await admin.from('plans').select('*').eq('user_id', user.userId).order('id');
    expect(result.error).toBeNull();
    return result.data;
  };
  const openRecord = async (page: Page) => {
    const timeblockParam = `record:${recordId}`;
    if (new URL(page.url()).searchParams.get('timeblock') !== timeblockParam) {
      await page.locator(`[data-record-lane-card][data-timeblock-id="${recordId}"]`).click();
    }
    await expect(page.getByRole('textbox', { name: 'メモ', exact: true })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get('timeblock')).toBe(timeblockParam);
  };
  const setTime = async (page: Page, name: string, value: string) => {
    const input = page.getByRole('combobox', { name, exact: true });
    await input.fill(value);
    await input.press('Enter');
  };

  test.beforeAll(async () => {
    admin = createAdminSupabase(url!, key!);
    user = await createScopedTestUser(url!, key!, 'record-lifecycle');
    activityName = `Record lifecycle ${user.userId.slice(0, 8)}`;
    const settings = await admin.from('user_settings').upsert({
      user_id: user.userId,
      timezone: 'Asia/Tokyo',
      preferred_locale: 'ja',
      time_format: '24h',
      default_view: 'day',
    });
    expect(settings.error).toBeNull();
    const activity = await admin
      .from('activities')
      .insert({ user_id: user.userId, name: activityName })
      .select('id')
      .single();
    expect(activity.error).toBeNull();
    activityId = activity.data!.id;
    replacementActivityName = `Replacement ${user.userId.slice(0, 8)}`;
    const replacement = await admin
      .from('activities')
      .insert({ user_id: user.userId, name: replacementActivityName })
      .select('id')
      .single();
    expect(replacement.error).toBeNull();
    replacementActivityId = replacement.data!.id;
    const plan = await admin.from('plans').insert({
      user_id: user.userId,
      activity_id: activityId,
      title: 'Unchanged independent Plan',
      start_at: isoAt('09:00'),
      end_at: isoAt('10:00'),
    });
    expect(plan.error).toBeNull();
    originalPlans = await readPlans();
  });
  test.afterAll(async () => {
    if (user) await cleanupIsolatedTestUser(admin, url!, key!, user);
  });
  test.beforeEach(async ({ page }) => {
    const removed = await admin.from('records').delete().eq('user_id', user.userId);
    expect(removed.error).toBeNull();
    const record = await admin
      .from('records')
      .insert({
        user_id: user.userId,
        activity_id: activityId,
        title: 'Record lifecycle source',
        note: 'Original note',
        start_at: isoAt('09:00'),
        end_at: isoAt('10:00'),
      })
      .select('id')
      .single();
    expect(record.error).toBeNull();
    recordId = record.data!.id;
    await suppressConsentBanner(page);
    await page.goto('/ja/auth/login');
    await page.locator('input[type="email"]').first().fill(user.email);
    await page.locator('input[type="password"]').first().fill(user.password);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL(/\/ja\/?(?:\?.*)?$/i, { timeout: 15_000 });
    await openDay(page, pastDate);
    await revealHour(page, 9);
    await expect(page.locator('[data-record-lane-card]')).toHaveCount(1);
  });
  test.afterEach(async () => expect(await readPlans()).toEqual(originalPlans));

  test('Record Inspector edits persist on the same ID without editing its independent Plan', async ({
    page,
  }) => {
    await openRecord(page);
    const note = page.getByRole('textbox', { name: 'メモ', exact: true });
    await note.fill('Edited Record note');
    await note.blur();
    await expect.poll(async () => (await readRecord()).note).toBe('Edited Record note');
    await setTime(page, '終了時刻', '10:30');
    await expect
      .poll(async () => new Date((await readRecord()).end_at).toISOString())
      .toBe(isoAt('10:30'));
    await page.getByRole('button', { name: '充実', exact: true }).click();
    await expect.poll(async () => (await readRecord()).fulfillment).toBe('high');
    await page
      .getByRole('button', { name: new RegExp(`^アクティビティを変更: ${activityName}$`) })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: replacementActivityName, exact: true })
      .click();
    await expect.poll(async () => (await readRecord()).activity_id).toBe(replacementActivityId);
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'メモ', exact: true })).toHaveValue(
      'Edited Record note',
    );
    await expect(page.getByRole('combobox', { name: '終了時刻', exact: true })).toHaveValue(
      '10:30',
    );
    await expect(page.getByRole('button', { name: '充実', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(
      page.getByRole('button', {
        name: new RegExp(`^アクティビティを変更: ${replacementActivityName}$`),
      }),
    ).toBeVisible();
    const rows = await admin
      .from('records')
      .select('id')
      .eq('user_id', user.userId)
      .is('deleted_at', null);
    expect(rows.error).toBeNull();
    expect(rows.data).toEqual([{ id: recordId }]);
  });

  test('Record bottom resize saves a 90 minute duration and survives reload', async ({ page }) => {
    const { hourHeight } = await revealHour(page, 9);
    const handle = page.locator('[data-record-lane-card] [data-resize-handle="bottom"]').first();
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 8, { steps: 4 });
    await page.mouse.move(x, y + hourHeight / 2, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(async () => new Date((await readRecord()).end_at).toISOString())
      .toBe(isoAt('10:30'));
    expect(new Date((await readRecord()).start_at).toISOString()).toBe(isoAt('09:00'));
    await expect.poll(() => new URL(page.url()).searchParams.get('timeblock')).toBeNull();
    await page.reload();
    await revealHour(page, 9);
    await openRecord(page);
    await expect(page.getByRole('combobox', { name: '終了時刻', exact: true })).toHaveValue(
      '10:30',
    );
  });

  test('Record duplicate requires a nonoverlapping time and creates an independent ID', async ({
    page,
  }) => {
    const original = await readRecord();
    await openRecord(page);
    await page.getByRole('button', { name: 'その他の操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '複製', exact: true }).click();
    const create = page.getByRole('button', { name: '複製を作成', exact: true });
    await expect(create).toBeEnabled();
    await create.click();
    await expect(page.getByText('この時間帯には既に記録があります', { exact: true })).toBeVisible();
    await expect(create).toBeDisabled();
    await setTime(page, '終了時刻', '12:00');
    await setTime(page, '開始時刻', '11:00');
    await expect(create).toBeEnabled();
    await create.click();
    await expect
      .poll(async () => {
        const result = await admin
          .from('records')
          .select('id')
          .eq('user_id', user.userId)
          .is('deleted_at', null);
        expect(result.error).toBeNull();
        return result.data?.length;
      })
      .toBe(2);
    const result = await admin
      .from('records')
      .select('id,activity_id,note,start_at,end_at')
      .eq('user_id', user.userId)
      .neq('id', recordId)
      .single();
    expect(result.error).toBeNull();
    expect(result.data!.id).not.toBe(recordId);
    expect(result.data!.activity_id).toBe(activityId);
    expect(result.data!.note).toBe('Original note');
    expect(new Date(result.data!.start_at).toISOString()).toBe(isoAt('11:00'));
    expect(new Date(result.data!.end_at).toISOString()).toBe(isoAt('12:00'));
    expect(await readRecord()).toEqual(original);
    await page.reload();
    await revealHour(page, 9);
    await expect(page.locator('[data-record-lane-card]')).toHaveCount(2);
  });

  test('Record deletion hides the persisted row and Undo restores the same ID and content', async ({
    page,
  }) => {
    const original = await readRecord();
    await openRecord(page);
    await page.getByRole('button', { name: 'その他の操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '削除', exact: true }).click();
    await expect.poll(async () => (await readRecord()).deleted_at).not.toBeNull();
    await expect(page.locator('[data-record-lane-card]')).toHaveCount(0);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect.poll(readRecord).toEqual(original);
    await expect(page.locator('[data-record-lane-card]')).toHaveCount(1);
    await page.reload();
    await revealHour(page, 9);
    await openRecord(page);
    await expect(page.getByRole('textbox', { name: 'メモ', exact: true })).toHaveValue(
      'Original note',
    );
  });
});
