import { expect, test } from '@playwright/test';

test('theme menu changes dark and light appearance and persists on reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Necessary only' }).click();
  await page.getByRole('button', { name: 'Change theme' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('class', /dark/);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('class', /dark/);
  await page.getByRole('button', { name: 'Change theme' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Light' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('class', /dark/);
});

test('header navigation opens blog through mobile drawer or desktop link @mobile', async ({
  page,
}) => {
  await page.goto('/');
  const mobile = await page.evaluate(() => innerWidth < 1024);
  if (mobile) {
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.getByRole('dialog', { name: 'Navigation menu' })).toBeVisible();
    await page
      .getByRole('dialog', { name: 'Navigation menu' })
      .getByRole('link', { name: 'Blog' })
      .click();
    await expect(page.getByRole('dialog', { name: 'Navigation menu' })).not.toBeVisible();
  } else {
    await page.locator('header').getByRole('link', { name: 'Blog' }).click();
  }
  await expect(page).toHaveURL(/\/blog\/?$/);
  await expect(page.locator('article').first()).toBeVisible();
});

test('FAQ disclosure exposes and collapses its answer', async ({ page }) => {
  await page.goto('/');
  const question = page.locator('#faq details').first();
  await expect(question).not.toHaveAttribute('open', '');
  await page.locator('#faq details summary').first().click();
  await expect(question).toHaveAttribute('open', '');
  await expect(page.locator('#faq details p').first()).toBeVisible();
  await page.locator('#faq details summary').first().click();
  await expect(question).not.toHaveAttribute('open', '');
});

for (const category of ['guide', 'philosophy', 'release', 'devlog']) {
  test(`blog category ${category} activates its tab and returns to all articles`, async ({
    page,
  }) => {
    await page.goto('/blog');
    await page.locator(`main nav[aria-label="Blog"] a[href="/blog/${category}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/blog/${category}/?$`));
    await expect(
      page.locator(`main nav[aria-label="Blog"] a[href="/blog/${category}"]`),
    ).toHaveAttribute('aria-current', 'page');
    await page.locator('main nav a[href="/blog"]').click();
    await expect(page).toHaveURL(/\/blog\/?$/);
    await expect(page.locator('article').first()).toBeVisible();
  });
}

test('docs keyboard search submits to site search and returns a result', async ({ page }) => {
  await page.goto('/docs');
  await expect(page.getByRole('button', { name: 'English - Change language' })).toBeEnabled();
  await page.keyboard.press('Meta+k');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('textbox').fill('calendar');
  await page.getByRole('dialog').getByRole('textbox').press('Enter');
  await expect(page).toHaveURL(/\/search\?q=calendar/);
  await expect(page.locator('main a[href*="/docs/"]').first()).toBeVisible();
});

test('blog pagination changes articles and filtering from page two finds the first article', async ({
  page,
}) => {
  await page.goto('/blog');
  const firstTitle = await page.locator('article h2').first().textContent();
  expect(firstTitle).toBeTruthy();
  await page.locator('main a[href="/blog?page=2"]').first().click();
  await expect(page).toHaveURL(/\/blog\?page=2/);
  await expect(page.locator('article h2').first()).not.toHaveText(firstTitle!);
  await page.getByRole('searchbox').fill(firstTitle!);
  await expect(page.locator('article h2').first()).toHaveText(firstTitle!);
});
