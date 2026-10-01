import { expect, test } from '@playwright/test';

test('スマホのDocs目次から日本語の予定ガイドへ移動できる', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/ja/docs');
  const contents = page.locator('[data-docs-mobile-navigation]');
  await contents.locator('summary').click();
  await contents.getByRole('link', { name: '予定を立てる', exact: true }).click();
  await expect(page).toHaveURL(/\/ja\/docs\/plans$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('予定');
  const nextPage = page.locator('main').getByRole('link', { name: /次.*カレンダー/ });
  await expect(nextPage).toHaveAttribute('href', '/ja/docs/calendar');
  await nextPage.click();
  await expect(page).toHaveURL(/\/ja\/docs\/calendar$/);
});

test('日本語Docsのサイドバーは言語を保ったまま移動する', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/ja/docs');
  await expect(
    page.locator('aside').getByRole('link', { name: '予定を立てる', exact: true }),
  ).toHaveAttribute('href', '/ja/docs/plans');
  await page
    .locator('aside')
    .filter({ has: page.getByRole('link', { name: '予定を立てる', exact: true }) })
    .getByRole('link', { name: '予定を立てる', exact: true })
    .click();
  await expect(page).toHaveURL(/\/ja\/docs\/plans$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
});

test('Blog検索は結果を絞り込み、クリア後に記事を戻す', async ({ page }) => {
  await page.goto('/ja/blog');
  const articles = page.locator('main article');
  await expect(articles).not.toHaveCount(0);
  const search = page.getByPlaceholder('タイトル、内容、タグで検索...');
  await search.fill('zz-no-dayopt-result');
  await expect(articles).toHaveCount(0);
  await expect(page.getByText('記事が見つかりませんでした')).toBeVisible();
  await search.fill('');
  await expect(articles).not.toHaveCount(0);
  const firstTitle = await articles.first().locator('h2').textContent();
  await page.getByRole('link', { name: '次へ', exact: true }).click();
  await expect(page).toHaveURL(/\/ja\/blog\?page=2$/);
  await expect(articles.first().locator('h2')).not.toHaveText(firstTitle!);
  await page.getByRole('link', { name: '前へ', exact: true }).click();
  await expect(articles.first().locator('h2')).toHaveText(firstTitle!);
  await page.getByRole('link', { name: '設計思想', exact: true }).click();
  await expect(page).toHaveURL(/\/ja\/blog\/philosophy$/);
  await expect(page.locator('main nav a[aria-current="page"]')).toHaveText('設計思想');
});

test('実際の横断検索APIから予定ガイドを開ける', async ({ page }) => {
  await page.goto('/search');
  await page.getByLabel('Keywords', { exact: true }).fill('plans');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const guide = page.locator('main').getByRole('link', { name: 'Create Plans', exact: true });
  await expect(guide).toBeVisible();
  await guide.click();
  await expect(page).toHaveURL(/\/docs\/plans$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create Plans');
});

test('日本語の横断検索と対象切替は操作後の結果を表示する', async ({ page }) => {
  await page.route('**/api/search?**', async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('locale')).toBe('ja');
    await route.fulfill({
      json: {
        results: [
          {
            id: 'plan-guide',
            title: '予定のガイド',
            description: '予定を立てる方法',
            url: '/ja/docs/plans',
            type: 'docs',
            breadcrumbs: [],
            lastModified: '2026-10-02',
          },
          {
            id: 'time-story',
            title: '予定を考える記事',
            description: '予定と時間の話',
            url: '/ja/blog/timeboxing-guide',
            type: 'blog',
            breadcrumbs: [],
            lastModified: '2026-10-02',
          },
        ],
      },
    });
  });
  await page.goto('/ja/search');
  await expect(page.getByRole('link', { name: '予定のガイド' })).toHaveCount(0);
  await page.getByLabel('キーワード', { exact: true }).fill('予定');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect(page).toHaveURL(/\/ja\/search\?q=/);
  await expect(page.getByRole('link', { name: '予定のガイド' })).toBeVisible();
  await expect(page.getByRole('link', { name: '予定を考える記事' })).toBeVisible();
  await page.getByRole('button', { name: /ドキュメント 1/ }).click();
  await expect(page.getByRole('link', { name: '予定を考える記事' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '予定のガイド' })).toBeVisible();
});

test('検索エラーは結果ゼロと区別して案内する', async ({ page }) => {
  await page.route('**/api/search?**', (route) =>
    route.fulfill({ status: 503, json: { error: 'unavailable' } }),
  );
  await page.goto('/ja/search?q=plans');
  await expect(page.getByRole('heading', { name: '検索できませんでした' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '一致する結果がありません' })).toHaveCount(0);
  await expect(
    page.locator('main').getByRole('link', { name: 'ドキュメント', exact: true }),
  ).toHaveAttribute('href', '/ja/docs');
});

test('記事の横長テーブルはキーボードで横へ読める', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/blog/timeboxing-guide');
  const table = page.locator('main div[tabindex="0"]').filter({ has: page.locator('table') });
  const overflowingTable = table.filter({
    has: page.getByRole('cell', { name: 'Morning planning', exact: true }),
  });
  await overflowingTable.scrollIntoViewIfNeeded();
  await overflowingTable.focus();
  await expect(overflowingTable).toBeFocused();
  const before = await overflowingTable.evaluate((element) => element.scrollLeft);
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(() => overflowingTable.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(before);
});

test('未知のガイドは404を返し、ホームへ戻れる', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const response = await page.goto('/ja/docs/missing-dayopt-guide');
  expect(response?.status()).toBe(404);
  // dynamicParams=false の未知 slug は locale boundary より前に global 404 へ送られる。
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to home', exact: true }).click();
  await expect(page).toHaveURL(/\/ja$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
});

test('JavaScript無効でもモバイルのガイドとBlogの登録導線が成立する', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
    storageState: process.env.WEB_E2E_STORAGE_STATE,
  });
  const page = await context.newPage();
  const base = testInfo.project.use.baseURL;
  await page.goto(`${base}/ja/docs`);
  await page.locator('[data-docs-mobile-navigation] summary').click();
  await expect(
    page
      .locator('[data-docs-mobile-navigation]')
      .getByRole('link', { name: '予定を立てる', exact: true }),
  ).toBeVisible();
  await page.goto(`${base}/ja/blog`);
  await expect(page.locator('main article')).not.toHaveCount(0);
  await expect(page.getByRole('link', { name: '新規登録', exact: true })).toHaveAttribute(
    'href',
    'https://app.dayopt.app/auth/signup',
  );
  await context.close();
});
