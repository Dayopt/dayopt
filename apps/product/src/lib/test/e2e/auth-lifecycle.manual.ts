import { expect } from '@playwright/test';

import {
  assertServiceRoleSuiteRunnable,
  resolveServiceRoleTarget,
} from '../service-role-target-guard';
import {
  cleanupCriticalPathUser,
  createAdminSupabase,
  createCriticalPathIdentity,
  loginAs,
  seedCriticalPathUser,
  type AdminSupabase,
} from './critical-path-fixture';
import { test } from './preview-access-fixture';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;
const target = resolveServiceRoleTarget(SUPABASE_URL, KEY);
assertServiceRoleSuiteRunnable(target, 'Auth credential lifecycle');
const IDENTITY = createCriticalPathIdentity('auth-lifecycle');

// Separate from the mandatory Preview critical path: HIBP and notification delivery
// require a reviewed provider policy and sink. No skipped suite claims this was run.
test.describe('Auth credential lifecycle (explicit local prerequisite)', () => {
  let adminSupabase: AdminSupabase;
  test.beforeAll(async ({ browserName }, testInfo) => {
    const host = target.safe ? new URL(SUPABASE_URL!).hostname : '';
    const appHost = testInfo.project.use.baseURL
      ? new URL(testInfo.project.use.baseURL).hostname
      : '';
    if (
      browserName !== 'chromium' ||
      !target.safe ||
      !['localhost', '127.0.0.1', '[::1]'].includes(host) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(appHost) ||
      Boolean(process.env.E2E_PREVIEW_ORIGIN) ||
      process.env.E2E_AUTH_NOTIFICATION_SINK_READY !== '1' ||
      process.env.E2E_AUTH_LIFECYCLE_APPROVED !== '1'
    ) {
      throw new Error(
        'Auth lifecycle requires an explicitly approved local nonproduction target and notification sink',
      );
    }
    adminSupabase = createAdminSupabase(SUPABASE_URL!, KEY!);
    await seedCriticalPathUser(adminSupabase, IDENTITY, 'auth lifecycle e2e');
  });
  test.afterAll(async () => {
    if (adminSupabase) await cleanupCriticalPathUser(adminSupabase, IDENTITY.userId);
  });
  test.beforeEach(async ({ page }, testInfo) => {
    if (testInfo.project.name !== 'chromium')
      throw new Error('Auth lifecycle requires the desktop project');
    await loginAs(page, IDENTITY);
  });
  // This standalone case changes only its own synthetic account credential.
  // Real execution requires the current-password policy, a nonproduction notification
  // sink, and reviewed HIBP range access; rendering a success page alone is not proof.
  test('パスワード変更で現在パスワードを検証し、旧認証を拒否・新認証で再ログインできる', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const newPassword = `E2e-${crypto.randomUUID()}`;
    await page.goto('/ja/settings/account');
    await page.getByRole('button', { name: 'パスワード', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'パスワード', exact: true });
    await dialog
      .getByLabel('現在のパスワード', { exact: true })
      .fill(`Wrong-${crypto.randomUUID()}`);
    await dialog.getByLabel('新しいパスワード', { exact: true }).fill(newPassword);
    await dialog.getByLabel('新しいパスワード（確認）', { exact: true }).fill(newPassword);
    await dialog.getByRole('button', { name: 'パスワードを更新', exact: true }).click();
    await expect(dialog.locator('#password-change-error')).toHaveText(
      '現在のパスワードが正しくありません',
    );
    await dialog.getByLabel('現在のパスワード', { exact: true }).fill(IDENTITY.password);
    await dialog.getByRole('button', { name: 'パスワードを更新', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '閉じる', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'サインアウト', exact: true }).click();
    await expect(page).toHaveURL(/\/ja\/auth\/login/);
    await page.goto('/ja');
    await expect(page).toHaveURL(/\/ja\/auth\/login/);
    // The stale password must actually reach GoTrue and be rejected.
    await page.locator('input[type="email"]').fill(IDENTITY.email);
    await page.locator('input[type="password"]').fill(IDENTITY.password);
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('[role="alert"][data-slot="field-error"]')).toContainText(
      'メールアドレスまたはパスワードが正しくありません',
    );
    await expect(page).toHaveURL(/\/auth\/login/);
    await page.locator('input[type="password"]').fill(newPassword);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/ja\/?(?:\?|$)/);
    await expect(page.locator('[data-calendar-grid]').first()).toBeVisible();
    const authenticated = await adminSupabase.auth.admin.getUserById(IDENTITY.userId);
    expect(authenticated.error === null).toBe(true);
    expect(authenticated.data.user?.email).toBe(IDENTITY.email);
    await page.goto('/ja/settings/account');
    await page.getByRole('button', { name: 'サインアウト', exact: true }).click();
    await expect(page).toHaveURL(/\/ja\/auth\/login/);
    await page.goto('/ja/settings/account');
    await expect(page).toHaveURL(/\/ja\/auth\/login/);
  });
});
