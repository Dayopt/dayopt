import { expect, test } from '@playwright/test';

import { resolveServiceRoleTarget } from '../service-role-target-guard';
import {
  createScopedTestUser,
  deleteScopedTestUser,
  type ScopedTestUser,
} from './create-scoped-test-user';

/**
 * 認証フロー E2E テスト
 *
 * E2E の責務は「ページが route として配信され、認証の配線が通ること」に限定する。
 * フォーム部品の描画・入力・トグル・バリデーションは component test が正:
 * - features/auth/components/__tests__/LoginForm.test.tsx
 * - features/auth/components/__tests__/SignupForm.test.tsx
 * - features/auth/components/__tests__/PasswordResetForm.test.tsx
 * 未認証リダイレクトとログイン導線の重複は smoke.spec.ts が正。
 *
 * MFA（TOTP）/ リカバリーコードのログイン経路は E2E では持たない（#1873 の判断）:
 * - AAL2 昇格の分岐・redirect は LoginForm.test.tsx / proxy の unit test がモックで検証済み、
 *   recovery code の crypto / DB 層は unit + integration（rls-access.integration.test.ts）が正
 * - Supabase Admin API に MFA enroll のショートカットが無く事前 seed 不可、TOTP 生成の
 *   新規依存と 30 秒ウィンドウの clock skew が恒常的 flaky 要因になり、E2E 化のコストが
 *   検証価値（残 gap は実 Cookie 経由の AAL2 受け渡しのみ）に見合わない
 * - 手薄なのは client UI 層の component test（useMFA / MFAVerifyForm / MFASection）で、
 *   これは本コメント冒頭の原則どおり component test の領域（別 issue で追跡）
 *
 * @see Storybook → Features/Auth/* でUI詳細を確認
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY;
const SERVICE_ROLE_TARGET = resolveServiceRoleTarget(SUPABASE_URL, SERVICE_ROLE_KEY);

let testUser: ScopedTestUser | undefined;

// ─────────────────────────────────────────────────────────
// ページ配信（未認証で実行可能、CI で常時走る層）
// ─────────────────────────────────────────────────────────

test.describe('Auth: ページ配信', () => {
  test('サインアップページがフォームと規約・ログイン導線を配信する', async ({ page }) => {
    await page.goto('/auth/signup');

    await expect(page.locator('input[type="email"], input[name="email"]').first()).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator('input[type="password"]').first()).toBeVisible();
    await expect(page.locator('button[type="submit"]').first()).toBeVisible();
    await expect(
      page.locator('[role="checkbox"], a[href*="terms"], [data-testid="terms"]').first(),
    ).toBeVisible();
    await expect(page.locator('a[href*="login"]').first()).toBeVisible();
  });

  test('ログインページがフォームとリセット・サインアップ導線を配信する', async ({ page }) => {
    await page.goto('/auth/login');

    await expect(page.locator('input[type="email"], input[name="email"]').first()).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator('input[type="password"]').first()).toBeVisible();
    await expect(page.locator('button[type="submit"]').first()).toBeVisible();
    await expect(
      page.locator('a[href*="password"], a[href*="reset"], a[href*="forgot"]').first(),
    ).toBeVisible();
    await expect(page.locator('a[href*="signup"]').first()).toBeVisible();
  });

  test('パスワードリセットページがフォームと戻る導線を配信する', async ({ page }) => {
    await page.goto('/auth/password');

    await expect(page.locator('input[type="email"], input[name="email"]').first()).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator('button[type="submit"]').first()).toBeVisible();
    await expect(page.locator('a[href*="login"]').first()).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────
// 実 Supabase を通す認証フロー（TEST_USER が必要、ローカル実行）
// ─────────────────────────────────────────────────────────

test.describe('Auth: 認証フロー', () => {
  test.skip(!SERVICE_ROLE_TARGET.safe, SERVICE_ROLE_TARGET.safe ? '' : SERVICE_ROLE_TARGET.reason);

  test.beforeAll(async () => {
    if (!SERVICE_ROLE_TARGET.safe) return;
    testUser = await createScopedTestUser(SUPABASE_URL!, SERVICE_ROLE_KEY!, 'auth');
  });

  test.afterAll(async () => {
    if (!testUser) return;
    await deleteScopedTestUser(SUPABASE_URL!, SERVICE_ROLE_KEY!, testUser.userId);
  });

  test('正しい認証情報でログインしカレンダーへ遷移する', async ({ page }) => {
    await page.goto('/auth/login');

    await page.locator('input[type="email"], input[name="email"]').first().fill(testUser!.email);
    await page.locator('input[type="password"]').first().fill(testUser!.password);
    await page.locator('button[type="submit"]').first().click();

    await page.waitForURL(/\/calendar/i, { timeout: 15000 });
    await expect(page).toHaveTitle(/Dayopt/);
  });

  test('誤った認証情報でエラー表示', async ({ page }) => {
    await page.goto('/ja/auth/login');

    await page
      .locator('input[type="email"], input[name="email"]')
      .first()
      .fill('wrong@example.com');
    await page.locator('input[type="password"]').first().fill('WrongPassword123');
    await page.locator('button[type="submit"]').first().click();

    // エラーメッセージが表示される（ユーザー列挙を防ぐ汎用メッセージ）。
    //
    // 待つ対象はサーバーエラーの FieldError と invalidCredentials の文言に限定する。
    // `.text-destructive` を含む複合 locator では、必須ラベルの「＊」マーカー
    // （field.tsx が required に付ける）が送信前から可視なため即座に一致してしまい、
    // 認証エラーが実際には出ていない regression でもテストが green になる
    // （account-deletion.spec.ts の再ログイン検証と同型の偽陽性、#1883）。
    // role="alert" が付くのは announceImmediately の FieldError（= サーバーエラー）
    // だけだが、Next.js の route announcer も role="alert" を持つため
    // data-slot でさらに絞る。
    await expect(page.locator('[role="alert"][data-slot="field-error"]')).toContainText(
      'メールアドレスまたはパスワードが正しくありません',
      { timeout: 10000 },
    );
    // 認証が通っていないこと自体も確認する（成功していれば /calendar へ抜ける）
    await expect(page).toHaveURL(/\/auth\/login/);
  });
});
