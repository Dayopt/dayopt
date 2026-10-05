import { expect, test } from '@playwright/test';

for (const locale of ['', '/ja']) {
  test(`${locale || 'en'} search keeps locale through submit, filters and clearing`, async ({
    page,
  }) => {
    const ja = locale === '/ja';
    await page.goto(`${locale}/search`);
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
  });
}
