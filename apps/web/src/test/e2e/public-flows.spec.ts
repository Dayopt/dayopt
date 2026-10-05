import { expect, test } from './public-test';

for (const locale of ['', '/ja']) {
  const japanese = locale === '/ja';

  test(`${locale || 'en'}: landing demos create and reset visible plans @mobile`, async ({
    page,
  }) => {
    await page.goto(locale || '/');
    const calendar = page.locator('#calendar-preview');
    await calendar.getByRole('button', { name: japanese ? /予定を立てる/ : /Make a plan/ }).click();
    await expect(calendar).toContainText(japanese ? '記録はこれから' : 'No record yet');
    await calendar
      .getByRole('button', { name: japanese ? /明日へつなぐ/ : /Plan the next day/ })
      .click();
    await expect(calendar).toContainText(
      japanese ? '前日の記録 45分' : "Yesterday's record: 45 min",
    );
    const learning = page.locator('#learning');
    await learning
      .getByRole('button', { name: japanese ? /明日に並べてみる/ : /Arrange tomorrow/ })
      .click();
    await expect(learning).toContainText(japanese ? '3つの予定を追加' : 'Three plans added');
    await learning.getByRole('button', { name: japanese ? /操作例をリセット/ : /Reset/ }).click();
    await expect(learning).toContainText(japanese ? '予定を並べる前' : 'Before adding plans');
  });

  test(`${locale || 'en'}: docs navigation opens a getting-started article`, async ({ page }) => {
    await page.goto(locale || '/');
    await page.locator(`a[href="${locale}/docs/getting-started"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`${locale}/docs/?$`));
    await expect(page.locator('main')).toContainText(japanese ? 'Dayoptとは' : 'What is Dayopt?');
    const next = page.locator('main a[href*="/docs/"]').first();
    await expect(next).toBeVisible();
    await next.click();
    await expect(page).toHaveURL(/\/docs\/.+/);
    await expect(page.locator('main h1')).toBeVisible();
  });

  test(`${locale || 'en'}: blog search filters and clears articles`, async ({ page }) => {
    await page.goto(`${locale}/blog`);
    await expect(page.locator('article').first()).toBeVisible();
    await page.getByRole('searchbox').fill('e2e-no-match-7ac930');
    await expect(page.locator('article')).toHaveCount(0);
    await page.getByRole('searchbox').fill('');
    await expect(page.locator('article').first()).toBeVisible();
    const article = page.locator('article a[href*="/blog/"]').first();
    const href = await article.getAttribute('href');
    expect(href).toMatch(/\/blog\/.+/);
    await article.click();
    await expect(page).toHaveURL(new RegExp(`${href}/?$`));
    await expect(page.locator('main h1')).toBeVisible();
  });

  for (const legalPage of [
    'privacy',
    'terms',
    'cookies',
    'security',
    'refund',
    'tokushoho',
    'oss-credits',
  ]) {
    test(`${locale || 'en'}: legal ${legalPage} opens from its direct public route`, async ({
      page,
    }) => {
      await page.goto(`${locale}/legal/${legalPage}`);
      await expect(page.locator('main h1')).toBeVisible();
      await expect(page.locator('main')).not.toContainText('404');
      await expect(page.locator('main')).not.toContainText('MISSING_MESSAGE');
    });
  }
}

test('search submits a query and opens a docs result', async ({ page }) => {
  await page.goto('/search');
  await page.locator('main input').fill('calendar');
  await page.locator('main input').press('Enter');
  await expect(page).toHaveURL(/\/search\?q=calendar/);
  const result = page.locator('main a[href*="/docs/"]').first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(page).toHaveURL(/\/docs\/.+/);
  await expect(page.locator('main h1')).toBeVisible();
});

test('contact rejects an empty form locally without sending mail', async ({ page }) => {
  // Protect the mail endpoint even if a future validation regression submits an empty form.
  let sent = false;
  await page.route('**/api/contact', async (route) => {
    sent = true;
    await route.fulfill({ status: 500, json: { error: 'E2E must not send real mail' } });
  });
  await page.goto('/contact');
  const submit = page.getByRole('button', { name: 'Send Message' });
  // Deployed Turnstile can require manual verification; report that prerequisite instead of skip.
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.locator('#name-error')).toContainText('Please enter your name');
  await expect(page.locator('#email-error')).toContainText('Please enter a valid email address');
  await expect(page.locator('#message-error')).toContainText('at least 10 characters');
  expect(sent).toBe(false);
});
