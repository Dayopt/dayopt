import { dayoptProductUrls } from '@dayopt/config';
import { expect, test } from '@playwright/test';

test('footer の言語切替で locale prefix と hero copy が切り替わる', async ({ page }) => {
  await page.goto('/');

  const hero = page.getByRole('heading', { level: 1 });
  await expect(hero).toContainText('Plan days you can actually keep.');

  await page.getByRole('button', { name: 'English - Change language' }).click();
  await page.getByRole('menuitemcheckbox', { name: '日本語' }).click();

  await expect(page).toHaveURL(/\/ja\/?$/);
  await expect(hero).toContainText('守れる計画を、立てられるように。');

  await page.getByRole('button', { name: '日本語 - Change language' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'English' }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page).not.toHaveURL(/\/ja\/?$/);
  await expect(hero).toContainText('Plan days you can actually keep.');
});

test('登録 CTA が product signup に統一されている', async ({ page }) => {
  await page.goto('/');

  const signupHrefs = await page
    .locator('a')
    .evaluateAll((links) =>
      links
        .map((link) => link.getAttribute('href'))
        .filter((href): href is string => href?.endsWith('/signup') ?? false),
    );

  expect(signupHrefs.length).toBeGreaterThan(0);
  expect(signupHrefs.every((href) => href === dayoptProductUrls.signup)).toBe(true);
});

test('LP metadata と OG image が新コピーに整合する', async ({ page }) => {
  const title = 'Plan days you can actually keep.';
  const description =
    'Your plan and what actually happened, in one timeline. See where they drift — and get better at planning. The lightest timeboxing tool for knowledge workers.';

  await page.goto('/');

  await expect(page).toHaveTitle(`${title} | Dayopt`);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', description);

  const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content');
  expect(ogImage).not.toBeNull();

  const ogUrl = new URL(ogImage as string);
  expect(ogUrl.pathname).toBe('/api/og');
  expect(ogUrl.searchParams.get('title')).toBe(title);
  expect(ogUrl.searchParams.get('description')).toBe(description);

  const response = await page.request.get(`/api/og?${ogUrl.searchParams.toString()}`);
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toContain('image/png');
});
