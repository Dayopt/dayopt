import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.beforeEach(async ({ app }) => {
  await app.clearState();
});

test('theme menu changes dark and light appearance and persists on reload', async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/');
  await screen.getByRole('button', 'Necessary only').tap();
  await screen.getByRole('button', 'Change theme').tap();
  await screen.getByRole('menuitemcheckbox', 'Dark').tap();
  await expect(browser.locator('html')).toHaveAttribute('class', /dark/);
  await browser.reload();
  await expect(browser.locator('html')).toHaveAttribute('class', /dark/);
  await screen.getByRole('button', 'Change theme').tap();
  await screen.getByRole('menuitemcheckbox', 'Light').tap();
  await expect(browser.locator('html')).not.toHaveAttribute('class', /dark/);
});

test('header navigation opens blog through mobile drawer or desktop link', async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/');
  const mobile = await browser.evaluate(() => innerWidth < 1024);
  if (mobile) {
    await screen.getByRole('button', 'Open menu').tap();
    await expect(screen.getByRole('dialog', 'Navigation menu')).toBeVisible();
    await screen.getByRole('dialog', 'Navigation menu').getByRole('link', 'Blog').tap();
    await expect(screen.getByRole('dialog', 'Navigation menu')).not.toBeVisible();
  } else {
    await browser.locator('header').getByRole('link', 'Blog').tap();
  }
  await expect(browser).toHaveURL(/\/blog\/?$/);
  await expect(browser.locator('article').first()).toBeVisible();
});

test('FAQ disclosure exposes and collapses its answer', async ({ app, browser }) => {
  await app.open('/');
  const question = browser.locator('#faq details').first();
  await expect(question).not.toHaveAttribute('open', '');
  await browser.locator('#faq details summary').first().tap();
  await expect(question).toHaveAttribute('open', '');
  await expect(browser.locator('#faq details p').first()).toBeVisible();
  await browser.locator('#faq details summary').first().tap();
  await expect(question).not.toHaveAttribute('open', '');
});

for (const category of ['guide', 'philosophy', 'release', 'devlog']) {
  test(`blog category ${category} activates its tab and returns to all articles`, async ({
    app,
    browser,
  }) => {
    await app.open('/blog');
    await browser.locator(`main nav[aria-label="Blog"] a[href="/blog/${category}"]`).tap();
    await expect(browser).toHaveURL(new RegExp(`/blog/${category}/?$`));
    await expect(
      browser.locator(`main nav[aria-label="Blog"] a[href="/blog/${category}"]`),
    ).toHaveAttribute('aria-current', 'page');
    await browser.locator('main nav a[href="/blog"]').tap();
    await expect(browser).toHaveURL(/\/blog\/?$/);
    await expect(browser.locator('article').first()).toBeVisible();
  });
}

test('docs keyboard search submits to site search and returns a result', async ({
  app,
  browser,
  screen,
}) => {
  await app.open('/docs');
  await expect(screen.getByRole('button', 'English - Change language')).toBeEnabled();
  await browser.keyboard.press('Meta+k');
  await expect(screen.getByRole('dialog')).toBeVisible();
  await screen.getByRole('dialog').getByRole('textbox').fill('calendar');
  await screen.getByRole('dialog').getByRole('textbox').press('Enter');
  await expect(browser).toHaveURL(/\/search\?q=calendar/);
  await expect(browser.locator('main a[href*="/docs/"]').first()).toBeVisible();
});

test('blog pagination changes articles and filtering from page two finds the first article', async ({
  app,
  browser,
  screen,
}) => {
  await app.open('/blog');
  const firstTitle = await browser.locator('article h2').first().textContent();
  expect(firstTitle).toBeTruthy();
  await browser.locator('main a[href="/blog?page=2"]').first().tap();
  await expect(browser).toHaveURL(/\/blog\?page=2/);
  await expect(browser.locator('article h2').first()).not.toHaveText(firstTitle!);
  await screen.getByRole('searchbox').fill(firstTitle!);
  await expect(browser.locator('article h2').first()).toHaveText(firstTitle!);
});
