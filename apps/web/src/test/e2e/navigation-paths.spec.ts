import { expect, test } from '@playwright/test';

for (const locale of ['', '/ja']) {
  const ja = locale === '/ja';
  test(`${locale || 'en'} landing content links resolve to available public pages`, async ({
    page,
  }) => {
    await page.goto(locale || '/');
    const paths = await page
      .locator('main a[href]')
      .evaluateAll((links) => [
        ...new Set(
          links
            .map((link) => link.getAttribute('href')!)
            .filter((href) => href.startsWith('/') && !href.startsWith('//')),
        ),
      ]);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const response = await page.request.get(path);
      expect(response.ok(), path).toBe(true);
      expect(new URL(response.url()).pathname.startsWith(locale + '/'), path).toBe(true);
    }
  });

  test(`${locale || 'en'} cookie policy link preserves locale before choosing consent`, async ({
    page,
  }) => {
    await page.goto(locale || '/');
    await page.locator('aside a[href$="/legal/cookies"]').click();
    await expect(page).toHaveURL(new RegExp(`${locale}/legal/cookies/?$`));
    await expect(page.locator('main h1')).toBeVisible();
    await page.locator('aside').getByRole('button').first().click();
    await expect(page.locator('#cookie-consent-title')).not.toBeVisible();
  });

  test(`${locale || 'en'} search blog filter, all filter and browser history expose the right results`, async ({
    page,
  }) => {
    await page.goto(`${locale}/search?q=calendar`);
    const docs = page.locator('main a[href*="/docs/"]');
    const blog = page.locator('main a[href*="/blog/"]');
    await expect(docs.first()).toBeVisible();
    await page.getByRole('button', { name: ja ? /^ブログ \(/ : /^Blog \(/ }).click();
    await expect(docs).toHaveCount(0);
    await expect(blog.first()).toBeVisible();
    await page.getByRole('button', { name: ja ? /^すべて \(/ : /^All \(/ }).click();
    await expect(docs.first()).toBeVisible();
    await page.locator('main input').fill('zzqvxxjjgkbadf');
    await page.locator('main input').press('Enter');
    await expect(page).toHaveURL(/q=zzqvxxjjgkbadf$/);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${locale}/search\\?q=calendar$`));
    await expect(page.locator('main input')).toHaveValue('calendar');
    await expect(docs.first()).toBeVisible();
  });

  test(`${locale || 'en'} theme system choice follows device appearance and keeps localized controls`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(locale || '/');
    await page.locator('aside').getByRole('button').first().click();
    const trigger = page.getByRole('button', { name: ja ? 'テーマを変更' : 'Change theme' });
    await trigger.click();
    await page.getByRole('menuitemcheckbox', { name: ja ? 'ダーク' : 'Dark', exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await trigger.click();
    await page
      .getByRole('menuitemcheckbox', { name: ja ? 'システム' : 'System', exact: true })
      .click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
  });
}
