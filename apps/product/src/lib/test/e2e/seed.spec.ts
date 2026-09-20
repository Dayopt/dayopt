import { expect, test } from '@playwright/test';

import { resolveServiceRoleTarget } from '../service-role-target-guard';
import {
  createScopedTestUser,
  deleteScopedTestUser,
  type ScopedTestUser,
} from './create-scoped-test-user';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY;
const SERVICE_ROLE_TARGET = resolveServiceRoleTarget(SUPABASE_URL, SERVICE_ROLE_KEY);

let testUser: ScopedTestUser | undefined;

test.beforeAll(async () => {
  if (!SERVICE_ROLE_TARGET.safe) return;
  testUser = await createScopedTestUser(SUPABASE_URL!, SERVICE_ROLE_KEY!, 'seed');
});

test.afterAll(async () => {
  if (!testUser) return;
  await deleteScopedTestUser(SUPABASE_URL!, SERVICE_ROLE_KEY!, testUser.userId);
});

test.describe('Playwright Test Agent seed', () => {
  test('authenticated Calendar session', async ({ page }) => {
    test.skip(
      !SERVICE_ROLE_TARGET.safe,
      SERVICE_ROLE_TARGET.safe ? '' : SERVICE_ROLE_TARGET.reason,
    );

    await page.goto('/ja/auth/login');
    await page.locator('input[name="email"]').fill(testUser!.email);
    await page.locator('input[name="password"]').fill(testUser!.password);
    await page.locator('button[type="submit"]').click();

    await page.waitForURL(/\/ja\/calendar/, { timeout: 15_000 });
    await expect(page.locator('[data-calendar-grid][data-calendar-day-index="0"]')).toBeVisible({
      timeout: 10_000,
    });
  });
});
