import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { resolveServiceRoleTarget } from '../service-role-target-guard';
import {
  createScopedTestUser,
  deleteScopedTestUser,
  type ScopedTestUser,
} from './create-scoped-test-user';

/**
 * アクセシビリティテスト
 *
 * axe-coreを使って各ページのWCAG違反を検出する。
 * Storybook addon-a11yがコンポーネント単位をカバーし、
 * このテストはページ全体の構造的なa11y問題を検出する。
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY;
const SERVICE_ROLE_TARGET = resolveServiceRoleTarget(SUPABASE_URL, SERVICE_ROLE_KEY);

let testUser: ScopedTestUser | undefined;

/**
 * 共通ログインヘルパー
 */
async function loginAndNavigate(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  const passwordInput = page.locator('input[type="password"]').first();
  const submitButton = page.locator('button[type="submit"]').first();

  await emailInput.fill(testUser!.email);
  await passwordInput.fill(testUser!.password);
  await submitButton.click();

  await page.waitForURL(/\/calendar/i, { timeout: 15000 });
}

/**
 * axe-coreスキャン結果をフォーマットして返す
 */
function formatViolations(violations: import('axe-core').Result[]) {
  return violations
    .map((v) => {
      const nodes = v.nodes.map((n) => `    - ${n.html}`).join('\n');
      return `[${v.impact}] ${v.id}: ${v.description}\n  Help: ${v.helpUrl}\n  Nodes:\n${nodes}`;
    })
    .join('\n\n');
}

// ==========================================
// 未認証ページ
// ==========================================
test.describe('A11y: 未認証ページ', () => {
  test('ログインページ', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page: page as never })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations, formatViolations(results.violations)).toHaveLength(0);
  });
});

// ==========================================
// 認証済みページ
// ==========================================
test.describe('A11y: 認証済みページ', () => {
  test.skip(!SERVICE_ROLE_TARGET.safe, SERVICE_ROLE_TARGET.safe ? '' : SERVICE_ROLE_TARGET.reason);

  test.beforeAll(async () => {
    if (!SERVICE_ROLE_TARGET.safe) return;
    testUser = await createScopedTestUser(SUPABASE_URL!, SERVICE_ROLE_KEY!, 'a11y');
  });

  test.afterAll(async () => {
    if (!testUser) return;
    await deleteScopedTestUser(SUPABASE_URL!, SERVICE_ROLE_KEY!, testUser.userId);
  });

  test.beforeEach(async ({ page }) => {
    await loginAndNavigate(page);
  });

  test('カレンダーページ（デイビュー）', async ({ page }) => {
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page: page as never })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations, formatViolations(results.violations)).toHaveLength(0);
  });

  test('設定ページ', async ({ page }) => {
    await page.goto('/ja/settings/general');
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page: page as never })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations, formatViolations(results.violations)).toHaveLength(0);
  });

  test('統計ページ', async ({ page }) => {
    // /stats は現行 route に存在しない（main にも無い、本 PR 以前からの死亡 sub-test）。
    // 分析面は #2181 で /report へ移設されたため、現在地を指すよう追従する（Step 2 の
    // login 遷移先追従と同型。新設 /report が a11y 検査ゼロのまま出荷されるのを防ぐ）。
    await page.goto('/ja/report');
    await page.waitForLoadState('domcontentloaded');

    const results = await new AxeBuilder({ page: page as never })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations, formatViolations(results.violations)).toHaveLength(0);
  });
});
