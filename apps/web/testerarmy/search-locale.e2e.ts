import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.beforeEach(async ({ app }) => {
  await app.clearState();
});

for (const locale of ['', '/ja']) {
  test(`${locale || 'en'} search keeps locale through submit, filters and clearing`, async ({
    app,
    browser,
    screen,
  }) => {
    const ja = locale === '/ja';
    await app.open(`${locale}/search`);
    await browser.locator('main input').fill('zzqvxxjjgkbadf');
    await browser.locator('main input').press('Enter');
    await expect(browser).toHaveURL(new RegExp(`${locale}/search\\?q=zzqvxxjjgkbadf$`));
    await expect(browser.locator('main')).toContainText(
      ja ? '検索結果が見つかりませんでした' : 'No search results found',
    );
    await screen.getByRole('button', ja ? '検索をクリア' : 'Clear search').tap();
    await expect(browser).toHaveURL(new RegExp(`${locale}/search/?$`));
    await expect(browser.locator('main')).toContainText(
      ja ? '検索を開始してください' : 'Start searching',
    );
    await browser.locator('main input').fill('calendar');
    await browser.locator('main input').press('Enter');
    await expect(browser).toHaveURL(new RegExp(`${locale}/search\\?q=calendar$`));
    await expect(browser.locator('main a[href*="/docs/"]').first()).toBeVisible();
    await screen.getByRole('button', ja ? /^ドキュメント \(/ : /^Docs \(/).tap();
    await expect(browser.locator('main')).toContainText(ja ? '最終更新:' : 'Last updated:');
    await expect(
      screen.getByRole('link', ja ? '詳細を見る →' : 'View details →').first(),
    ).toBeVisible();
  });
}
