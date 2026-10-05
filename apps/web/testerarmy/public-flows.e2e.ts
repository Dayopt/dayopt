import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.beforeEach(async ({ app }) => {
  await app.clearState();
});

for (const locale of ['', '/ja']) {
  const japanese = locale === '/ja';

  test(`${locale || 'en'}: landing demos create and reset visible plans`, async ({
    app,
    browser,
  }) => {
    await app.open(locale || '/');
    const calendar = browser.locator('#calendar-preview');
    await calendar.getByRole('button', japanese ? /予定を立てる/ : /Make a plan/).tap();
    await expect(calendar).toContainText(japanese ? '記録はこれから' : 'No record yet');
    await calendar.getByRole('button', japanese ? /明日へつなぐ/ : /Plan the next day/).tap();
    await expect(calendar).toContainText(
      japanese ? '前日の記録 45分' : "Yesterday's record: 45 min",
    );
    const learning = browser.locator('#learning');
    await learning.getByRole('button', japanese ? /明日に並べてみる/ : /Arrange tomorrow/).tap();
    await expect(learning).toContainText(japanese ? '3つの予定を追加' : 'Three plans added');
    await learning.getByRole('button', japanese ? /操作例をリセット/ : /Reset/).tap();
    await expect(learning).toContainText(japanese ? '予定を並べる前' : 'Before adding plans');
  });

  test(`${locale || 'en'}: docs navigation opens a getting-started article`, async ({
    app,
    browser,
  }) => {
    await app.open(locale || '/');
    await browser.locator(`a[href="${locale}/docs/getting-started"]`).first().tap();
    await expect(browser).toHaveURL(new RegExp(`${locale}/docs/?$`));
    await expect(browser.locator('main')).toContainText(
      japanese ? 'Dayoptとは' : 'What is Dayopt?',
    );
    const next = browser.locator('main a[href*="/docs/"]').first();
    await expect(next).toBeVisible();
    await next.tap();
    await expect(browser).toHaveURL(/\/docs\/.+/);
    await expect(browser.locator('main h1')).toBeVisible();
  });

  test(`${locale || 'en'}: blog search filters and clears articles`, async ({
    app,
    browser,
    screen,
  }) => {
    await app.open(`${locale}/blog`);
    await expect(browser.locator('article').first()).toBeVisible();
    await screen.getByRole('searchbox').fill('testerarmy-no-match-7ac930');
    await expect(browser.locator('article')).toHaveCount(0);
    await screen.getByRole('searchbox').fill('');
    await expect(browser.locator('article').first()).toBeVisible();
    const article = browser.locator('article a[href*="/blog/"]').first();
    const href = await article.getAttribute('href');
    expect(href).toMatch(/\/blog\/.+/);
    await article.tap();
    await expect(browser).toHaveURL(new RegExp(`${href}/?$`));
    await expect(browser.locator('main h1')).toBeVisible();
  });

  for (const page of [
    'privacy',
    'terms',
    'cookies',
    'security',
    'refund',
    'tokushoho',
    'oss-credits',
  ]) {
    test(`${locale || 'en'}: legal ${page} opens from its direct public route`, async ({
      app,
      browser,
    }) => {
      await app.open(`${locale}/legal/${page}`);
      await expect(browser.locator('main h1')).toBeVisible();
      await expect(browser.locator('main')).not.toContainText('404');
      await expect(browser.locator('main')).not.toContainText('MISSING_MESSAGE');
    });
  }
}

test('language menu switches English to Japanese and back', async ({ app, screen, browser }) => {
  await app.open('/');
  await screen.getByRole('button', 'Necessary only').tap();
  await screen.getByRole('button', 'English - Change language').tap();
  await screen.getByRole('menuitemcheckbox', '日本語').tap();
  await expect(browser).toHaveURL(/\/ja\/?$/);
  await expect(screen.getByRole('heading').first()).toContainText('一日を重ねて、');
  await screen.getByRole('button', '日本語 - Change language').tap();
  await screen.getByRole('menuitemcheckbox', 'English').tap();
  await expect(browser).toHaveURL(/\/$/);
  await expect(screen.getByRole('heading').first()).toContainText('One day at a time,');
});

test('cookie settings permit and revoke analytics, persisting across reload', async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/');
  await screen.getByRole('button', 'Necessary only').tap();
  await screen.getByRole('button', 'Cookie settings').tap();
  await screen.getByRole('button', 'Allow analytics').tap();
  await browser.reload();
  await screen.getByRole('button', 'Cookie settings').tap();
  await expect(screen.getByRole('region', 'Change your cookie choice')).toContainText(
    'Analytics is currently allowed.',
  );
  await screen.getByRole('button', 'Necessary only').tap();
  await screen.getByRole('button', 'Refuse and reload').tap();
  await screen.getByRole('button', 'Cookie settings').tap();
  await expect(screen.getByRole('region', 'Change your cookie choice')).toContainText(
    'Analytics is currently refused.',
  );
});

test('search submits a query and opens a docs result', async ({ app, browser }) => {
  await app.open('/search');
  await browser.locator('main input').fill('calendar');
  await browser.locator('main input').press('Enter');
  await expect(browser).toHaveURL(/\/search\?q=calendar/);
  const result = browser.locator('main a[href*="/docs/"]').first();
  await expect(result).toBeVisible();
  await result.tap();
  await expect(browser).toHaveURL(/\/docs\/.+/);
  await expect(browser.locator('main h1')).toBeVisible();
});

test('contact rejects an empty form locally without sending mail', async ({
  app,
  browser,
  screen,
}) => {
  // Protect the mail endpoint even if a future validation regression submits an empty form.
  let sent = false;
  await browser.route('**/api/contact', async (route) => {
    sent = true;
    await route.fulfill({ status: 500, json: { error: 'E2E must not send real mail' } });
  });
  await app.open('/contact');
  const submit = screen.getByRole('button', 'Send Message');
  // Deployed Turnstile can require manual verification; report that prerequisite instead of skip.
  await expect(submit).toBeEnabled();
  await submit.tap();
  await expect(browser.locator('#name-error')).toContainText('Please enter your name');
  await expect(browser.locator('#email-error')).toContainText('Please enter a valid email address');
  await expect(browser.locator('#message-error')).toContainText('at least 10 characters');
  expect(sent).toBe(false);
});
