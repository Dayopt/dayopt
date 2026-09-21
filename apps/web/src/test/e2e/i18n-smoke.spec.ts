import { dayoptProductUrls } from '@dayopt/config';
import { expect, test } from '@playwright/test';

test('footer の言語切替で locale prefix と hero copy が切り替わる', async ({ page }) => {
  await page.goto('/');

  const hero = page.getByRole('heading', { level: 1 });
  await expect(hero).toContainText('One day at a time,');

  await page.getByRole('button', { name: 'English - Change language' }).click();
  await page.getByRole('menuitemcheckbox', { name: '日本語' }).click();

  await expect(page).toHaveURL(/\/ja\/?$/);
  await expect(hero).toContainText('一日を重ねて、');

  await page.getByRole('button', { name: '日本語 - Change language' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'English' }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page).not.toHaveURL(/\/ja\/?$/);
  await expect(hero).toContainText('One day at a time,');
});

test('登録 CTA が product signup に統一されている', async ({ page }) => {
  expect(dayoptProductUrls.signup).toBe('https://app.dayopt.app/auth/signup');

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
  const title = 'One day at a time, closer to who you want to be.';
  const ogTitle = 'Dayopt';
  const description =
    "Your plans and records, together in one calendar. What you learn today makes tomorrow's plan a little better.";

  await page.goto('/');

  await expect(page).toHaveTitle(`${title} | Dayopt`);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', description);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', ogTitle);

  const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content');
  expect(ogImage).not.toBeNull();

  const ogUrl = new URL(ogImage as string);
  expect(ogUrl.pathname).toBe('/api/og');
  expect(ogUrl.searchParams.get('title')).toBe(ogTitle);
  expect(ogUrl.searchParams.get('description')).toBe(description);

  const response = await page.request.get(`/api/og?${ogUrl.searchParams.toString()}`);
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toContain('image/png');
});

test('LP の en/ja × desktop/mobile を表示できる', async ({ page }, testInfo) => {
  const patterns = [
    {
      name: 'en-desktop',
      path: '/',
      headline: 'One day at a time,',
      width: 1440,
      height: 1000,
    },
    {
      name: 'ja-desktop',
      path: '/ja',
      headline: '一日を重ねて、',
      width: 1440,
      height: 1000,
    },
    {
      name: 'en-mobile',
      path: '/',
      headline: 'One day at a time,',
      width: 390,
      height: 844,
    },
    {
      name: 'ja-mobile',
      path: '/ja',
      headline: '一日を重ねて、',
      width: 390,
      height: 844,
    },
  ] as const;

  for (const pattern of patterns) {
    await page.context().clearCookies();
    await page.setViewportSize({ width: pattern.width, height: pattern.height });
    await page.goto(pattern.path);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(pattern.headline);
    await expect(page.locator('#pricing')).toBeVisible();
    // hero のスタガードフェードを打ち消す addStyleTag は不要になった
    // （2026-07-30 に hero のアニメーションを廃止したため）
    await testInfo.attach(`lp-${pattern.name}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  }
});

test('C案の表示例が操作に応じて変わる', async ({ page }) => {
  await page.goto('/ja');

  const calendar = page.locator('#calendar-preview');
  await calendar.getByRole('button', { name: /予定を立てる/ }).click();
  await expect(calendar.getByText('記録はこれから')).toBeVisible();
  await calendar.getByRole('button', { name: /明日へつなぐ/ }).click();
  await expect(calendar.getByText('前日の記録 45分')).toBeVisible();

  const template = page.locator('#learning');
  await template.getByRole('button', { name: /明日に並べてみる/ }).click();
  await expect(template.getByText('3つの予定を追加')).toBeVisible();
  await template.getByRole('button', { name: /操作例をリセット/ }).click();
  await expect(template.getByText('予定を並べる前')).toBeVisible();
});

test('LPの案内は既存のBlog・Docs・登録先につながり、現行料金を示す', async ({ page }) => {
  await page.goto('/ja');

  await expect(page.locator('#pricing')).toContainText('Free');
  await expect(page.locator('#pricing')).toContainText('Pro');
  await expect(page.locator('#pricing')).toContainText('7日間');
  await expect(page.locator('#pricing')).not.toContainText('45日');
  await expect(page.getByRole('link', { name: 'はじめての使い方を読む' })).toHaveAttribute(
    'href',
    '/ja/docs/getting-started',
  );
  await expect(page.getByRole('link', { name: 'ブログ' }).first()).toHaveAttribute(
    'href',
    '/ja/blog',
  );
  await expect(page.getByRole('link', { name: 'ドキュメント' }).first()).toHaveAttribute(
    'href',
    '/ja/docs',
  );
  await expect(page.getByRole('link', { name: /Dayoptをはじめる/ }).first()).toHaveAttribute(
    'href',
    dayoptProductUrls.signup,
  );
});

test('小さい画面でもLP本文に横スクロールがない', async ({ page }) => {
  for (const locale of ['/', '/ja']) {
    for (const width of [320, 375, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(locale);
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(width);
    }
  }
});

test('ダークモードと動きを減らす設定でもHeroの物語を読める', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/ja');

  await expect(page.getByRole('heading', { level: 1 })).toContainText('なりたい自分へ。');
  await expect(page.getByText('思ったより、夢中に。')).toBeVisible();
  await expect(page.getByText('読み終えた。')).toBeVisible();

  const background = await page
    .locator('body')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe('rgb(255, 255, 255)');
});

test('連携セクションはライト・ダークそれぞれの明度階層に沿う', async ({ page }) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto('/ja');

    const colors = await page.locator('#integrations').evaluate((section) => ({
      pageBackground: getComputedStyle(document.body).backgroundColor,
      pageForeground: getComputedStyle(document.body).color,
      sectionBackground: getComputedStyle(section).backgroundColor,
      sectionForeground: getComputedStyle(section).color,
    }));

    expect(colors.sectionBackground).not.toBe(colors.pageForeground);
    expect(colors.sectionForeground).not.toBe(colors.pageBackground);
  }
});

test('セクションの階層を外周ボーダーに頼らず表現する', async ({ page }) => {
  await page.goto('/ja');

  for (const selector of [
    '#calendar-preview',
    '#activities',
    '#learning',
    '#review',
    '#integrations',
    '#pricing',
    '#faq',
    '#next-day',
  ]) {
    await expect(page.locator(selector)).toHaveCSS('border-top-width', '0px');
  }
});
