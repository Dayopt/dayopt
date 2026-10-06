import { expect, test } from './public-test';

for (const locale of ['', '/ja']) {
  test(`${locale || 'en'} search keeps locale through submit, filters and clearing`, async ({
    page,
  }) => {
    const ja = locale === '/ja';
    let releaseScripts!: () => void;
    const scriptsReady = new Promise<void>((resolve) => {
      releaseScripts = resolve;
    });
    let heldScripts = 0;
    await page.route('**/_next/static/**/*.js', async (route) => {
      heldScripts += 1;
      await scriptsReady;
      await route.fallback();
    });
    try {
      await page.goto(`${locale}/search`, { waitUntil: 'commit' });
      await expect(page.locator('main input')).toBeVisible();
      expect(heldScripts).toBeGreaterThan(0);
      expect(await page.locator('main input').isEnabled()).toBe(false);
      expect(
        await page.getByRole('button', { name: ja ? '検索' : 'Search', exact: true }).isEnabled(),
      ).toBe(false);
      releaseScripts();
      await expect(page.locator('main input')).toBeEnabled();
      await page.locator('main input').fill('zzqvxxjjgkbadf');
      await page.locator('main input').press('Enter');
      await expect(page).toHaveURL(new RegExp(`${locale}/search\\?q=zzqvxxjjgkbadf$`));
      await expect(page.locator('main')).toContainText(
        ja ? '検索結果が見つかりませんでした' : 'No search results found',
      );
      await page.getByRole('button', { name: ja ? '検索をクリア' : 'Clear search' }).click();
      await expect(page).toHaveURL(new RegExp(`${locale}/search/?$`));
      await expect(page.locator('main')).toContainText(
        ja ? '検索を開始してください' : 'Start searching',
      );
      await page.locator('main input').fill('calendar');
      await page.locator('main input').press('Enter');
      await expect(page).toHaveURL(new RegExp(`${locale}/search\\?q=calendar$`));
      await expect(page.locator('main a[href*="/docs/"]').first()).toBeVisible();
      await page.getByRole('button', { name: ja ? /^ドキュメント \(/ : /^Docs \(/ }).click();
      await expect(page.locator('main')).toContainText(ja ? '最終更新:' : 'Last updated:');
      await expect(
        page.getByRole('link', { name: ja ? '詳細を見る →' : 'View details →' }).first(),
      ).toBeVisible();
    } finally {
      releaseScripts();
    }
  });
}
